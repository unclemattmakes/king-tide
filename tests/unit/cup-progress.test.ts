import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CUP_POINTS,
  clearCupProgress,
  getCupProgress,
  getCupProgressFor,
  isCupComplete,
  nextCupTrackId,
  pointsForPosition,
  recordCupRaceFinish,
  startCup,
  totalCupPoints,
} from '../../src/engine/cup-progress'

// Minimal sessionStorage polyfill for the vitest node env. The module
// reads/writes via window.sessionStorage; we want to exercise the real
// JSON round-trip + key shape per test.
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
  vi.stubGlobal('window', { sessionStorage: fake })
}

describe('cup-progress', () => {
  beforeEach(() => {
    installMemoryStorage()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('pointsForPosition', () => {
    it('returns the MK-style point curve for 1st through 12th', () => {
      expect(pointsForPosition(1)).toBe(15)
      expect(pointsForPosition(2)).toBe(12)
      expect(pointsForPosition(3)).toBe(10)
      expect(pointsForPosition(8)).toBe(5)
      expect(pointsForPosition(12)).toBe(1)
    })
    it('returns 0 for null / DNF / out-of-range positions', () => {
      expect(pointsForPosition(null)).toBe(0)
      expect(pointsForPosition(0)).toBe(0)
      expect(pointsForPosition(-3)).toBe(0)
      expect(pointsForPosition(13)).toBe(0)
      expect(pointsForPosition(Number.NaN)).toBe(0)
    })
    it('CUP_POINTS table length covers the v1 8-bike grid with headroom', () => {
      expect(CUP_POINTS.length).toBeGreaterThanOrEqual(9)
    })
  })

  describe('startCup / getCupProgress', () => {
    it('returns null before any cup has started', () => {
      expect(getCupProgress()).toBeNull()
    })

    it('seeds a fresh cup with zeroed counters', () => {
      const p = startCup({
        cupId: 'dev-placeholder',
        bikeId: 'racer',
        races: ['lagoon', 'cliffside', 'big-bay'],
      })
      expect(p.cupId).toBe('dev-placeholder')
      expect(p.bikeId).toBe('racer')
      expect(p.races).toEqual(['lagoon', 'cliffside', 'big-bay'])
      expect(p.currentRaceIndex).toBe(0)
      expect(p.results).toEqual({})
      expect(p.startedAt).toBeTypeOf('number')
    })

    it('round-trips through sessionStorage', () => {
      startCup({ cupId: 'dev-placeholder', bikeId: 'racer', races: ['lagoon', 'cliffside'] })
      const reloaded = getCupProgress()
      expect(reloaded?.cupId).toBe('dev-placeholder')
      expect(reloaded?.races).toEqual(['lagoon', 'cliffside'])
    })

    it('overwrites any prior in-progress cup', () => {
      startCup({ cupId: 'reef', bikeId: 'cruiser', races: ['a', 'b'] })
      startCup({ cupId: 'dev-placeholder', bikeId: 'racer', races: ['lagoon'] })
      expect(getCupProgress()?.cupId).toBe('dev-placeholder')
    })
  })

  describe('getCupProgressFor', () => {
    it('returns the active cup when ids match', () => {
      startCup({ cupId: 'dev-placeholder', bikeId: 'racer', races: ['lagoon'] })
      expect(getCupProgressFor('dev-placeholder')?.cupId).toBe('dev-placeholder')
    })
    it('rejects mismatched cup ids — guards against stale `?cup=` urls', () => {
      startCup({ cupId: 'dev-placeholder', bikeId: 'racer', races: ['lagoon'] })
      expect(getCupProgressFor('reef')).toBeNull()
    })
  })

  describe('recordCupRaceFinish + nextCupTrackId', () => {
    it('records a finish and advances the pointer', () => {
      startCup({
        cupId: 'dev-placeholder',
        bikeId: 'racer',
        races: ['lagoon', 'cliffside', 'big-bay'],
      })
      const p1 = recordCupRaceFinish({
        cupId: 'dev-placeholder',
        trackId: 'lagoon',
        position: 1,
        totalRacers: 5,
        raceTime: 42.5,
      })
      if (!p1) throw new Error('expected recordCupRaceFinish to return progress')
      expect(p1.currentRaceIndex).toBe(1)
      expect(p1.results.lagoon?.position).toBe(1)
      expect(nextCupTrackId(p1)).toBe('cliffside')
    })

    it('retrying a finished race updates the result but does not un-skip', () => {
      startCup({
        cupId: 'dev-placeholder',
        bikeId: 'racer',
        races: ['lagoon', 'cliffside', 'big-bay'],
      })
      recordCupRaceFinish({
        cupId: 'dev-placeholder',
        trackId: 'lagoon',
        position: 4,
        totalRacers: 5,
        raceTime: 60,
      })
      // Now retry lagoon and finish 1st.
      const p = recordCupRaceFinish({
        cupId: 'dev-placeholder',
        trackId: 'lagoon',
        position: 1,
        totalRacers: 5,
        raceTime: 42.5,
      })
      expect(p?.results.lagoon?.position).toBe(1)
      // Pointer stays at race 2 — we already advanced past lagoon.
      expect(p?.currentRaceIndex).toBe(1)
    })

    it('ignores finishes for tracks not in the cup roster', () => {
      startCup({
        cupId: 'dev-placeholder',
        bikeId: 'racer',
        races: ['lagoon', 'cliffside'],
      })
      const p = recordCupRaceFinish({
        cupId: 'dev-placeholder',
        trackId: 'big-bay',
        position: 1,
        totalRacers: 5,
        raceTime: 30,
      })
      expect(p?.currentRaceIndex).toBe(0)
      expect(p?.results).toEqual({})
    })

    it('returns null when called against the wrong cup id', () => {
      startCup({ cupId: 'dev-placeholder', bikeId: 'racer', races: ['lagoon'] })
      const p = recordCupRaceFinish({
        cupId: 'reef',
        trackId: 'lagoon',
        position: 1,
        totalRacers: 5,
        raceTime: 30,
      })
      expect(p).toBeNull()
    })
  })

  describe('isCupComplete + totalCupPoints', () => {
    it('flags a cup as complete only after every race has a result', () => {
      const p = startCup({
        cupId: 'dev-placeholder',
        bikeId: 'racer',
        races: ['lagoon', 'cliffside'],
      })
      expect(isCupComplete(p)).toBe(false)
      recordCupRaceFinish({
        cupId: 'dev-placeholder',
        trackId: 'lagoon',
        position: 1,
        totalRacers: 5,
        raceTime: 40,
      })
      const after = recordCupRaceFinish({
        cupId: 'dev-placeholder',
        trackId: 'cliffside',
        position: 2,
        totalRacers: 5,
        raceTime: 55,
      })
      if (!after) throw new Error('expected recordCupRaceFinish to return progress')
      expect(isCupComplete(after)).toBe(true)
      expect(nextCupTrackId(after)).toBeNull()
    })

    it('sums points across every recorded race', () => {
      startCup({
        cupId: 'dev-placeholder',
        bikeId: 'racer',
        races: ['lagoon', 'cliffside', 'big-bay'],
      })
      recordCupRaceFinish({
        cupId: 'dev-placeholder',
        trackId: 'lagoon',
        position: 1, // 15
        totalRacers: 5,
        raceTime: 40,
      })
      recordCupRaceFinish({
        cupId: 'dev-placeholder',
        trackId: 'cliffside',
        position: 3, // 10
        totalRacers: 5,
        raceTime: 55,
      })
      const p = recordCupRaceFinish({
        cupId: 'dev-placeholder',
        trackId: 'big-bay',
        position: 4, // 9
        totalRacers: 5,
        raceTime: 60,
      })
      if (!p) throw new Error('expected recordCupRaceFinish to return progress')
      expect(totalCupPoints(p)).toBe(15 + 10 + 9)
    })
  })

  describe('clearCupProgress', () => {
    it('wipes the active cup', () => {
      startCup({ cupId: 'dev-placeholder', bikeId: 'racer', races: ['lagoon'] })
      clearCupProgress()
      expect(getCupProgress()).toBeNull()
    })
  })
})
