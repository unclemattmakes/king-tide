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
 *   - `raceStarted` sticky bit + `raceStartedAtMs` + the chosen
 *     `raceTrackId` — the RACE LOCK (product rule 2026-06-09: no
 *     mid-race joins). Within RACE_JOIN_GRACE_MS of start-race, new
 *     connections are admitted and routed into the same race (the
 *     cohort's own race tabs + a share-link friend who still makes the
 *     countdown); after it, joins are rejected with
 *     `race-in-progress` / close 4001 until the room empties. The lock
 *     lives in room storage because the lobby→race navigation handoff
 *     empties the room and recycles this instance every time.
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
  type PongMessage,
  type RaceInProgressMessage,
  type ReadyMessage,
  type RoomFullMessage,
  type StartRaceMessage,
} from '../src/engine/net/protocol'
import { assignLowestFreeSlot } from '../src/engine/net/slot-assign'

/** How long after `start-race` the room stays joinable. Covers the lobby
 *  cohort's banner pause + navigation + a slow load-in (so a friend who
 *  clicked the share link seconds late still makes the countdown), while
 *  locking out genuine mid-race arrivals. Product rule (2026-06-09): no
 *  mid-race joins — see docs/multiplayer-review.md. */
const RACE_JOIN_GRACE_MS = 30_000

/** Room-storage key holding `{ startedAtMs, trackId }` while a race is
 *  live. Storage (not instance memory) because the platform recycles
 *  the server instance whenever the room empties — which the
 *  lobby→race navigation handoff does every time. */
const RACE_STORAGE_KEY = 'race'

type PeerState = { slot: number; joinSeq: number }

