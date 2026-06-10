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
import { isHostSeat, type PeerSeat } from './host-election'
import {
  decodeInputFrameFrom,
  encodeInputFrame,
  INPUT_FRAME_WIRE_BYTES,
  type InputFrame,
} from './input-frame'
import { createLatencyTracker } from './latency'
import { setMpStatus } from './mp-status'
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
  /** Called when a previously-established session drops (socket closed
   *  after we'd been assigned a slot) and partysocket is about to retry
   *  in the background. NOT fired for first-connect retries, nor after
   *  an explicit `close()`. The race owner uses this to degrade to solo
   *  cleanly: despawn remote bikes, re-stamp the local slot, resume
   *  local AI. On reconnect `onConnected` fires again with a fresh
   *  slot + peer set. */
  onDisconnected?: () => void
  /** M10.12 lobby — called when any remote peer toggles their ready
   *  state. Local toggles are NOT echoed; `latestPeerReady` is updated
   *  locally on `sendReady` to keep the source of truth in one map. The
   *  `picks` payload carries the latest bike + track selection that
   *  arrived with the ready toggle, so the lobby UI can paint per-slot
   *  loadout pills without an extra round-trip. */
  onPeerReady?: (peerId: number, ready: boolean, picks: PeerPicks) => void
  /** M10.12 lobby — called when the server broadcasts that the race
   *  has started (some peer's local view found everyone ready and
   *  signalled `start-race`). Idempotent on the caller side — receiving
   *  this is the cue to arm the countdown if not already armed. The
   *  optional `trackId` carries the agreed-upon track chosen by the
   *  caller (smash-bros-style random over picks); when absent, the
   *  receiver falls back to its current URL track. */
  onStartRace?: (trackId?: string) => void
}

/** Per-peer lobby-flow selections. Both fields are optional — clients
 *  may toggle ready before settling on picks. */
