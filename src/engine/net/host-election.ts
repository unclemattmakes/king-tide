/**
 * M10.11 — host election for AI authority.
 *
 * The "host" is the connected peer with the lowest slot id. Everyone in
 * the room sees the same set of slots (the relay broadcasts joins /
 * leaves), so no negotiation needed — each peer can compute its own
 * host status locally.
 *
 * Slot 0 is host whenever connected. If slot 0 leaves, slot 1 becomes
 * host. Outside a room (single-player), the local peer is always host
 * (it's running the only sim).
 *
 * @see docs/m10-11-state-sync.md §4
 */
export function isHostFor(myPeerId: number, remotePeers: readonly number[]): boolean {
  if (myPeerId < 0) return true
  for (const p of remotePeers) {
    if (p < myPeerId) return false
  }
  return true
}
