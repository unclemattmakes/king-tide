/**
 * Deterministic lobby track pick — every peer computes the same winner.
 *
 * The lobby's "smash-bros random over the votes" used to run through
 * `Math.random` on whichever client noticed all-ready first. But more than
 * one client can notice at effectively the same instant: the final `ready`
 * toggle and the toggler's `start-race` arrive back-to-back, and a receiver
 * arms inside its `ready` handler — before it ever sees the `start-race`
 * sitting next in the queue. Two clients arming with two different random
 * picks navigated to two different tracks in the same room (see
 * docs/multiplayer-review.md finding #2).
 *
 * Fix: seed the pick from data every peer already shares — the room id and
 * the full vote set — so the "random" winner is a pure function of the
 * lobby state. Votes are sorted by peer slot before hashing because map
 * iteration order differs per client (each client inserts itself first).
 *
 * The relay's sticky `raceTrackId` (first `start-race` wins, replayed to
 * late joiners) stays as the authority backstop; this module just makes
 * simultaneous arming converge on the same answer in the first place.
 */

import { createRng } from '@/engine/sim/rng'

export type TrackVote = {
  /** Peer slot the vote belongs to. Used only as the sort key. */
  peerId: number
  /** The peer's picked track, or undefined if they readied without one. */
  trackId: string | undefined
}

/** FNV-1a 32-bit hash — tiny, stable, good enough to spread room ids and
 *  vote strings across the mulberry32 seed space. */
export function hashStringToSeed(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Pick the winning track from the lobby's votes, deterministically: the
 * same `roomId` + the same set of `(peerId, trackId)` votes produce the
 * same winner on every client, regardless of the order votes were
 * collected in. Falls back to `fallback` when nobody voted.
 */
export function deterministicTrackPick(
  votes: readonly TrackVote[],
  roomId: string,
  fallback: string,
): string {
  const sorted = [...votes].sort((a, b) => a.peerId - b.peerId)
  const cast = sorted.filter((v): v is TrackVote & { trackId: string } =>
    Boolean(v.trackId && v.trackId.length > 0),
  )
  if (cast.length === 0) return fallback
  const seedSource = `${roomId}|${cast.map((v) => `${v.peerId}:${v.trackId}`).join(',')}`
  const rng = createRng(hashStringToSeed(seedSource))
  const winner = cast[rng.nextInt(cast.length)]
  return winner ? winner.trackId : fallback
}
