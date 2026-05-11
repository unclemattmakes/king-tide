/**
 * M10.4 — client side of the PartyKit relay.
 *
 * Wraps `partysocket`'s reconnecting WebSocket with the two-tier protocol
 * (binary InputFrames + JSON control messages) and surfaces:
 *  - the local peer's assigned slot, once the server's hello arrives
 *  - a callback for remote InputFrames
 *  - peer presence (join/leave events)
 *  - a `sendFrame(frame)` method that no-ops until the connection is ready
 *
 * Designed so single-player code paths don't care this exists — the room
 * is only constructed when `?room=<id>` is present on the URL.
 *
 * @see party/relay.ts — server
 * @see ./protocol.ts — control-message shapes
 * @see ./input-frame.ts — binary frame codec
 */
import PartySocket from 'partysocket'

import type { Intent } from '../input/intent'
import {
  decodeInputFrameFrom,
  encodeInputFrame,
  INPUT_FRAME_WIRE_BYTES,
  type InputFrame,
} from './input-frame'
import type { ClientControlMessage, ServerControlMessage } from './protocol'
import {
  decodeTransformSnapshotFrom,
  MESSAGE_TAG_INPUT_FRAME,
  MESSAGE_TAG_TRANSFORM_SNAPSHOT,
  type TransformSnapshot,
} from './transform-snapshot'

export type NetRoomConfig = {
  /** PartyKit host. In dev: 'localhost:1999'. In prod: 'hoverbike.occ-matt.partykit.dev'. */
  host: string
  /** Room identifier. All peers in the same room id see each other's frames. */
  roomId: string
  /** Called when a remote peer's InputFrame arrives. */
  onRemoteFrame?: (frame: InputFrame) => void
  /** Called when a remote peer's TransformSnapshot arrives (M10.11). The
   *  snapshot's senderPeerId is guaranteed != our slot (server doesn't
   *  echo back; defensive filter below also drops self-echoes). */
  onSnapshot?: (snapshot: TransformSnapshot) => void
  /** Called when another peer joins the room (after we did). */
  onPeerJoined?: (peerId: number) => void
  /** Called when another peer leaves. */
  onPeerLeft?: (peerId: number) => void
  /** Called when the server assigns us our slot. `raceStarted` is true
   *  iff we're joining a room whose race has already begun (M10.12);
   *  the caller arms the countdown immediately to skip the lobby. */
  onConnected?: (myPeerId: number, otherPeers: readonly number[], raceStarted: boolean) => void
  /** Called when the server reports the room is full. */
  onRoomFull?: () => void
  /** M10.12 lobby — called when any remote peer toggles their ready
   *  state. Local toggles are NOT echoed; `latestPeerReady` is updated
   *  locally on `sendReady` to keep the source of truth in one map. */
  onPeerReady?: (peerId: number, ready: boolean) => void
  /** M10.12 lobby — called when the server broadcasts that the race
   *  has started (some peer's local view found everyone ready and
   *  signalled `start-race`). Idempotent on the caller side — receiving
   *  this is the cue to arm the countdown if not already armed. */
  onStartRace?: () => void
}

