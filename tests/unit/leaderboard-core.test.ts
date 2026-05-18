import { describe, expect, it } from 'vitest'
import {
  type LeaderboardEntry,
  MAX_ENTRIES_PER_TRACK,
  mergeEntry,
  normalizeHandle,
} from '../../src/engine/leaderboard/core'

const NOW = 1_700_000_000_000

function entry(handle: string, bestLap: number, bikeId = 'racer'): LeaderboardEntry {
  return { handle, bestLap, bikeId, recordedAt: NOW }
}

describe('mergeEntry', () => {
  it('inserts the first entry at rank 1', () => {
    const { next, result } = mergeEntry([], {
      handle: 'ABC',
      bikeId: 'racer',
      bestLap: 42,
      recordedAt: NOW,
    })
    expect(result).toEqual({ rank: 1, improved: true, total: 1 })
    expect(next).toHaveLength(1)
    expect(next[0]?.handle).toBe('ABC')
  })

  it('sorts by bestLap ascending', () => {
    const seed = [entry('A', 50), entry('B', 40)]
    const { next, result } = mergeEntry(seed, {
      handle: 'C',
      bikeId: 'racer',
      bestLap: 45,
      recordedAt: NOW,
    })
    expect(result.rank).toBe(2)
    expect(next.map((e) => e.handle)).toEqual(['B', 'C', 'A'])
  })

  it('drops slower submissions for the same handle', () => {
    const seed = [entry('ABC', 30)]
    const { next, result } = mergeEntry(seed, {
      handle: 'ABC',
      bikeId: 'racer',
      bestLap: 40,
      recordedAt: NOW,
    })
    expect(result.improved).toBe(false)
    expect(result.rank).toBe(1)
    expect(next).toHaveLength(1)
    expect(next[0]?.bestLap).toBe(30)
  })

  it('replaces the slower entry for the same handle when faster', () => {
    const seed = [entry('A', 50), entry('B', 60)]
    const { next, result } = mergeEntry(seed, {
      handle: 'B',
      bikeId: 'racer',
      bestLap: 30,
      recordedAt: NOW,
    })
    expect(result.improved).toBe(true)
    expect(result.rank).toBe(1)
    expect(next.map((e) => e.handle)).toEqual(['B', 'A'])
    expect(next.find((e) => e.handle === 'B')?.bestLap).toBe(30)
  })

  it('truncates to MAX_ENTRIES_PER_TRACK', () => {
    const seed: LeaderboardEntry[] = []
    for (let i = 0; i < MAX_ENTRIES_PER_TRACK; i++) {
      seed.push(entry(`H${i}`, 10 + i))
    }
    const { next, result } = mergeEntry(seed, {
      handle: 'SLOW',
      bikeId: 'racer',
      bestLap: 9999,
      recordedAt: NOW,
    })
    expect(result.improved).toBe(true)
    expect(result.rank).toBeNull()
    expect(next).toHaveLength(MAX_ENTRIES_PER_TRACK)
    expect(next.some((e) => e.handle === 'SLOW')).toBe(false)
  })

  it('rejects non-finite bestLap', () => {
    expect(
      mergeEntry([], { handle: 'A', bikeId: 'racer', bestLap: Number.NaN, recordedAt: NOW }),
    ).toMatchObject({ result: { improved: false, rank: null } })
    expect(
      mergeEntry([], { handle: 'A', bikeId: 'racer', bestLap: 0, recordedAt: NOW }),
    ).toMatchObject({ result: { improved: false, rank: null } })
  })

  it('stamps the supplied recordedAt', () => {
    const { next } = mergeEntry([], {
      handle: 'A',
      bikeId: 'racer',
      bestLap: 42,
      recordedAt: 1234,
    })
    expect(next[0]?.recordedAt).toBe(1234)
  })
})

describe('normalizeHandle', () => {
  it('strips invalid chars + uppercases', () => {
    expect(normalizeHandle('abc!@#123')).toBe('ABC123')
  })
  it('clamps to 12 chars', () => {
    expect(normalizeHandle('abcdefghijklmnop')).toBe('ABCDEFGHIJKL')
  })
  it('returns null for empty', () => {
    expect(normalizeHandle('')).toBeNull()
    expect(normalizeHandle('!!!')).toBeNull()
  })
})
