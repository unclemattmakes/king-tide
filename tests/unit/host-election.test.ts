/**
 * M10.11 — host election for AI authority. (2026-06: tenure-aware.)
 *
 * Slot-order rule (`isHostFor`): the AI host is the connected peer with
 * the lowest slot id. Tenure rule (`isHostSeat` / `electHostSeat`):
 * lowest relay-stamped joinSeq wins, slot order breaks ties and covers
 * missing seqs (old relay). Outside a room (`peerId < 0`) the local
 * peer is always host so the single-player path keeps running AI.
 */
import { describe, expect, it } from 'vitest'
import {
  electHostSeat,
  isHostFor,
  isHostSeat,
  type PeerSeat,
} from '../../src/engine/net/host-election'

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

const seat = (peerId: number, joinSeq?: number): PeerSeat =>
  joinSeq === undefined ? { peerId } : { peerId, joinSeq }

describe('isHostSeat (tenure election)', () => {
  it('treats a not-yet-connected peer as host', () => {
    expect(isHostSeat(seat(-1), [])).toBe(true)
    expect(isHostSeat(seat(-1), [seat(0, 0), seat(1, 1)])).toBe(true)
  })

  it('prefers the longest tenure over the lowest slot', () => {
    // The motivating regression: slots 1,2 are mid-race (seqs 1,2);
    // a fresh joiner recycles slot 0 with seq 7. Slot-order election
    // would hand it the AI field at spawn poses — tenure must not.
    expect(isHostSeat(seat(0, 7), [seat(1, 1), seat(2, 2)])).toBe(false)
    expect(isHostSeat(seat(1, 1), [seat(0, 7), seat(2, 2)])).toBe(true)
  })

  it('keeps slot-order behavior when no seqs are available (old relay)', () => {
    expect(isHostSeat(seat(0), [seat(1), seat(2)])).toBe(true)
    expect(isHostSeat(seat(2), [seat(0), seat(1)])).toBe(false)
  })

  it('falls back to slot order for any pair with a missing seq', () => {
    // Mixed visibility shouldn't happen (the relay stamps everyone or
    // no-one), but the rule must stay total and deterministic if it does.
    expect(isHostSeat(seat(0, 5), [seat(1)])).toBe(true) // 1 has no seq → slot order → 0 wins
    expect(isHostSeat(seat(1), [seat(0, 5)])).toBe(false)
  })

  it('breaks equal seqs by slot', () => {
    expect(isHostSeat(seat(1, 3), [seat(4, 3)])).toBe(true)
    expect(isHostSeat(seat(4, 3), [seat(1, 3)])).toBe(false)
  })

  it('promotes the next-longest tenure when the host leaves', () => {
    // Before: seqs 0,1,2 → seq 0 hosts. After seq-0 leaves:
    expect(isHostSeat(seat(2, 1), [seat(3, 2)])).toBe(true)
  })
})

describe('electHostSeat', () => {
  it('returns my own seat when I win', () => {
    expect(electHostSeat(seat(1, 1), [seat(0, 7), seat(2, 2)]).peerId).toBe(1)
  })

  it('returns the authoritative remote seat when a remote wins', () => {
    expect(electHostSeat(seat(2, 2), [seat(0, 7), seat(1, 1)]).peerId).toBe(1)
  })

  it('is order-independent across the remote list', () => {
    const a = electHostSeat(seat(5, 9), [seat(1, 4), seat(3, 2), seat(0, 8)])
    const b = electHostSeat(seat(5, 9), [seat(0, 8), seat(3, 2), seat(1, 4)])
    expect(a.peerId).toBe(3)
    expect(b.peerId).toBe(3)
  })
})
