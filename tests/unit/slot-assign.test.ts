/**
 * M10.4 — peer-slot assignment.
 *
 * The PartyKit relay's slot picker has to keep peer ids dense (so the u8
 * `InputFrame.peerId` doesn't go sparse) and survive arbitrary
 * join/leave orderings. Tested in isolation here so the relay itself
 * stays a thin shell.
 */
import { describe, expect, it } from 'vitest'
import { assignLowestFreeSlot } from '../../src/engine/net/slot-assign'

describe('assignLowestFreeSlot', () => {
  it('returns 0 when nothing is taken', () => {
    expect(assignLowestFreeSlot([], 8)).toBe(0)
  })

  it('returns the lowest free slot when a contiguous prefix is taken', () => {
    expect(assignLowestFreeSlot([0, 1, 2], 8)).toBe(3)
  })

  it('fills holes left by disconnects before extending', () => {
    // Slot 1 freed up by a leaver — the next joiner should take it, not slot 3.
    expect(assignLowestFreeSlot([0, 2], 8)).toBe(1)
  })

  it('accepts a Set as input', () => {
    expect(assignLowestFreeSlot(new Set([0, 1, 2, 4]), 8)).toBe(3)
  })

  it('returns null when every slot in [0, max) is taken', () => {
    expect(assignLowestFreeSlot([0, 1, 2, 3, 4, 5, 6, 7], 8)).toBeNull()
  })

  it('returns 0 when max is 0', () => {
    expect(assignLowestFreeSlot([], 0)).toBeNull()
  })

  it('ignores out-of-range entries above max', () => {
    // Defensive: if a stale state holds slot 99 (max bumped down?), 0 is still free.
    expect(assignLowestFreeSlot([99, 100], 8)).toBe(0)
  })

  it('is stable under repeated calls for the same input', () => {
    const taken = [0, 2, 3]
    expect(assignLowestFreeSlot(taken, 8)).toBe(1)
    expect(assignLowestFreeSlot(taken, 8)).toBe(1)
  })

  it('produces dense ids across a join/leave/rejoin churn', () => {
    // Simulate the room walking through:
    //   A joins   → slot 0
    //   B joins   → slot 1
    //   C joins   → slot 2
    //   B leaves  → freed slot 1
    //   D joins   → should reuse slot 1 (NOT 3)
    //   E joins   → slot 3
    const taken = new Set<number>()
    const seq: Array<{ op: 'join' | 'leave'; expected?: number; victim?: number }> = [
      { op: 'join', expected: 0 },
      { op: 'join', expected: 1 },
      { op: 'join', expected: 2 },
      { op: 'leave', victim: 1 },
      { op: 'join', expected: 1 },
      { op: 'join', expected: 3 },
    ]
    for (const step of seq) {
      if (step.op === 'join') {
        const slot = assignLowestFreeSlot(taken, 8)
        expect(slot).toBe(step.expected)
        taken.add(slot!)
      } else {
        taken.delete(step.victim!)
      }
    }
    // After the churn, slots should be exactly { 0, 1, 2, 3 }.
    expect([...taken].sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
  })
})
