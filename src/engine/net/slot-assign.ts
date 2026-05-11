/**
 * Peer-slot assignment for the multiplayer room.
 *
 * Each connected peer gets a stable integer slot in [0, max). This number
 * fills `InputFrame.peerId` and indexes per-peer state in the sim (later,
 * a per-peer bike). Slots are assigned by walking 0..max and picking the
 * lowest unused integer, so a disconnecting peer's slot is recycled to
 * the next joiner — important for keeping the InputFrame.peerId byte
 * dense rather than sparse.
 *
 * Pure helper, extracted from the PartyKit relay so it can be unit-tested
 * without spinning up a Cloudflare Workers runtime.
 */

/** Return the lowest integer in [0, max) that is not present in `taken`,
 *  or null if every slot is taken. */
export function assignLowestFreeSlot(taken: Iterable<number>, max: number): number | null {
  const set = taken instanceof Set ? taken : new Set(taken)
  for (let i = 0; i < max; i++) {
    if (!set.has(i)) return i
  }
  return null
}
