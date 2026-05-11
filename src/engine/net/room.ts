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
import type { ServerControlMessage } from './protocol'
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
  /** Called when the server assigns us our slot. */
  onConnected?: (myPeerId: number, otherPeers: readonly number[]) => void
  /** Called when the server reports the room is full. */
  onRoomFull?: () => void
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
          for (const p of msg.otherPeers) remotePeers.add(p)
          cfg.onConnected?.(msg.peerId, [...remotePeers])
          break
        case 'peer-joined':
          remotePeers.add(msg.peerId)
          cfg.onPeerJoined?.(msg.peerId)
          break
        case 'peer-left':
          remotePeers.delete(msg.peerId)
          // Drop the departed peer's buffered intent so a future room
          // member assigned the same slot doesn't inherit stale controls.
          latestPeerIntents.delete(msg.peerId)
          cfg.onPeerLeft?.(msg.peerId)
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
    get snapshotsReceived() {
      return snapshotsReceived
    },
    close() {
      socket.close()
    },
  }
}
