import { describe, expect, it } from 'vitest'

import { makeShuffleOrder, reshuffleAvoiding } from '../../src/engine/audio/soundtrack'
import { SOUNDTRACK } from '../../src/engine/audio/soundtrack.generated'

/**
 * Covers the pure rotation helpers behind the soundtrack radio and the
 * integrity of the generated manifest (`pnpm gen:music`). The jukebox's
 * Web Audio / <audio> wiring is integration territory; these guard the
 * logic that decides what plays next and that the credits are well-formed.
 */

/** Deterministic LCG so the shuffle order is reproducible in tests. */
function seededRand(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

describe('makeShuffleOrder', () => {
  it('returns a permutation of [0, n)', () => {
    const order = makeShuffleOrder(14, seededRand(42))
    expect(order).toHaveLength(14)
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 14 }, (_, i) => i))
  })

  it('handles empty and singleton playlists', () => {
    expect(makeShuffleOrder(0)).toEqual([])
    expect(makeShuffleOrder(1)).toEqual([0])
  })

  it('is deterministic for a given rng', () => {
    expect(makeShuffleOrder(8, seededRand(7))).toEqual(makeShuffleOrder(8, seededRand(7)))
  })

  it('does not mutate across calls (fresh array each time)', () => {
    const a = makeShuffleOrder(5, seededRand(1))
    const b = makeShuffleOrder(5, seededRand(1))
    a[0] = -999
    expect(b[0]).not.toBe(-999)
  })
})

describe('reshuffleAvoiding', () => {
  it('never starts the next rotation with the track that just finished', () => {
    // Exhaustively across seeds — a back-to-back repeat would be jarring.
    for (let seed = 1; seed <= 200; seed++) {
      const last = seed % 14
      const order = reshuffleAvoiding(14, last, seededRand(seed))
      expect(order[0]).not.toBe(last)
      expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 14 }, (_, i) => i))
    }
  })

  it('drops the constraint when it is impossible (n < 2)', () => {
    expect(reshuffleAvoiding(1, 0, seededRand(3))).toEqual([0])
    expect(reshuffleAvoiding(0, 0, seededRand(3))).toEqual([])
  })
})

describe('SOUNDTRACK manifest', () => {
  it('has the full licensed set', () => {
    expect(SOUNDTRACK.length).toBeGreaterThanOrEqual(14)
  })

  it('every entry is well-formed', () => {
    for (const entry of SOUNDTRACK) {
      expect(entry.file).toMatch(/^[a-z0-9-]+\.opus$/)
      expect(entry.artist.trim()).not.toBe('')
      expect(entry.title.trim()).not.toBe('')
    }
  })

  it('has unique filenames (no slug collisions)', () => {
    const files = SOUNDTRACK.map((e) => e.file)
    expect(new Set(files).size).toBe(files.length)
  })

  it('preserves human-readable credit punctuation', () => {
    // Spot-check the tricky source names parse into clean display strings.
    const byTitle = new Map(SOUNDTRACK.map((e) => [e.title, e.artist]))
    expect(byTitle.has("Suddenly It Occurs To Me There's No Ocean Here")).toBe(true)
    expect(byTitle.has('Hawaii 5-0 (CB 203)')).toBe(true)
    expect(byTitle.has('Sunny Positive Surf Rock (Sandy Shores)')).toBe(true)
  })
})
