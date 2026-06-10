/**
 * M10.4 — control-channel protocol shared by the PartyKit relay and the
 * client `NetRoom`. The binary `InputFrame` codec already lives in
 * `./input-frame`; this file covers the JSON-text "control" messages
 * (peer-id assignment, peer join/leave notifications, lobby ready
 * state + race start) so the two sides can't drift on field names or
 * string casing.
 *
 * Wire choice: control messages are JSON text frames, InputFrames are
 * binary frames. The client routes on `typeof message`. Two-tier on one
 * socket keeps the WebSocket count at one per peer — important because
 * PartyKit bills per concurrent connection.
 */

/** Maximum simultaneous peers per room. Caps `InputFrame.peerId` at a
 *  u8 (already enforced in the codec); 8 is enough for the planned
 *  4v4 racing mode with some headroom for spectators later. */
export const MAX_PEERS_PER_ROOM = 8

/** Sent by the server to a peer once on connect, after slot assignment.
 *  The peer learns its own slot and the slots of any peers already in the
 *  room — enough state to stamp local InputFrames and to initialise
 *  per-peer bike spawns on the client. */
export type HelloMessage = {
  type: 'hello'
  peerId: number
  /** Slots currently held by other connected peers (excludes me). */
  otherPeers: number[]
  /** Tenure protocol — my join sequence number: a per-room-session
   *  monotonic counter stamped by the relay at connect. Host election
   *  prefers the longest-tenured peer (lowest joinSeq) so a rejoiner
   *  who happens to land on a recycled low slot can't seize AI
   *  authority mid-race and teleport the field to its local spawn
   *  state. Optional: absent when talking to a relay that predates the
   *  field, in which case clients fall back to slot-order election. */
  joinSeq?: number | undefined
  /** Tenure protocol — joinSeq per other peer, keyed by slot. Same
   *  optionality contract as `joinSeq`. */
  otherPeerSeqs?: Record<number, number> | undefined
  /** M10.12 lobby — true once any peer in this room session has
   *  signalled `start-race`. Late joiners read this and immediately arm
   *  their countdown so they don't get stuck in the lobby waiting for
   *  already-racing peers to re-emit ready toggles. */
  raceStarted: boolean
  /** Menu-flow extension — track + bike picks of every currently-
   *  connected peer, so a fresh join can paint the lobby UI without
   *  waiting for each peer to re-emit their ready state. Indexed by
   *  peer slot. Missing entries mean "no pick yet". */
  peerPicks?:
    | Record<
        number,
        {
          selectedBikeId?: string | undefined
          selectedTrackId?: string | undefined
          ready?: boolean | undefined
        }
      >
    | undefined
  /** Once `raceStarted` flips, the host's chosen track gets stamped here
   *  so late joiners can navigate to the same race environment. */
  raceTrackId?: string | undefined
}

/** Sent by the server to existing peers when a new peer connects. */
export type PeerJoinedMessage = {
  type: 'peer-joined'
  peerId: number
  /** Tenure protocol — the joiner's relay-stamped join sequence (see
   *  `HelloMessage.joinSeq`). Optional for old-relay compatibility. */
  joinSeq?: number | undefined
}

/** Sent by the server when a peer disconnects (their slot frees up). */
export type PeerLeftMessage = {
  type: 'peer-left'
  peerId: number
}

/** Sent by the server when the room is full, immediately before it
 *  closes the connection with code 4000. The close CODE is the reliable
 *  signal — this courtesy message can be dropped when the close races
 *  the send — and the client must stop retrying either way. */
export type RoomFullMessage = {
  type: 'room-full'
}

/** Sent by the server when a connection arrives after the room's race
 *  has locked (start-race fired more than the join-grace ago), followed
 *  by a close with code 4001 (same delivery caveat as `room-full`).
 *  Product rule (2026-06-09): no mid-race joins — players enter through
 *  the lobby cohort and share the load-in + countdown. The client
 *  should stop retrying; the lock clears when the room empties. */
export type RaceInProgressMessage = {
  type: 'race-in-progress'
}

/** M10.12 lobby — peer announces their ready/not-ready state and
 *  optional bike + track picks. Sent client→server (server stamps the
 *  sender's slot before broadcasting, so peers can't spoof each other's
 *  slot) AND server→other peers (with the originating slot in `peerId`).
 *  Same shape both directions for simplicity; the relay fills in
 *  `peerId` from the connection's assigned slot when forwarding. */
export type ReadyMessage = {
  type: 'ready'
  peerId: number
  ready: boolean
  /** Lobby-flow extension. Reading peers use this to render the
   *  per-slot "this player picked X" indicator and to feed the
   *  smash-bros-style random pick when the race starts. Optional so
   *  legacy clients (pre-menu-flow) can still emit a bare ready toggle. */
  selectedBikeId?: string | undefined
  selectedTrackId?: string | undefined
}

/** Server → all peers when the room transitions out of lobby into
 *  countdown. Sent once per room session; mid-race joiners don't get one
 *  (they fall through into the active race at their own pace). The
 *  chosen track id is stamped on the message so every peer reloads into
 *  the same environment. */
export type StartRaceMessage = {
  type: 'start-race'
  /** Track id agreed for the race (selected by the calling client via
   *  smash-bros-style random pick from the lobby's votes). Optional for
   *  back-compat with clients that armed the countdown without sharing
   *  a track. */
  trackId?: string | undefined
}

/** Client → server ping. The server echoes the same `t` back as a
 *  `PongMessage` without touching it; the client computes RTT as
 *  `now - t`. Stateless on the server — pings don't bump presence and
 *  aren't billed against the room's broadcast budget. */
export type PingMessage = {
  type: 'ping'
  /** Client-side `performance.now()` at send. Opaque to the server. */
  t: number
}

/** Server → originating peer pong. Carries the original `t` so the
 *  client can compute RTT without needing to remember its outstanding
 *  pings. */
export type PongMessage = {
  type: 'pong'
  t: number
}

export type ServerControlMessage =
  | HelloMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | RoomFullMessage
  | RaceInProgressMessage
  | ReadyMessage
  | StartRaceMessage
  | PongMessage

/** Messages sent from a client to the server.
 *  - `ready`: lobby ready toggle (with current picks). Server re-broadcasts
 *    as a `ReadyMessage` carrying the originating slot.
 *  - `start-race`: a peer's local view found all peers ready and is
 *    arming the countdown. Server sets `raceStarted` and broadcasts a
 *    `StartRaceMessage` (with the chosen `trackId`) to everyone else
 *    so they arm too. Late joiners are told via the `raceStarted` flag
 *    in their `HelloMessage`.
 *  - `ping`: RTT probe. Server echoes `t` back in a `PongMessage`. */
export type ClientControlMessage =
  | {
      type: 'ready'
      ready: boolean
      selectedBikeId?: string | undefined
      selectedTrackId?: string | undefined
    }
  | { type: 'start-race'; trackId?: string | undefined }
  | PingMessage
