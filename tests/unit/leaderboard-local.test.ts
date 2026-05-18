import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __test__,
  clearLeaderboards,
  getEntries,
  getEntryCounts,
  normalizeHandle,
  submitEntry,
} from '../../src/engine/leaderboard/local'

function installMemoryStorage(): void {
  const store = new Map<string, string>()
  const fake: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? (store.get(k) ?? null) : null),
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => {
      store.delete(k)
    },
    setItem: (k, v) => {
      store.set(k, v)
    },
  }
  vi.stubGlobal('window', { localStorage: fake })
}

describe('normalizeHandle', () => {
  it('uppercases + strips invalid characters', () => {
    expect(normalizeHandle('abc!@#123')).toBe('ABC123')
    expect(normalizeHandle('  hello world  ')).toBe('HELLOWORLD')
  })
  it('keeps hyphen + underscore', () => {
    expect(normalizeHandle('ab-cd_ef')).toBe('AB-CD_EF')
  })
  it('clamps to 12 chars', () => {
    expect(normalizeHandle('abcdefghijklmnop')).toBe('ABCDEFGHIJKL')
  })
  it('returns null on empty + non-string', () => {
    expect(normalizeHandle('')).toBeNull()
    expect(normalizeHandle('!@#$%')).toBeNull()
    expect(normalizeHandle(123 as unknown as string)).toBeNull()
  })
})

describe('leaderboard/local', () => {
  beforeEach(() => installMemoryStorage())
  afterEach(() => vi.unstubAllGlobals())

  it('starts empty', () => {
    expect(getEntries('lagoon')).toEqual([])
    expect(getEntryCounts()).toEqual({})
  })

  it('submits the first entry at rank 1', () => {
    const res = submitEntry({ trackId: 'lagoon', handle: 'ABC', bikeId: 'racer', bestLap: 42.5 })
    expect(res).toMatchObject({ rank: 1, improved: true, total: 1 })
    expect(getEntries('lagoon')).toHaveLength(1)
    expect(getEntries('lagoon')[0]).toMatchObject({
      handle: 'ABC',
      bikeId: 'racer',
      bestLap: 42.5,
    })
  })

  it('sorts by bestLap ascending across handles', () => {
    submitEntry({ trackId: 'lagoon', handle: 'A', bikeId: 'racer', bestLap: 50 })
    submitEntry({ trackId: 'lagoon', handle: 'B', bikeId: 'racer', bestLap: 40 })
    const res = submitEntry({ trackId: 'lagoon', handle: 'C', bikeId: 'racer', bestLap: 45 })
    expect(res.rank).toBe(2)
    const entries = getEntries('lagoon')
    expect(entries.map((e) => e.handle)).toEqual(['B', 'C', 'A'])
  })

  it('dedupes by handle — keeps fastest', () => {
    submitEntry({ trackId: 'lagoon', handle: 'ABC', bikeId: 'racer', bestLap: 50 })
    const slower = submitEntry({
      trackId: 'lagoon',
      handle: 'ABC',
      bikeId: 'racer',
      bestLap: 55,
    })
    expect(slower).toMatchObject({ improved: false, total: 1 })
    expect(getEntries('lagoon')).toHaveLength(1)
    expect(getEntries('lagoon')[0]?.bestLap).toBe(50)

    const faster = submitEntry({
      trackId: 'lagoon',
      handle: 'ABC',
      bikeId: 'racer',
      bestLap: 45,
    })
    expect(faster).toMatchObject({ improved: true, total: 1 })
    expect(getEntries('lagoon')[0]?.bestLap).toBe(45)
  })

  it('normalizes the handle before insert', () => {
    submitEntry({ trackId: 'lagoon', handle: 'abc!', bikeId: 'racer', bestLap: 30 })
    expect(getEntries('lagoon')[0]?.handle).toBe('ABC')
  })

  it("falls back to 'YOU' for unusable handles", () => {
    submitEntry({ trackId: 'lagoon', handle: '!!!', bikeId: 'racer', bestLap: 30 })
    expect(getEntries('lagoon')[0]?.handle).toBe('YOU')
  })

  it('keeps tracks separate', () => {
    submitEntry({ trackId: 'lagoon', handle: 'A', bikeId: 'racer', bestLap: 30 })
    submitEntry({ trackId: 'cliffside', handle: 'A', bikeId: 'racer', bestLap: 60 })
    expect(getEntries('lagoon')[0]?.bestLap).toBe(30)
    expect(getEntries('cliffside')[0]?.bestLap).toBe(60)
    expect(getEntryCounts()).toEqual({ lagoon: 1, cliffside: 1 })
  })

  it('truncates to MAX_ENTRIES_PER_TRACK', () => {
    const max = __test__.MAX_ENTRIES_PER_TRACK
    for (let i = 0; i < max + 5; i++) {
      submitEntry({
        trackId: 'lagoon',
        // Distinct handles so each lands as its own row.
        handle: `H${i}`,
        bikeId: 'racer',
        bestLap: 100 - i, // later submissions are faster
      })
    }
    expect(getEntries('lagoon')).toHaveLength(max)
    // Fastest entry rank 1 should be the very last submission.
    expect(getEntries('lagoon')[0]?.handle).toBe(`H${max + 4}`)
  })

  it('returns rank=null when a submission falls off the truncated end', () => {
    const max = __test__.MAX_ENTRIES_PER_TRACK
    // Seed `max` very fast laps.
    for (let i = 0; i < max; i++) {
      submitEntry({ trackId: 'lagoon', handle: `H${i}`, bikeId: 'racer', bestLap: 10 + i })
    }
    // A new slow entry from a fresh handle should be dropped.
    const res = submitEntry({
      trackId: 'lagoon',
      handle: 'SLOW',
      bikeId: 'racer',
      bestLap: 9999,
    })
    expect(res.improved).toBe(true)
    expect(res.rank).toBeNull()
    expect(getEntries('lagoon')).toHaveLength(max)
    expect(getEntries('lagoon').some((e) => e.handle === 'SLOW')).toBe(false)
  })

  it('rejects invalid bestLap', () => {
    expect(
      submitEntry({ trackId: 'lagoon', handle: 'A', bikeId: 'racer', bestLap: 0 }),
    ).toMatchObject({ rank: null, improved: false })
    expect(
      submitEntry({ trackId: 'lagoon', handle: 'A', bikeId: 'racer', bestLap: -1 }),
    ).toMatchObject({ rank: null, improved: false })
    expect(
      submitEntry({ trackId: 'lagoon', handle: 'A', bikeId: 'racer', bestLap: Number.NaN }),
    ).toMatchObject({ rank: null, improved: false })
    expect(getEntries('lagoon')).toEqual([])
  })

  it('clearLeaderboards wipes every track', () => {
    submitEntry({ trackId: 'lagoon', handle: 'A', bikeId: 'racer', bestLap: 30 })
    submitEntry({ trackId: 'cliffside', handle: 'B', bikeId: 'racer', bestLap: 60 })
    clearLeaderboards()
    expect(getEntries('lagoon')).toEqual([])
    expect(getEntries('cliffside')).toEqual([])
    expect(getEntryCounts()).toEqual({})
  })

  it('survives a corrupt store payload', () => {
    window.localStorage.setItem(__test__.STORAGE_KEY, 'not even json')
    expect(getEntries('lagoon')).toEqual([])
    // And a fresh write succeeds.
    const res = submitEntry({ trackId: 'lagoon', handle: 'A', bikeId: 'racer', bestLap: 30 })
    expect(res).toMatchObject({ rank: 1, improved: true })
  })
})
