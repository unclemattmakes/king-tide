/**
 * M10.4 — control-channel protocol shared by the PartyKit relay and the
 * client `NetRoom`. The binary `InputFrame` codec already lives in
 * `./input-frame`; this file covers the JSON-text "control" messages
 * (peer-id assignment, peer join/leave notifications) so the two sides
 * can't drift on field names or string casing.
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
}

/** Sent by the server to existing peers when a new peer connects. */
export type PeerJoinedMessage = {
  type: 'peer-joined'
  peerId: number
}

/** Sent by the server when a peer disconnects (their slot frees up). */
export type PeerLeftMessage = {
  type: 'peer-left'
  peerId: number
}

/** Sent by the server when the room is full. The client should close
 *  cleanly rather than retry. */
export type RoomFullMessage = {
  type: 'room-full'
}

export type ServerControlMessage =
  | HelloMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | RoomFullMessage