export type PeerPicks = {
  selectedBikeId?: string | undefined
  selectedTrackId?: string | undefined
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
  /** My election seat: slot + relay-stamped join tenure (joinSeq is
   *  undefined against a relay that predates the tenure protocol). */
  readonly mySeat: PeerSeat
  /** Election seats for every remote peer. Fresh array per read. */
  readonly remoteSeats: readonly PeerSeat[]
  /** Encode + send one InputFrame. Currently uncalled in-race — M10.11
   *  made remote bikes pose-driven, so the 60 Hz intent broadcast was
   *  removed as dead relay load. Retained (with the receive path) for
   *  M10.13's owner-authoritative combat events. */
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
  /** M10.12 lobby — broadcast our ready state plus the latest bike +
   *  track picks. Updates `latestPeerReady` + `latestPeerPicks` locally
   *  too so the caller doesn't need a second source of truth. No-ops on
   *  the socket until connected. */
  sendReady(ready: boolean, picks?: PeerPicks): void
  /** M10.12 lobby — broadcast that all peers (per our local view) are
   *  ready and the race should begin. Server sets the sticky
   *  `raceStarted` bit so late joiners skip the lobby. The optional
   *  `trackId` is the chosen track (e.g. smash-bros-style random pick
   *  across the lobby's votes); receivers reload into the race with
   *  that track. Idempotent. */
  sendStartRace(trackId?: string): void
  /** Live ready-state per peer slot, including the local peer (keyed by
   *  `peerId`). Pre-connect: empty. On disconnect: cleared. */
  readonly latestPeerReady: ReadonlyMap<number, boolean>
  /** Live per-slot picks (bike + track). Mirrors `latestPeerReady`'s
   *  lifecycle. Self-entries are written locally on `sendReady`. */
  readonly latestPeerPicks: ReadonlyMap<number, PeerPicks>
  /** Smoothed RTT in milliseconds, or -1 if no recent pong has landed.
   *  Updated on every pong (~1 Hz once `ready()`); stale-resets to -1
   *  if pongs stop arriving (see `LATENCY_STALE_MS`). */
  readonly latencyMs: number
  /** True once the socket has reached an OPEN state at least once.
   *  Used by the room HUD chip to distinguish a first-time connect from
   *  a reconnect attempt (partysocket retries on its own after a drop). */
  readonly everConnected: boolean
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
  let everConnected = false
  // Set by close() so the socket's async 'close' event doesn't overwrite
  // the published 'closed' state with 'connecting' (and doesn't fire
  // onDisconnected for a teardown the caller initiated).
  let explicitClose = false
  let snapshotsReceived = 0
  const remotePeers = new Set<number>()
  // Tenure protocol — relay-stamped join sequences (see protocol.ts).
  // Empty / undefined against an old relay; election falls back to slot
  // order inside isHostSeat.
  let myJoinSeq: number | undefined
  const remotePeerSeqs = new Map<number, number>()
  function mySeat(): PeerSeat {
    return { peerId: myPeerId, joinSeq: myJoinSeq }
  }
  function remoteSeats(): PeerSeat[] {
    return [...remotePeers].map((p) => ({ peerId: p, joinSeq: remotePeerSeqs.get(p) }))
  }
  const latency = createLatencyTracker()
  // 1 Hz ping cadence — fast enough that the readout updates within a
  // second when conditions change, slow enough that it's not a real
  // factor in the relay's per-room billing. The first ping fires
  // immediately once we have a slot so the readout populates without
  // an awkward "—" delay.
  const PING_INTERVAL_MS = 1000
  let pingTimer: ReturnType<typeof setInterval> | null = null

  /** Publish the current connection state to the mp-status pub/sub so
   *  the Settings → Network tab + lobby + HUD chip all refresh. Computes
   *  derived fields (`isHost`, `latencyMs`) from local state so callers
   *  can't accidentally publish a stale tuple. */
  function publishStatus(state: 'connecting' | 'reconnecting' | 'connected' | 'closed'): void {
    setMpStatus({
      state,
      roomId: cfg.roomId,
      host: cfg.host,
      peerId: myPeerId,
      remoteCount: remotePeers.size,
      latencyMs: latency.current(Date.now()),
      isHost: myPeerId >= 0 && isHostSeat(mySeat(), remoteSeats()),
    })
  }
  // M10.12 lobby — peer slot → ready boolean. Includes self once
  // sendReady is called. New peers are added with `false` on
  // peer-joined / hello; cleared on peer-left + on disconnect.
  const latestPeerReady = new Map<number, boolean>()
  // Last-known bike + track picks per peer slot, including self.
  // Mirrors latestPeerReady's lifecycle.
  const latestPeerPicks = new Map<number, PeerPicks>()
  // Last-write-wins intent buffer per remote peer slot. Sized at most
  // MAX_PEERS_PER_ROOM - 1 entries. Cleared on disconnect; entries
  // pruned on peer-left.
  const latestPeerIntents = new Map<number, Intent>()

  const socket = new PartySocket({
    host: cfg.host,
    room: cfg.roomId,
  })
  socket.binaryType = 'arraybuffer'

  function sendPing(): void {
    if (!socketOpen || myPeerId < 0) return
    const msg: ClientControlMessage = { type: 'ping', t: performance.now() }
    socket.send(JSON.stringify(msg))
  }
  function startPingLoop(): void {
    if (pingTimer !== null) return
    sendPing()
    pingTimer = setInterval(sendPing, PING_INTERVAL_MS)
  }
  function stopPingLoop(): void {
    if (pingTimer === null) return
    clearInterval(pingTimer)
    pingTimer = null
  }

  // Initial publish — we're connecting (or, if partysocket reconnects on
  // its own later, we'll switch to 'reconnecting').
  publishStatus('connecting')

  socket.addEventListener('open', () => {
    socketOpen = true
  })
  socket.addEventListener('close', () => {
    // Did this close tear down an established session (slot assigned)?
    // Captured before the reset so onDisconnected only fires for real
    // drops, not for retry cycles that never got a hello.
    const hadSession = myPeerId >= 0
    socketOpen = false
    myPeerId = -1
    myJoinSeq = undefined
    remotePeers.clear()
    remotePeerSeqs.clear()
    latestPeerIntents.clear()
    latestPeerReady.clear()
    latestPeerPicks.clear()
    snapshotsReceived = 0
    latency.reset()
    stopPingLoop()
    // Explicit close(): the caller already published 'closed' — don't
    // overwrite it with 'connecting', and don't report a "drop".
    if (explicitClose) return
    // partysocket auto-reconnects unless we explicitly called close();
    // distinguish "first-time connecting" from "re-establishing".
    publishStatus(everConnected ? 'reconnecting' : 'connecting')
    if (hadSession) cfg.onDisconnected?.()
  })

  socket.addEventListener('message', (event: MessageEvent) => {
    const data = event.data
    if (typeof data === 'string') {
      const msg = parseControl(data)
      if (!msg) return
      switch (msg.type) {
        case 'hello':
          myPeerId = msg.peerId
          myJoinSeq = msg.joinSeq
          remotePeers.clear()
          remotePeerSeqs.clear()
          latestPeerReady.clear()
          latestPeerPicks.clear()
          // Seed every visible slot (us + others) as not-ready. Local
          // ready state is overwritten the first time `sendReady` is
          // called.
          latestPeerReady.set(msg.peerId, false)
          for (const p of msg.otherPeers) {
            remotePeers.add(p)
            latestPeerReady.set(p, false)
            const seq = msg.otherPeerSeqs?.[p]
            if (typeof seq === 'number') remotePeerSeqs.set(p, seq)
          }
          // Replay any picks the server has on file (peers who readied
          // before we joined). Bare-bones for back-compat: missing
          // peerPicks just leaves the map empty.
          if (msg.peerPicks) {
            for (const [k, v] of Object.entries(msg.peerPicks)) {
              const slot = Number(k)
              if (!Number.isFinite(slot)) continue
              latestPeerPicks.set(slot, {
                selectedBikeId: v.selectedBikeId,
                selectedTrackId: v.selectedTrackId,
              })
              if (typeof v.ready === 'boolean') latestPeerReady.set(slot, v.ready)
            }
          }
          everConnected = true
          startPingLoop()
          publishStatus('connected')
          cfg.onConnected?.(msg.peerId, [...remotePeers], msg.raceStarted)
          if (msg.raceStarted) cfg.onStartRace?.(msg.raceTrackId)
          break
        case 'peer-joined':
          remotePeers.add(msg.peerId)
          if (typeof msg.joinSeq === 'number') remotePeerSeqs.set(msg.peerId, msg.joinSeq)
          latestPeerReady.set(msg.peerId, false)
          publishStatus('connected')
          cfg.onPeerJoined?.(msg.peerId)
          break
        case 'peer-left':
          remotePeers.delete(msg.peerId)
          // Drop the departed peer's buffered intent + picks so a future
          // room member assigned the same slot doesn't inherit stale
          // controls or selections.
          remotePeerSeqs.delete(msg.peerId)
          latestPeerIntents.delete(msg.peerId)
          latestPeerReady.delete(msg.peerId)
          latestPeerPicks.delete(msg.peerId)
          publishStatus('connected')
          cfg.onPeerLeft?.(msg.peerId)
          break
        case 'pong': {
          const rtt = performance.now() - msg.t
          latency.record(rtt, Date.now())
          publishStatus('connected')
          break
        }
        case 'ready':
          // Defensive: drop self-echoes (server shouldn't send these,
          // but the local sendReady path already updates our own slot
          // so a duplicate is harmless either way).
          if (msg.peerId !== myPeerId) {
            latestPeerReady.set(msg.peerId, msg.ready)
            const picks: PeerPicks = {
              selectedBikeId: msg.selectedBikeId,
              selectedTrackId: msg.selectedTrackId,
            }
            // Merge — keep prior pick fields if the new message omitted
            // them. (Clients are free to send a bare ready toggle.)
            const prior = latestPeerPicks.get(msg.peerId)
            const merged: PeerPicks = {
              selectedBikeId: picks.selectedBikeId ?? prior?.selectedBikeId,
              selectedTrackId: picks.selectedTrackId ?? prior?.selectedTrackId,
            }
            latestPeerPicks.set(msg.peerId, merged)
            cfg.onPeerReady?.(msg.peerId, msg.ready, merged)
          }
          break
        case 'start-race':
          cfg.onStartRace?.(msg.trackId)
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
    get mySeat() {
      return mySeat()
    },
    get remoteSeats() {
      return remoteSeats()
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
    sendReady(ready: boolean, picks?: PeerPicks) {
      // Always update local state (the lobby UI reads from this map),
      // even if the socket isn't ready — we'll re-broadcast on connect
      // if the local state diverged in the meantime.
      if (myPeerId >= 0) {
        latestPeerReady.set(myPeerId, ready)
        if (picks) {
          const prior = latestPeerPicks.get(myPeerId)
          latestPeerPicks.set(myPeerId, {
            selectedBikeId: picks.selectedBikeId ?? prior?.selectedBikeId,
            selectedTrackId: picks.selectedTrackId ?? prior?.selectedTrackId,
          })
        }
      }
      if (!socketOpen || myPeerId < 0) return
      const msg: ClientControlMessage = {
        type: 'ready',
        ready,
        selectedBikeId: picks?.selectedBikeId,
        selectedTrackId: picks?.selectedTrackId,
      }
      socket.send(JSON.stringify(msg))
    },
    sendStartRace(trackId?: string) {
      if (!socketOpen || myPeerId < 0) return
      const msg: ClientControlMessage = { type: 'start-race', trackId }
      socket.send(JSON.stringify(msg))
    },
    get latestPeerReady() {
      return latestPeerReady
    },
    get latestPeerPicks() {
      return latestPeerPicks
    },
    get snapshotsReceived() {
      return snapshotsReceived
    },
    get latencyMs() {
      return latency.current(Date.now())
    },
    get everConnected() {
      return everConnected
    },
    close() {
      explicitClose = true
      stopPingLoop()
      socket.close()
      latency.reset()
      everConnected = false
      publishStatus('closed')
    },
  }
}
