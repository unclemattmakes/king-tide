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
 * Two control messages:
 *  - Server → peer on connect: `hello` (assigned slot + currently-occupied
 *    slots).
 *  - Server → existing peers on join: `peer-joined` (new slot).
 *  - Server → remaining peers on close: `peer-left` (freed slot).
 *
 * Slot assignment uses {@link assignLowestFreeSlot} so slot ids stay
 * dense, which matches the u8 `InputFrame.peerId` budget.
 *
 * @see src/engine/net/protocol.ts — shared protocol types
 * @see src/engine/net/slot-assign.ts — slot picker
 * @see src/engine/net/room.ts — client side
 */
import type * as Party from 'partykit/server'

import {
  type HelloMessage,
  MAX_PEERS_PER_ROOM,
  type PeerJoinedMessage,
  type PeerLeftMessage,
  type RoomFullMessage,
} from '../src/engine/net/protocol'
import { assignLowestFreeSlot } from '../src/engine/net/slot-assign'

type PeerState = { slot: number }

export default class RelayServer implements Party.Server {
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
    }
    conn.send(JSON.stringify(hello))

    const joined: PeerJoinedMessage = { type: 'peer-joined', peerId: slot }
    this.room.broadcast(JSON.stringify(joined), [conn.id])
  }

  onMessage(message: string | ArrayBuffer | ArrayBufferView, sender: Party.Connection): void {
    // Binary frames are InputFrames — relay them as-is. The codec lives on
    // the clients; the server stays format-agnostic so future message types
    // (snapshot rebroadcast, etc.) can share this channel without changing
    // the relay logic.
    if (typeof message === 'string') return
    this.room.broadcast(message, [sender.id])
  }

  onClose(conn: Party.Connection): void {
    const slot = (conn.state as PeerState | null)?.slot
    if (typeof slot !== 'number') return
    const left: PeerLeftMessage = { type: 'peer-left', peerId: slot }
    this.room.broadcast(JSON.stringify(left))
  }
}
