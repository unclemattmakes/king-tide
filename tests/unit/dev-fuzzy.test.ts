import { describe, expect, it } from 'vitest'
import { fuzzyScore } from '@/engine/dev/fuzzy'

describe('fuzzyScore', () => {
  it('matches a subsequence (case-insensitive)', () => {
    expect(fuzzyScore('vw', 'Bike viewer')).not.toBeNull()
    expect(fuzzyScore('viewer', 'Bike viewer')).not.toBeNull()
    expect(fuzzyScore('BIKE', 'bike viewer')).not.toBeNull()
  })

  it('returns null when not a subsequence', () => {
    expect(fuzzyScore('zzz', 'Bike viewer')).toBeNull()
    // Order matters: 'w' then 'v' — 'v' never appears after 'w' here.
    expect(fuzzyScore('wv', 'Bike viewer')).toBeNull()
  })

  it('treats an empty query as a neutral match', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
  })

  it('scores a consecutive run better (lower) than a scattered match', () => {
    const run = fuzzyScore('wire', 'wireframe')
    const scattered = fuzzyScore('wire', 'w i r e zz')
    expect(run).not.toBeNull()
    expect(scattered).not.toBeNull()
    expect(run as number).toBeLessThan(scattered as number)
  })

  it('scores a tight contiguous match better than a far-apart one', () => {
    const tight = fuzzyScore('col', 'Collision wireframe')
    const loose = fuzzyScore('col', 'Cancel other lights')
    expect(tight as number).toBeLessThan(loose as number)
  })
})
