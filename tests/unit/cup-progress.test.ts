import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildCupRoster,
  CUP_POINTS,
  type CupFinisher,
  clearCupProgress,
  cupStandings,
  getCupProgress,
  getCupProgressFor,
  isCupComplete,
  nextCupTrackId,
  playerCupStanding,
  pointsForPosition,
  recordCupRaceFinish,
  startCup,
  totalCupPoints,
  trophyForRank,
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

  describe('buildCupRoster', () => {
    it('seeds the player at slot 0 and seven stable rivals', () => {
      const roster = buildCupRoster({ cupId: 'reef', bikeId: 'cruiser' })
      expect(roster).toHaveLength(8)
      expect(roster[0]).toMatchObject({
        slot: 0,
        isPlayer: true,
        name: 'YOU',
        variantId: 'cruiser',
      })
      for (let slot = 1; slot <= 7; slot++) {
        const r = roster[slot]
        expect(r?.slot).toBe(slot)
        expect(r?.isPlayer).toBe(false)
        expect(typeof r?.name).toBe('string')
        expect((r?.name.length ?? 0) > 0).toBe(true)
      }
    })

    it('is deterministic for a given cup (same names every race)', () => {
      const a = buildCupRoster({ cupId: 'reef', bikeId: 'racer' })
      const b = buildCupRoster({ cupId: 'reef', bikeId: 'racer' })
      expect(a.map((r) => r.name)).toEqual(b.map((r) => r.name))
    })

    it('honours an explicit grid size', () => {
      expect(buildCupRoster({ cupId: 'reef', bikeId: 'racer', aiCount: 3 })).toHaveLength(4)
    })
  })

  describe('trophyForRank', () => {
    it('awards gold/silver/bronze to the top three only', () => {
      expect(trophyForRank(1)).toBe('gold')
      expect(trophyForRank(2)).toBe('silver')
      expect(trophyForRank(3)).toBe('bronze')
      expect(trophyForRank(4)).toBeNull()
      expect(trophyForRank(0)).toBeNull()
    })
  })

  describe('recordCupRaceFinish (full field) + cupStandings', () => {
    // Helper: a finisher row per slot for a small 4-rider field.
    const field = (positions: number[], times?: number[]): CupFinisher[] =>
      positions.map((position, slot) => ({
        slot,
        position,
        raceTime: times?.[slot] ?? 30 + position,
      }))

    function seed(): void {
      startCup({
        cupId: 'reef',
        bikeId: 'racer',
        races: ['a', 'b'],
        roster: buildCupRoster({ cupId: 'reef', bikeId: 'racer', aiCount: 3 }),
      })
    }

    it('stores every racer’s finish, not just the player’s', () => {
      seed()
      const p = recordCupRaceFinish({
        cupId: 'reef',
        trackId: 'a',
        position: 1,
        totalRacers: 4,
        raceTime: 31,
        finishers: field([1, 2, 3, 4]),
      })
      expect(p?.results.a?.finishers).toHaveLength(4)
      expect(p?.results.a?.finishers.find((f) => f.slot === 2)?.position).toBe(3)
      // Player mirror still populated for the inline recap.
      expect(p?.results.a?.position).toBe(1)
    })

    it('accumulates points across the cup and ranks the field', () => {
      seed()
      // Player (slot 0) wins both races; slot 1 is runner-up both times.
      recordCupRaceFinish({
        cupId: 'reef',
        trackId: 'a',
        position: 1,
        totalRacers: 4,
        raceTime: 31,
        finishers: field([1, 2, 3, 4]),
      })
      recordCupRaceFinish({
        cupId: 'reef',
        trackId: 'b',
        position: 1,
        totalRacers: 4,
        raceTime: 31,
        finishers: field([1, 2, 3, 4]),
      })
      const p = getCupProgressFor('reef')
      if (!p) throw new Error('expected active cup')
      const table = cupStandings(p)
      expect(table.map((r) => r.identity.slot)).toEqual([0, 1, 2, 3])
      expect(table[0]?.totalPoints).toBe(30) // 15 + 15
      expect(table[0]?.wins).toBe(2)
      expect(table[0]?.rank).toBe(1)
      expect(table[1]?.totalPoints).toBe(24) // 12 + 12
      // Player is the champion → gold.
      const me = playerCupStanding(p)
      expect(me?.rank).toBe(1)
      expect(trophyForRank(me?.rank ?? 0)).toBe('gold')
    })

    it('surfaces an AI champion when the player is off the top step', () => {
      seed()
      // Slot 1 wins both; the player (slot 0) comes 3rd both times.
      recordCupRaceFinish({
        cupId: 'reef',
        trackId: 'a',
        position: 3,
        totalRacers: 4,
        raceTime: 33,
        finishers: field([3, 1, 2, 4]),
      })
      recordCupRaceFinish({
        cupId: 'reef',
        trackId: 'b',
        position: 3,
        totalRacers: 4,
        raceTime: 33,
        finishers: field([3, 1, 2, 4]),
      })
      const p = getCupProgressFor('reef')
      if (!p) throw new Error('expected active cup')
      const table = cupStandings(p)
      expect(table[0]?.identity.slot).toBe(1) // AI rival on top
      expect(table[0]?.identity.isPlayer).toBe(false)
      const me = playerCupStanding(p)
      expect(me?.rank).toBe(3)
      expect(trophyForRank(me?.rank ?? 0)).toBe('bronze')
    })

    it('breaks point ties on race wins, then aggregate time', () => {
      seed()
      // Race a: player 1st, slot1 2nd. Race b: swap. Both end on 27 pts /
      // 1 win — the faster aggregate time wins the tiebreak.
      recordCupRaceFinish({
        cupId: 'reef',
        trackId: 'a',
        position: 1,
        totalRacers: 4,
        raceTime: 40,
        finishers: field([1, 2, 3, 4], [40, 41, 42, 43]),
      })
      recordCupRaceFinish({
        cupId: 'reef',
        trackId: 'b',
        position: 2,
        totalRacers: 4,
        raceTime: 41,
        finishers: field([2, 1, 3, 4], [41, 44, 42, 43]),
      })
      const p = getCupProgressFor('reef')
      if (!p) throw new Error('expected active cup')
      const table = cupStandings(p)
      // slot 0 total time 81 vs slot 1 total time 85 → player wins the tie.
      expect(table[0]?.totalPoints).toBe(table[1]?.totalPoints)
      expect(table[0]?.identity.slot).toBe(0)
    })

    it('falls back to a player-only row for legacy results with no field', () => {
      // Cup seeded without a roster and recorded via the player-only path.
      startCup({ cupId: 'dev-placeholder', bikeId: 'stunt', races: ['lagoon'] })
      recordCupRaceFinish({
        cupId: 'dev-placeholder',
        trackId: 'lagoon',
        position: 2,
        totalRacers: 6,
        raceTime: 55,
      })
      const p = getCupProgressFor('dev-placeholder')
      if (!p) throw new Error('expected active cup')
      const table = cupStandings(p)
      expect(table).toHaveLength(1)
      expect(table[0]?.identity.isPlayer).toBe(true)
      expect(table[0]?.totalPoints).toBe(12) // 2nd place
    })
  })
})