export type NetRoom = {
  /** Our peer slot, or -1 before the server's hello message arrives. */
  readonly peerId: number
  /** True once we have a slot and the socket is OPEN. Frames sent before
   *  this point are silently dropped — `simulateStep` keeps stepping
   *  locally so the loop never blocks on the network. */
  readonly ready: boolean
  /** Slots currently held by remote peers. Live — mutated on join/leave. */
  readonly remotePeers: readonly number[]
  sendFrame(frame: InputFrame): void
  /**
   * Latest-known `Intent` per remote peer slot, mutated each time a remote
   * frame arrives. Sim loop drains this into the per-tick peer-input map
   * passed to `simulateStep`. This is a "last-write-wins" buffer — no tick
   * ordering or jitter buffering yet; that's a later slice. The local
   * peer is NOT included (callers always know their own intent firsthand).
   */
  readonly latestPeerIntents: ReadonlyMap<number, Intent>
  /** Send a pre-encoded binary payload (e.g. a TransformSnapshot). Caller
   *  owns the buffer's bytes; this method copies into its own send slot.
   *  No-ops until ready, same as `sendFrame`. */
  sendBinary(buf: Uint8Array): void
  /** Total snapshots received since connect. Useful as an e2e wait signal
   *  ("wait until tab 2 has applied at least one snapshot from tab 1"). */
  readonly snapshotsReceived: number
  /** M10.12 lobby — broadcast our ready state. Updates `latestPeerReady`
   *  locally too so the caller doesn't need a second source of truth.
   *  No-ops until ready (frames are dropped, but we still update local
   *  state so the lobby UI behaves correctly during the brief
   *  pre-connect window). */
  sendReady(ready: boolean): void
  /** M10.12 lobby — broadcast that all peers (per our local view) are
   *  ready and the race should begin. Server sets the sticky
   *  `raceStarted` bit so late joiners skip the lobby. Idempotent. */
  sendStartRace(): void
  /** Live ready-state per peer slot, including the local peer (keyed by
   *  `peerId`). Pre-connect: empty. On disconnect: cleared. Cleared
   *  entries for departed peers prevent a stale "ready" from a previous
   *  occupant of a recycled slot. */
  readonly latestPeerReady: ReadonlyMap<number, boolean>
  close(): void
}

/**
 * Hand-coded WebSocket layout matcher for control messages. We don't pull
 * in a schema validator at the client — the payloads are tiny and the
 * server-side type is the single source of truth. Anything we don't
 * recognise is logged and dropped.
 */
function parseControl(text: string): ServerControlMessage | null {
  try {
    const obj = JSON.parse(text)
    if (obj && typeof obj === 'object' && typeof obj.type === 'string') {
      return obj as ServerControlMessage
    }
  } catch {
    // fall through
  }
  return null
}

