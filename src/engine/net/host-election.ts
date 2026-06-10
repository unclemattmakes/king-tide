/**
 * M10.11 — host election for AI authority. (2026-06: tenure-aware.)
 *
 * Everyone in the room sees the same peer set (the relay broadcasts
 * joins / leaves), so no negotiation is needed — each peer computes its
 * own host status locally from shared facts.
 *
 * Election rule, in priority order:
 *
 *  1. **Tenure** — when the relay speaks the joinSeq protocol (see
 *     `protocol.ts:HelloMessage.joinSeq`), the peer with the lowest
 *     join sequence (longest in the room) is host. This keeps AI
 *     authority with a peer whose AI state is current: slots recycle
 *     lowest-free, so a mid-race joiner can land on slot 0 — under
 *     slot-order election it would instantly seize hostship with its
 *     AI bikes still parked on the start grid, teleporting the field
 *     for everyone. Under tenure it never outranks an incumbent.
 *  2. **Slot order** — tie-break for equal/unknown tenure, and the
 *     whole rule when joinSeqs are unavailable (older relay). Matches
 *     the original M10.11 behavior.
 *
 * Promotion on host *leave* is safe under either rule: survivors have
 * been applying the departed host's 20 Hz AI snapshots, so the new
 * host's kinematic AI poses are current when it flips them dynamic.
 *
 * Outside a room (peerId < 0), the local peer is always host — it runs
 * the only sim.
 *
 * @see docs/m10-11-state-sync.md §4
 * @see docs/multiplayer-review.md finding #5
 */

/** A peer's election credentials: slot + (when the relay provides it)
 *  the relay-stamped join sequence. */
export type PeerSeat = {
  peerId: number
  joinSeq?: number | undefined
}

/** True when `a` outranks `b` for host election: earlier join wins when
 *  both tenures are known; slot order breaks ties and covers unknown
 *  tenure. */
function outranks(a: PeerSeat, b: PeerSeat): boolean {
  if (a.joinSeq !== undefined && b.joinSeq !== undefined && a.joinSeq !== b.joinSeq) {
    return a.joinSeq < b.joinSeq
  }
  return a.peerId < b.peerId
}

/** The seat that currently holds AI authority among `me` and `remotes`. */
export function electHostSeat(me: PeerSeat, remotes: readonly PeerSeat[]): PeerSeat {
  let best = me
  for (const r of remotes) {
    if (outranks(r, best)) best = r
  }
  return best
}

/** Tenure-aware host test. Outside a room (`me.peerId < 0`): always host. */
export function isHostSeat(me: PeerSeat, remotes: readonly PeerSeat[]): boolean {
  if (me.peerId < 0) return true
  return electHostSeat(me, remotes).peerId === me.peerId
}

/** Slot-order-only election — the original M10.11 rule, retained for
 *  call sites that only have slot ids. Equivalent to `isHostSeat` with
 *  no joinSeqs supplied. */
export function isHostFor(myPeerId: number, remotePeers: readonly number[]): boolean {
  if (myPeerId < 0) return true
  for (const p of remotePeers) {
    if (p < myPeerId) return false
  }
  return true
}