function parseClientControl(text: string): ClientControlMessage | null {
  try {
    const obj = JSON.parse(text)
    if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return null
    if (obj.type === 'ready' && typeof obj.ready === 'boolean') return obj as ClientControlMessage
    if (obj.type === 'start-race') return obj as ClientControlMessage
    if (obj.type === 'ping' && typeof obj.t === 'number') return obj as ClientControlMessage
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
   *  the client armed without picking). Replayed in `hello` so in-grace
   *  joiners load the same environment. */
  private raceTrackId: string | undefined = undefined
  /** Epoch ms when `raceStarted` flipped. Drives the join lock: more
   *  than RACE_JOIN_GRACE_MS later, new connections are rejected with
   *  `race-in-progress` until the room empties. */
  private raceStartedAtMs = 0
  /** Tenure counter — stamped onto each connection at join so clients
   *  can elect the longest-tenured peer as AI host (slots recycle, so
   *  slot order alone lets a rejoiner seize hostship mid-race; see
   *  src/engine/net/host-election.ts). Monotonic per room session;
   *  resets when the room empties, alongside `raceStarted`. */
  private joinCounter = 0
  /** Per-slot last-known lobby state (ready + picks). Replayed in
   *  `hello` so a fresh join paints the lobby in one frame. Cleared on
   *  peer disconnect and room empty. Fields are `string | undefined`
   *  (not just optional) so the `??` merge in `onMessage` can write an
   *  unknown pick back explicitly under `exactOptionalPropertyTypes`. */
  private peerPicks: Record<
    number,
    {
      selectedBikeId?: string | undefined
      selectedTrackId?: string | undefined
      ready?: boolean | undefined
    }
  > = {}

  constructor(readonly room: Party.Room) {}

  async onConnect(conn: Party.Connection, _ctx: Party.ConnectionContext): Promise<void> {
    // Recover the race lock after an instance recycle. The platform
    // disposes a room's server instance whenever the room empties — and
    // the lobby→race handoff reliably empties it (every cohort member's
    // lobby socket closes at the same banner timeout while their race
    // tabs spend seconds loading). In-memory state alone therefore
    // NEVER survives into the race; room storage does (verified against
    // partykit dev — and Cloudflare evicts idle DOs in prod too).
    if (!this.raceStarted) {
      const saved = await this.room.storage.get<{ startedAtMs: number; trackId?: string }>(
        RACE_STORAGE_KEY,
      )
      if (saved) {
        this.raceStarted = true
        this.raceStartedAtMs = saved.startedAtMs
        this.raceTrackId = saved.trackId
      }
    }

    let othersConnected = 0
    for (const c of this.room.getConnections()) {
      if (c.id !== conn.id) othersConnected++
    }

    const raceAgeMs = this.raceStarted ? Date.now() - this.raceStartedAtMs : -1
    console.log(
      `[relay] connect ${conn.id} (room ${this.room.id}): others=${othersConnected}, raceStarted=${this.raceStarted}, ageS=${raceAgeMs < 0 ? '-' : Math.round(raceAgeMs / 1000)}`,
    )
    if (othersConnected === 0 && !(this.raceStarted && raceAgeMs <= RACE_JOIN_GRACE_MS)) {
      // First connection of a NEW session — clear any leftover race
      // state: an empty room past the grace is an abandoned session,
      // not a race in progress. Within the grace an empty room is
      // presumed mid-handoff and the lock survives.
      this.resetRaceState()
    } else if (this.raceStarted && raceAgeMs > RACE_JOIN_GRACE_MS) {
      // Race lock — no mid-race joins (product rule 2026-06-09). The
      // grace admits the cohort's own race tabs (and a share-link friend
      // arriving seconds late — they still make the countdown); after
      // it, the room is closed to newcomers until it empties. Applies
      // to solo rooms too: their race is just as in-progress.
      console.log(
        `[relay] reject ${conn.id} (room ${this.room.id}): race in progress, age ${Math.round(raceAgeMs / 1000)}s`,
      )
      const msg: RaceInProgressMessage = { type: 'race-in-progress' }
      conn.send(JSON.stringify(msg))
      conn.close(4001, 'race in progress')
      return
    }

    const taken: number[] = []
    const takenSeqs: Record<number, number> = {}
    for (const c of this.room.getConnections<PeerState>()) {
      if (c.id === conn.id) continue
      const slot = c.state?.slot
      if (typeof slot === 'number') {
        taken.push(slot)
        const seq = c.state?.joinSeq
        if (typeof seq === 'number') takenSeqs[slot] = seq
      }
    }

    const slot = assignLowestFreeSlot(taken, MAX_PEERS_PER_ROOM)
    if (slot === null) {
      const msg: RoomFullMessage = { type: 'room-full' }
      conn.send(JSON.stringify(msg))
      conn.close(4000, 'room full')
      return
    }

    const joinSeq = this.joinCounter++
    conn.setState({ slot, joinSeq })

    const hello: HelloMessage = {
      type: 'hello',
      peerId: slot,
      otherPeers: taken,
      joinSeq,
      otherPeerSeqs: takenSeqs,
      raceStarted: this.raceStarted,
      peerPicks: { ...this.peerPicks },
      raceTrackId: this.raceTrackId,
    }
    conn.send(JSON.stringify(hello))

    const joined: PeerJoinedMessage = { type: 'peer-joined', peerId: slot, joinSeq }
    this.room.broadcast(JSON.stringify(joined), [conn.id])
  }

  async onMessage(
    message: string | ArrayBuffer | ArrayBufferView,
    sender: Party.Connection,
  ): Promise<void> {
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
        this.raceStartedAtMs = Date.now()
        // Persist BEFORE broadcasting — the race lock must survive the
        // instance recycle that the cohort's navigation handoff causes.
        await this.room.storage.put(RACE_STORAGE_KEY, {
          startedAtMs: this.raceStartedAtMs,
          trackId: this.raceTrackId,
        })
        console.log(
          `[relay] start-race (room ${this.room.id}): track=${this.raceTrackId ?? '-'}, lock armed`,
        )
      }
      const out: StartRaceMessage = { type: 'start-race', trackId: this.raceTrackId }
      this.room.broadcast(JSON.stringify(out), [sender.id])
    } else if (ctl.type === 'ping') {
      // Stateless RTT echo. Server doesn't touch `t` — the round-trip
      // timing is computed entirely client-side from the value the
      // sender stamped on the way out.
      const pong: PongMessage = { type: 'pong', t: ctl.t }
      sender.send(JSON.stringify(pong))
    }
  }

  onClose(conn: Party.Connection): void {
    const slot = (conn.state as PeerState | null)?.slot
    if (typeof slot !== 'number') return
    delete this.peerPicks[slot]
    const left: PeerLeftMessage = { type: 'peer-left', peerId: slot }
    this.room.broadcast(JSON.stringify(left))
    // Reset the sticky race state when the room empties — UNLESS the
    // race is inside its join grace: the lobby→race handoff empties the
    // room every time (all lobby sockets close at the banner timeout,
    // race tabs take seconds to load), and resetting here would wipe
    // the lock before the cohort's race tabs arrive. Past the grace an
    // empty room is an abandoned session. We check AFTER broadcasting
    // peer-left so any remaining peer counts AFTER this close. (The
    // empty-room check in onConnect covers the case where this close
    // never fires cleanly.)
    const remaining = [...this.room.getConnections()].filter((c) => c.id !== conn.id).length
    if (remaining === 0) {
      const midHandoff = this.raceStarted && Date.now() - this.raceStartedAtMs <= RACE_JOIN_GRACE_MS
      if (!midHandoff) this.resetRaceState()
    }
  }

  private resetRaceState(): void {
    this.raceStarted = false
    this.raceTrackId = undefined
    this.raceStartedAtMs = 0
    this.peerPicks = {}
    this.joinCounter = 0
    // Fire-and-forget: callers are sync paths (onClose) or have already
    // updated the in-memory mirror that all decisions read first.
    void this.room.storage.delete(RACE_STORAGE_KEY)
  }
}
