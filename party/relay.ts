/**
 * M10.4 — first PartyKit room.
 *
 * The server is a pure relay: binary InputFrames inbound from any peer
 * are broadcast to every OTHER peer. No sim runs here. That decision is
 * load-bearing — by keeping the server stateless w.r.t. game state, we
 * can swap the deployment target (PartyKit / a Node WS server / mock
 * harness) without touching netcode. The future M10.5+ work that does
 * authoritative sim or rollback validation will layer on top, not
 * replace this.
 *
 * Control messages flow through here too — the server stamps each
 * peer's slot (so peers can't spoof each other) and keeps a small
 * amount of presence state:
 *   - `raceStarted` sticky bit + the chosen `raceTrackId` (so late
 *     joiners get routed straight into the same race environment)
 *   - per-peer ready/pick map (so a fresh join can paint the lobby
 *     without waiting for everyone to re-broadcast)
 *
 * @see src/engine/net/protocol.ts — shared protocol types
 * @see src/engine/net/slot-assign.ts — slot picker
 * @see src/engine/net/room.ts — client side
 */
import type * as Party from 'partykit/server'

import {
  type ClientControlMessage,
  type HelloMessage,
  MAX_PEERS_PER_ROOM,
  type PeerJoinedMessage,
  type PeerLeftMessage,
  type ReadyMessage,
  type RoomFullMessage,
  type StartRaceMessage,
} from '../src/engine/net/protocol'
import { assignLowestFreeSlot } from '../src/engine/net/slot-assign'

type PeerState = { slot: number }

function parseClientControl(text: string): ClientControlMessage | null {
  try {
    const obj = JSON.parse(text)
    if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return null
    if (obj.type === 'ready' && typeof obj.ready === 'boolean') return obj as ClientControlMessage
    if (obj.type === 'start-race') return obj as ClientControlMessage
  } catch {
    // fall through
  }
  return null
}

export default class RelayServer implements Party.Server {
  // M10.12 lobby — sticky bit set the first time any peer broadcasts
  // `start-race`. Replayed in every subsequent `hello` so late joiners
  // skip the lobby and dive straight into the race that's already
  // running. Resets when the room empties (see `onClose`).
  private raceStarted = false
  /** Track id chosen by the start-race signaller (may be undefined if
   *  the client armed without picking). Replayed in `hello` so late
   *  joiners load the same environment. */
  private raceTrackId: string | undefined = undefined
  /** Per-slot last-known lobby state (ready + picks). Replayed in
   *  `hello` so a fresh join paints the lobby in one frame. Cleared on
   *  peer disconnect and room empty. */
  private peerPicks: Record<
    number,
    {
      selectedBikeId?: string
      selectedTrackId?: string
      ready?: boolean
    }
  > = {}

  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection, _ctx: Party.ConnectionContext): void {
    const taken: number[] = []
    for (const c of this.room.getConnections<PeerState>()) {
      if (c.id === conn.id) continue
      const slot = c.state?.slot
      if (typeof slot === 'number') taken.push(slot)
    }

    const slot = assignLowestFreeSlot(taken, MAX_PEERS_PER_ROOM)
    if (slot === null) {
      const msg: RoomFullMessage = { type: 'room-full' }
      conn.send(JSON.stringify(msg))
      conn.close(4000, 'room full')
      return
    }

    conn.setState({ slot })

    const hello: HelloMessage = {
      type: 'hello',
      peerId: slot,
      otherPeers: taken,
      raceStarted: this.raceStarted,
      peerPicks: { ...this.peerPicks },
      raceTrackId: this.raceTrackId,
    }
    conn.send(JSON.stringify(hello))

    const joined: PeerJoinedMessage = { type: 'peer-joined', peerId: slot }
    this.room.broadcast(JSON.stringify(joined), [conn.id])
  }

  onMessage(message: string | ArrayBuffer | ArrayBufferView, sender: Party.Connection): void {
    // Binary frames are InputFrames / TransformSnapshots — relay them
    // as-is. The codec lives on the clients; the server stays
    // format-agnostic so future binary message types can share this
    // channel without changing the relay logic.
    if (typeof message !== 'string') {
      this.room.broadcast(message, [sender.id])
      return
    }

    const ctl = parseClientControl(message)
    if (!ctl) return
    const slot = (sender.state as PeerState | null)?.slot
    if (typeof slot !== 'number') return
    if (ctl.type === 'ready') {
      // Stamp the sender's slot before re-broadcasting (peers can't
      // spoof another peer's ready state) and stash picks for replay
      // to late joiners.
      const prior = this.peerPicks[slot] ?? {}
      this.peerPicks[slot] = {
        selectedBikeId: ctl.selectedBikeId ?? prior.selectedBikeId,
        selectedTrackId: ctl.selectedTrackId ?? prior.selectedTrackId,
        ready: ctl.ready,
      }
      const out: ReadyMessage = {
        type: 'ready',
        peerId: slot,
        ready: ctl.ready,
        selectedBikeId: ctl.selectedBikeId,
        selectedTrackId: ctl.selectedTrackId,
      }
      this.room.broadcast(JSON.stringify(out), [sender.id])
    } else if (ctl.type === 'start-race') {
      // First peer to call wins; later calls are no-ops on the sticky
      // bit but still trigger a broadcast so any client that missed an
      // earlier transition (e.g. a buffered message during reconnect)
      // arms the countdown.
      if (!this.raceStarted) {
        this.raceStarted = true
        this.raceTrackId = ctl.trackId
      }
      const out: StartRaceMessage = { type: 'start-race', trackId: this.raceTrackId }
      this.room.broadcast(JSON.stringify(out), [sender.id])
    }
  }

  onClose(conn: Party.Connection): void {
    const slot = (conn.state as PeerState | null)?.slot
    if (typeof slot !== 'number') return
    delete this.peerPicks[slot]
    const left: PeerLeftMessage = { type: 'peer-left', peerId: slot }
    this.room.broadcast(JSON.stringify(left))
    // Reset the sticky raceStarted bit when the room empties so the
    // next session starts in lobby state. We check AFTER broadcasting
    // peer-left so any remaining peer counts AFTER this close.
    const remaining = [...this.room.getConnections()].filter((c) => c.id !== conn.id).length
    if (remaining === 0) {
      this.raceStarted = false
      this.raceTrackId = undefined
      this.peerPicks = {}
    }
  }
}