export function createNetRoom(cfg: NetRoomConfig): NetRoom {
  // Reusable encode buffer — one alloc instead of N/tick. Note we DON'T
  // share the buffer with main.ts's sim-loop view; that one is decoded
  // back into an Intent the moment after it's written, so it's free
  // again. This one is held for the duration of the send().
  const sendBuf = new Uint8Array(INPUT_FRAME_WIRE_BYTES)

  let myPeerId = -1
  let socketOpen = false
  let snapshotsReceived = 0
  const remotePeers = new Set<number>()
  // M10.12 lobby — peer slot → ready boolean. Includes self once
  // sendReady is called. New peers are added with `false` on
  // peer-joined / hello; cleared on peer-left + on disconnect.
  const latestPeerReady = new Map<number, boolean>()
  // Last-write-wins intent buffer per remote peer slot. Sized at most
  // MAX_PEERS_PER_ROOM - 1 entries. Cleared on disconnect; entries
  // pruned on peer-left.
  const latestPeerIntents = new Map<number, Intent>()

  const socket = new PartySocket({
    host: cfg.host,
    room: cfg.roomId,
  })
  socket.binaryType = 'arraybuffer'

  socket.addEventListener('open', () => {
    socketOpen = true
  })
  socket.addEventListener('close', () => {
    socketOpen = false
    myPeerId = -1
    remotePeers.clear()
    latestPeerIntents.clear()
    latestPeerReady.clear()
    snapshotsReceived = 0
  })

  socket.addEventListener('message', (event: MessageEvent) => {
    const data = event.data
    if (typeof data === 'string') {
      const msg = parseControl(data)
      if (!msg) return
      switch (msg.type) {
        case 'hello':
          myPeerId = msg.peerId
          remotePeers.clear()
          latestPeerReady.clear()
          // Seed every visible slot (us + others) as not-ready. Local
          // ready state is overwritten the first time `sendReady` is
          // called.
          latestPeerReady.set(msg.peerId, false)
          for (const p of msg.otherPeers) {
            remotePeers.add(p)
            latestPeerReady.set(p, false)
          }
          cfg.onConnected?.(msg.peerId, [...remotePeers], msg.raceStarted)
          if (msg.raceStarted) cfg.onStartRace?.()
          break
        case 'peer-joined':
          remotePeers.add(msg.peerId)
          latestPeerReady.set(msg.peerId, false)
          cfg.onPeerJoined?.(msg.peerId)
          break
        case 'peer-left':
          remotePeers.delete(msg.peerId)
          // Drop the departed peer's buffered intent so a future room
          // member assigned the same slot doesn't inherit stale controls.
          latestPeerIntents.delete(msg.peerId)
          latestPeerReady.delete(msg.peerId)
          cfg.onPeerLeft?.(msg.peerId)
          break
        case 'ready':
          // Defensive: drop self-echoes (server shouldn't send these,
          // but the local sendReady path already updates our own slot
          // so a duplicate is harmless either way).
          if (msg.peerId !== myPeerId) {
            latestPeerReady.set(msg.peerId, msg.ready)
            cfg.onPeerReady?.(msg.peerId, msg.ready)
          }
          break
        case 'start-race':
          cfg.onStartRace?.()
          break
        case 'room-full':
          cfg.onRoomFull?.()
          break
      }
      return
    }
    if (data instanceof ArrayBuffer) {
      // M10.11 — two binary message types share this socket, distinguished
      // by a 1-byte tag at offset 0. Cheaper than length-based dispatch
      // and explicit so future types (snapshot ACKs, event broadcasts,
      // etc.) can land here without ambiguity.
      if (data.byteLength < 1) return
      const view = new DataView(data)
      const tag = view.getUint8(0)
      if (tag === MESSAGE_TAG_INPUT_FRAME) {
        const frame = decodeInputFrameFrom(view, 0)
        // Defensive: a misconfigured peer could send a frame stamped with
        // our own slot. Ignore those — we always trust our local input.
        if (frame.peerId !== myPeerId) {
          latestPeerIntents.set(frame.peerId, frame.intent)
        }
        cfg.onRemoteFrame?.(frame)
        return
      }
      if (tag === MESSAGE_TAG_TRANSFORM_SNAPSHOT) {
        const snap = decodeTransformSnapshotFrom(view, 0, data.byteLength)
        // Same defensive guard as for InputFrames: drop self-echoes.
        if (snap.senderPeerId !== myPeerId) {
          snapshotsReceived++
          cfg.onSnapshot?.(snap)
        }
        return
      }
      // Unknown tag — log once at console level and drop. Don't crash the
      // socket on a forwards-compat message we don't recognise.
      console.warn(`[net] unknown binary tag 0x${tag.toString(16)} (${data.byteLength}B), dropping`)
    }
  })

  function ready(): boolean {
    return socketOpen && myPeerId >= 0
  }

  return {
    get peerId() {
      return myPeerId
    },
    get ready() {
      return ready()
    },
    get remotePeers() {
      return [...remotePeers]
    },
    get latestPeerIntents() {
      return latestPeerIntents
    },
    sendFrame(frame: InputFrame) {
      if (!ready()) return
      const encoded = encodeInputFrame(frame)
      sendBuf.set(encoded)
      // partysocket's send accepts ArrayBuffer/Uint8Array directly.
      socket.send(sendBuf)
    },
    sendBinary(buf: Uint8Array) {
      if (!ready()) return
      // Slice into a fresh ArrayBuffer of exactly the right size.
      // partysocket's typing requires ArrayBuffer (not SharedArrayBuffer)
      // backing, and the caller is allowed to reuse `buf` immediately
      // after this returns — so we own a copy regardless.
      const copy = buf.slice(0).buffer
      socket.send(copy)
    },
    sendReady(ready: boolean) {
      // Always update local state (the lobby UI reads from this map),
      // even if the socket isn't ready — we'll re-broadcast on connect
      // if the local state diverged in the meantime.
      if (myPeerId >= 0) latestPeerReady.set(myPeerId, ready)
      if (!socketOpen || myPeerId < 0) return
      const msg: ClientControlMessage = { type: 'ready', ready }
      socket.send(JSON.stringify(msg))
    },
    sendStartRace() {
      if (!socketOpen || myPeerId < 0) return
      const msg: ClientControlMessage = { type: 'start-race' }
      socket.send(JSON.stringify(msg))
    },
    get latestPeerReady() {
      return latestPeerReady
    },
    get snapshotsReceived() {
      return snapshotsReceived
    },
    close() {
      socket.close()
    },
  }
}
