import { describe, expect, it } from 'vitest'

import {
  defaultPool,
  levelPlaylist,
  makeShuffleOrder,
  menuPlaylist,
  reshuffleAvoiding,
  type SoundtrackEntry,
} from '../../src/engine/audio/soundtrack'
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

  it('only carries well-formed scene tags', () => {
    // Guards a playlists.json typo baking a tag no resolver can ever match,
    // which would silently drop the song out of every scene it meant to join.
    for (const entry of SOUNDTRACK) {
      for (const tag of entry.scenes ?? []) {
        expect(tag === 'menu' || /^level:[a-z0-9-]+$/.test(tag)).toBe(true)
      }
    }
  })
})

describe('scene playlists', () => {
  /** Fixture entry — the licence fields are required on `SoundtrackEntry`
   *  but irrelevant to scene resolution, so fill them once here and let the
   *  cases below say only what they're actually about. */
  const entry = (file: string, scenes?: string[]): SoundtrackEntry => ({
    file,
    artist: file.slice(0, 1).toUpperCase(),
    title: file.replace('.opus', ''),
    license: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    sourceUrl: 'https://example.test/',
    ...(scenes ? { scenes } : {}),
  })

  const fixture: SoundtrackEntry[] = [
    entry('a.opus', ['menu']),
    entry('b.opus', ['menu', 'level:liberty-drowned']),
    entry('c.opus', ['level:liberty-drowned']),
    entry('d.opus'), // unscoped → default pool
    entry('e.opus', []), // empty → default pool
  ]

  it('defaultPool is the unscoped songs', () => {
    expect(defaultPool(fixture).map((e) => e.file)).toEqual(['d.opus', 'e.opus'])
  })

  it('menuPlaylist is the menu-tagged songs', () => {
    expect(menuPlaylist(fixture).map((e) => e.file)).toEqual(['a.opus', 'b.opus'])
  })

  it('levelPlaylist is the songs tagged for that level (multi-scene song included)', () => {
    expect(levelPlaylist(fixture, 'liberty-drowned').map((e) => e.file)).toEqual([
      'b.opus',
      'c.opus',
    ])
  })

  it('a level with no specific assignment falls back to the default pool', () => {
    expect(levelPlaylist(fixture, 'aqualand').map((e) => e.file)).toEqual(['d.opus', 'e.opus'])
  })

  it('falls back to the full set when every song is scoped (never silent)', () => {
    const allScoped = [entry('x.opus', ['menu']), entry('y.opus', ['level:foo'])]
    // No unscoped songs → default pool is the whole set, so an unassigned
    // level still gets music instead of silence.
    expect(levelPlaylist(allScoped, 'unassigned')).toHaveLength(2)
    expect(defaultPool(allScoped)).toHaveLength(2)
  })

  it('with no tags anywhere, every scene gets the full shuffle (back-compat)', () => {
    // The no-playlists.json case: behaviour identical to before scenes existed.
    const untagged = [entry('p.opus'), entry('q.opus')]
    expect(menuPlaylist(untagged)).toHaveLength(2)
    expect(levelPlaylist(untagged, 'anything')).toHaveLength(2)
  })

  it('resolvers never mutate or alias the input array', () => {
    const before = [...fixture]
    defaultPool(fixture)
    menuPlaylist(fixture)
    levelPlaylist(fixture, 'liberty-drowned')
    expect(fixture).toEqual(before)
    expect(defaultPool(fixture)).not.toBe(fixture)
  })
})
