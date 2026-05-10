import { describe, expect, it } from 'vitest'
import type { Vec3 } from '../../src/engine/sim/physics/vec'
import {
  curvatureAheadLooped,
  findClosestIndexLooped,
  lookaheadIndexLooped,
} from '../../src/game/tracks/spline-query'

/**
 * A unit-square loop with one point per corner, all at y = 0:
 *   0: (0, 0)  → 1: (10, 0)  → 2: (10, 10) → 3: (0, 10) → (back to 0)
 */
const square: Vec3[] = [
  { x: 0, y: 0, z: 0 },
  { x: 10, y: 0, z: 0 },
  { x: 10, y: 0, z: 10 },
  { x: 0, y: 0, z: 10 },
]

describe('findClosestIndexLooped', () => {
  it('returns hint when the hint is already correct', () => {
    expect(findClosestIndexLooped(square, 10, 0, 1, 1)).toBe(1)
  })

  it('finds the closest within the window', () => {
    // Position is closest to corner 2 (10, 10). Hint at 1, window 2.
    expect(findClosestIndexLooped(square, 9.9, 9.9, 1, 2)).toBe(2)
  })

  it('wraps around the loop when the hint is near the seam', () => {
    // Actual closest is index 0; hint at 3 (the previous index) with window 2.
    expect(findClosestIndexLooped(square, 0.1, 0.1, 3, 2)).toBe(0)
  })

  it('does not jump outside the window even if a closer point exists', () => {
    // True closest is index 2 (10, 10) but with hint 0 and window 1, the
    // search only covers indices N-1, 0, 1 — should not return 2.
    const result = findClosestIndexLooped(square, 10, 10, 0, 1)
    expect([3, 0, 1]).toContain(result)
  })

  it('uses xz-plane distance, ignoring y', () => {
    const tilted: Vec3[] = [
      { x: 0, y: 100, z: 0 },
      { x: 10, y: -50, z: 0 },
    ]
    // y differences are huge but irrelevant; in xz, (10, 0) is closest.
    expect(findClosestIndexLooped(tilted, 9, 0, 0, 1)).toBe(1)
  })
})

describe('lookaheadIndexLooped', () => {
  it('returns the next index when targetDist is tiny', () => {
    expect(lookaheadIndexLooped(square, 0, 0)).toBe(1)
  })

  it('skips an index when the target overshoots one segment', () => {
    // Each square edge is length 10. Asking for 11m from index 0 should
    // land us at index 2 (after walking 0→1 = 10m, then 1→2 = 10m totalling 20m).
    expect(lookaheadIndexLooped(square, 0, 11)).toBe(2)
  })

  it('lands on the very next index when targetDist equals one segment', () => {
    expect(lookaheadIndexLooped(square, 0, 10)).toBe(1)
  })

  it('wraps around the loop', () => {
    // From index 3, walking 11m: 3→0 = 10m, 0→1 = 10m totalling 20m → index 1.
    expect(lookaheadIndexLooped(square, 3, 11)).toBe(1)
  })

  it('returns startIndex+1 when targetDist exceeds the entire loop', () => {
    // Total perimeter is 40m. Walking 9999m walks all N segments without
    // triggering the inner break — fallback kicks in.
    expect(lookaheadIndexLooped(square, 0, 9999)).toBe(1)
  })
})

describe('curvatureAheadLooped', () => {
  it('reports zero bend along a straight section', () => {
    const straight: Vec3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
    ]
    const { totalBend, scannedDist } = curvatureAheadLooped(straight, 0, 3)
    expect(totalBend).toBeCloseTo(0, 6)
    expect(scannedDist).toBeGreaterThan(0)
  })

  it('captures N-1 transition angles after walking N segments', () => {
    // The first segment initialises the heading reference; subsequent
    // segments each contribute one bend. A closed square has 4 corners
    // but a single N-segment forward scan sees 3 of them (the 4th is
    // the corner the scan started on, before initialisation).
    const { totalBend } = curvatureAheadLooped(square, 0, 1000)
    expect(totalBend).toBeCloseTo(3 * (Math.PI / 2), 5)
  })

  it('captures a single 90° corner as π/2 of bend', () => {
    // From index 1 (end of bottom edge), scan just past the first corner.
    // Bend between segment 1→2 (going +z) and segment 2→3 (going -x) is π/2.
    const { totalBend } = curvatureAheadLooped(square, 1, 15)
    expect(totalBend).toBeCloseTo(Math.PI / 2, 5)
  })

  it('skips degenerate zero-length segments', () => {
    const withDup: Vec3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 }, // duplicate
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 0, z: 10 },
    ]
    // The duplicate would create a zero-length segment with undefined
    // heading; the helper must skip it so totalBend reflects only the
    // real corner at index 2.
    const { totalBend } = curvatureAheadLooped(withDup, 0, 25)
    // From start (after skipping the dup), heading is +x, then +z at
    // the corner — single π/2 bend before the loop closes.
    expect(totalBend).toBeGreaterThan(0)
    expect(Number.isFinite(totalBend)).toBe(true)
  })
})
