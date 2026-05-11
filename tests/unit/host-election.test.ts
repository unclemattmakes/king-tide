/**
 * M10.11 — host election for AI authority.
 *
 * The AI host is the connected peer with the lowest slot id. Each peer
 * computes its own host status locally from the slot set the relay
 * broadcasts. Outside a room (`myPeerId < 0`) the local peer is always
 * host so the single-player path keeps running AI as today.
 */
import { describe, expect, it } from 'vitest'
import { isHostFor } from '../../src/engine/net/host-election'

describe('isHostFor', () => {
  it('treats a not-yet-connected peer as host (single-player / pre-connect)', () => {
    expect(isHostFor(-1, [])).toBe(true)
  })

  it('treats a not-yet-connected peer as host even with peers visible', () => {
    // Before `onConnected` patches our peerId we shouldn't suddenly defer to
    // someone else's sim; the local AI keeps running until we know our slot.
    expect(isHostFor(-1, [0, 1, 2])).toBe(true)
  })

  it('returns true when alone in a room as slot 0', () => {
    expect(isHostFor(0, [])).toBe(true)
  })

  it('returns true for slot 0 with other peers present (host: lowest slot)', () => {
    expect(isHostFor(0, [1, 2, 3])).toBe(true)
  })

  it('returns false when a lower-slot peer is present (slot 0 present)', () => {
    expect(isHostFor(2, [0, 1, 3])).toBe(false)
  })

  it('returns true when we are the lowest slot among visible peers', () => {
    expect(isHostFor(2, [3, 4, 5])).toBe(true)
  })

  it('returns false when only slot 1 (still below us) is present', () => {
    expect(isHostFor(2, [1, 3, 4])).toBe(false)
  })

  it('returns true when alone with a high slot id (e.g. after recycle)', () => {
    expect(isHostFor(5, [])).toBe(true)
  })

  it('is order-independent', () => {
    // Same set as [1, 3, 4] above, just shuffled — must agree.
    expect(isHostFor(2, [3, 1, 4])).toBe(false)
  })
})
