import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PATH_WEAR_INTENSITY,
  DEFAULT_PATH_WEAR_OUTER_M,
  pathWearAtDistance,
} from '../../src/engine/render/path-wear'

/**
 * Mirrors the Python `_self_test` at the bottom of
 * `tools/blender/hoverbike_addon/bake.py`. Any divergence between the
 * two implementations is a future bake regression — keep both green.
 */

describe('pathWearAtDistance', () => {
  it('returns 1 at the racing line (distance 0)', () => {
    expect(pathWearAtDistance(0)).toBe(1)
  })

  it('returns 0 at the outer falloff', () => {
    expect(pathWearAtDistance(DEFAULT_PATH_WEAR_OUTER_M)).toBe(0)
  })

  it('returns 0 past the outer falloff', () => {
    expect(pathWearAtDistance(DEFAULT_PATH_WEAR_OUTER_M + 1)).toBe(0)
  })

  it('returns ~0.5 at the midpoint of the falloff band', () => {
    // Defaults inner=0, outer=8: 4 m is the band midpoint;
    // smoothstep(0.5) = 0.5 exactly.
    expect(pathWearAtDistance(4)).toBeCloseTo(0.5, 9)
  })

  it('saturates within the inner band', () => {
    expect(pathWearAtDistance(0.5, 1, 5)).toBe(1)
    expect(pathWearAtDistance(1, 1, 5)).toBe(1)
  })

  it('scales linearly with intensity', () => {
    expect(pathWearAtDistance(0, 0, 8, 0.4)).toBeCloseTo(0.4, 9)
    expect(pathWearAtDistance(4, 0, 8, 0.5)).toBeCloseTo(0.25, 9)
  })

  it('intensity 0 short-circuits to 0', () => {
    expect(pathWearAtDistance(0, 0, 8, 0)).toBe(0)
  })

  it('degenerate band (outer <= inner) collapses to a hard mask at inner', () => {
    expect(pathWearAtDistance(2, 5, 5)).toBe(1)
    expect(pathWearAtDistance(6, 5, 5)).toBe(0)
    // outer < inner should also act as a hard mask at inner.
    expect(pathWearAtDistance(2, 5, 3)).toBe(1)
    expect(pathWearAtDistance(6, 5, 3)).toBe(0)
  })

  it('clamps runaway intensity into [0, 1]', () => {
    expect(pathWearAtDistance(0, 0, 8, 2)).toBe(1)
    expect(pathWearAtDistance(0, 0, 8, -1)).toBe(0)
  })

  it('is monotone decreasing across the falloff band', () => {
    let last = Number.POSITIVE_INFINITY
    for (let i = 0; i <= 80; i++) {
      const d = i / 10
      const w = pathWearAtDistance(d)
      expect(w).toBeLessThanOrEqual(last + 1e-9)
      last = w
    }
  })

  it('uses DEFAULT_PATH_WEAR_INTENSITY = 1 (full mask by default)', () => {
    expect(DEFAULT_PATH_WEAR_INTENSITY).toBe(1)
    expect(pathWearAtDistance(0)).toBe(pathWearAtDistance(0, 0, 8, 1))
  })
})
