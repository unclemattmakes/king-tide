import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearBestLaps,
  getAllBestLaps,
  getBestLap,
  recordLapTime,
} from '../../src/engine/save-state'

// Polyfill `window.localStorage` for the Vitest node environment. The
// engine module reads/writes via window.localStorage, and we want to
// exercise the real code paths (including JSON parse + key shape) in
// isolation per test.
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

describe('save-state best lap', () => {
  beforeEach(() => {
    installMemoryStorage()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns null when no record exists', () => {
    expect(getBestLap({ trackId: 'lagoon', bikeId: 'racer' })).toBeNull()
  })

  it('records a first lap as a new best', () => {
    expect(recordLapTime({ trackId: 'lagoon', bikeId: 'racer' }, 42.5)).toBe(true)
    expect(getBestLap({ trackId: 'lagoon', bikeId: 'racer' })).toBe(42.5)
  })

  it('only overwrites when the new lap is strictly faster', () => {
    recordLapTime({ trackId: 'lagoon', bikeId: 'racer' }, 42.5)
    expect(recordLapTime({ trackId: 'lagoon', bikeId: 'racer' }, 50)).toBe(false)
    expect(getBestLap({ trackId: 'lagoon', bikeId: 'racer' })).toBe(42.5)
    expect(recordLapTime({ trackId: 'lagoon', bikeId: 'racer' }, 30)).toBe(true)
    expect(getBestLap({ trackId: 'lagoon', bikeId: 'racer' })).toBe(30)
  })

  it('keeps records per (track, bike) combination separate', () => {
    recordLapTime({ trackId: 'lagoon', bikeId: 'racer' }, 42)
    recordLapTime({ trackId: 'cliffside', bikeId: 'stunt' }, 60)
    recordLapTime({ trackId: 'lagoon', bikeId: 'cruiser' }, 50)

    expect(getBestLap({ trackId: 'lagoon', bikeId: 'racer' })).toBe(42)
    expect(getBestLap({ trackId: 'cliffside', bikeId: 'stunt' })).toBe(60)
    expect(getBestLap({ trackId: 'lagoon', bikeId: 'cruiser' })).toBe(50)
    expect(getBestLap({ trackId: 'cliffside', bikeId: 'racer' })).toBeNull()
  })

  it('rejects nonsense numbers', () => {
    expect(recordLapTime({ trackId: 'a', bikeId: 'b' }, NaN)).toBe(false)
    expect(recordLapTime({ trackId: 'a', bikeId: 'b' }, -1)).toBe(false)
    expect(recordLapTime({ trackId: 'a', bikeId: 'b' }, 0)).toBe(false)
    expect(getBestLap({ trackId: 'a', bikeId: 'b' })).toBeNull()
  })

  it('clearBestLaps wipes all records', () => {
    recordLapTime({ trackId: 'lagoon', bikeId: 'racer' }, 42)
    recordLapTime({ trackId: 'cliffside', bikeId: 'stunt' }, 60)
    expect(Object.keys(getAllBestLaps())).toHaveLength(2)
    clearBestLaps()
    expect(Object.keys(getAllBestLaps())).toHaveLength(0)
  })

  it('survives the round-trip serialization', () => {
    recordLapTime({ trackId: 'lagoon', bikeId: 'racer' }, 42.5)
    recordLapTime({ trackId: 'cliffside', bikeId: 'stunt' }, 60.123)
    const all = getAllBestLaps()
    expect(all['lagoon::racer']).toBe(42.5)
    expect(all['cliffside::stunt']).toBe(60.123)
  })
})
