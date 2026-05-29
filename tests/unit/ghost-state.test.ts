import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPLAY_VERSION, type ReplayFile, serializeReplay } from '../../src/engine/replay/format'
import {
  clearGhosts,
  getGhost,
  getGhostBestLap,
  setGhost,
} from '../../src/engine/replay/ghost-state'

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

function buildGhost(bestLap: number, trackId = 'lagoon'): ReplayFile {
  return {
    version: REPLAY_VERSION,
    meta: {
      trackId,
      trackName: 'Lagoon Loop',
      recordedAt: '2026-05-17T00:00:00.000Z',
      durationSeconds: bestLap,
      finishPosition: null,
      finishTime: null,
      bestLap,
    },
    bikes: [
      {
        slot: 0,
        isPlayer: true,
        variantId: 'racer',
        displayName: 'Racer',
        bodyColor: 0x336699,
      },
    ],
    sampleRateHz: 30,
    frames: [
      { t: 0, bikes: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0] },
      { t: bestLap, bikes: [10, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0] },
    ],
    events: [],
    missiles: [],
    explosions: [],
    isLegacyV1: false,
  }
}

describe('ghost-state', () => {
  beforeEach(() => installMemoryStorage())
  afterEach(() => vi.unstubAllGlobals())

  it('returns null when no ghost is saved', () => {
    expect(getGhost({ trackId: 'lagoon', bikeId: 'racer' })).toBeNull()
    expect(getGhostBestLap({ trackId: 'lagoon', bikeId: 'racer' })).toBeNull()
  })

  it('round-trips a ghost through set/get', () => {
    const ghost = buildGhost(42.5)
    expect(setGhost({ trackId: 'lagoon', bikeId: 'racer' }, ghost)).toBe(true)
    const loaded = getGhost({ trackId: 'lagoon', bikeId: 'racer' })
    expect(loaded).not.toBeNull()
    expect(loaded!.meta.bestLap).toBe(42.5)
    expect(loaded!.frames).toHaveLength(2)
  })

  it('overwrites the ghost on a fresh setGhost', () => {
    setGhost({ trackId: 'lagoon', bikeId: 'racer' }, buildGhost(42.5))
    setGhost({ trackId: 'lagoon', bikeId: 'racer' }, buildGhost(35))
    expect(getGhostBestLap({ trackId: 'lagoon', bikeId: 'racer' })).toBe(35)
  })

  it('keeps ghosts per (track, bike) combination separate', () => {
    setGhost({ trackId: 'lagoon', bikeId: 'racer' }, buildGhost(42, 'lagoon'))
    setGhost({ trackId: 'cliffside', bikeId: 'stunt' }, buildGhost(60, 'cliffside'))
    expect(getGhostBestLap({ trackId: 'lagoon', bikeId: 'racer' })).toBe(42)
    expect(getGhostBestLap({ trackId: 'cliffside', bikeId: 'stunt' })).toBe(60)
    expect(getGhostBestLap({ trackId: 'lagoon', bikeId: 'stunt' })).toBeNull()
  })

  it('drops corrupt payloads silently', () => {
    // Plant junk directly into the underlying store so getGhost has to
    // recover.
    window.localStorage.setItem(
      'hoverbike.ghosts.v1',
      JSON.stringify({ 'lagoon::racer': '{not even valid json' }),
    )
    expect(getGhost({ trackId: 'lagoon', bikeId: 'racer' })).toBeNull()
    // And the corrupt entry should have been deleted on read.
    expect(getGhost({ trackId: 'lagoon', bikeId: 'racer' })).toBeNull()
  })

  it('parses an unrelated track without colliding', () => {
    const raw = serializeReplay(buildGhost(50, 'cliffside'))
    window.localStorage.setItem('hoverbike.ghosts.v1', JSON.stringify({ 'cliffside::stunt': raw }))
    const loaded = getGhost({ trackId: 'cliffside', bikeId: 'stunt' })
    expect(loaded?.meta.trackId).toBe('cliffside')
    expect(getGhost({ trackId: 'lagoon', bikeId: 'racer' })).toBeNull()
  })

  it('clearGhosts wipes the entire store', () => {
    setGhost({ trackId: 'lagoon', bikeId: 'racer' }, buildGhost(42))
    setGhost({ trackId: 'cliffside', bikeId: 'stunt' }, buildGhost(60))
    clearGhosts()
    expect(getGhost({ trackId: 'lagoon', bikeId: 'racer' })).toBeNull()
    expect(getGhost({ trackId: 'cliffside', bikeId: 'stunt' })).toBeNull()
  })
})
