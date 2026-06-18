/**
 * peakCurvatureAheadLooped — the AI braking metric (docs/systems-review.md §7).
 * Peak local curvature must exceed the average when a sharp kink hides inside
 * an otherwise straight scan, so the AI brakes for the worst upcoming point.
 */
import { describe, expect, it } from 'vitest'
import type { Vec3 } from '../../src/engine/sim/physics/vec'
import { curvatureAheadLooped, peakCurvatureAheadLooped } from '../../src/game/tracks/spline-query'

const pt = (x: number, z: number): Vec3 => ({ x, y: 0, z })

describe('peakCurvatureAheadLooped', () => {
  it('is ~zero along a straight run (scan stays short of the loop seam)', () => {
    const pts = [pt(0, 0), pt(0, 10), pt(0, 20), pt(0, 30), pt(0, 40)]
    // Splines are closed loops; a synthetic straight polyline has a sharp
    // wrap seam from the last point back to the first. Scan only the straight
    // interior to assert the straight section reads as zero curvature.
    const { peakCurvature } = peakCurvatureAheadLooped(pts, 0, 25)
    expect(peakCurvature).toBeLessThan(1e-6)
  })

  it('exceeds the average when a sharp kink hides in a long straight', () => {
    // Long straight in +z, then one ~90° kink toward +x, then straight again.
    const pts = [
      pt(0, 0),
      pt(0, 12),
      pt(0, 24),
      pt(0, 36), // sharp turn here
      pt(12, 36),
      pt(24, 36),
      pt(36, 36),
    ]
    const scan = 200
    const { totalBend, scannedDist } = curvatureAheadLooped(pts, 0, scan)
    const avg = totalBend / scannedDist
    const { peakCurvature } = peakCurvatureAheadLooped(pts, 0, scan)
    expect(peakCurvature).toBeGreaterThan(avg)
    expect(peakCurvature).toBeGreaterThan(0)
  })

  it('reports a scanned distance bounded by maxScanDist', () => {
    const pts = [pt(0, 0), pt(0, 10), pt(0, 20), pt(0, 30), pt(0, 40), pt(0, 50)]
    const { scannedDist } = peakCurvatureAheadLooped(pts, 0, 25)
    // Stops walking new start-segments once the accumulated scan passes 25 m.
    expect(scannedDist).toBeGreaterThanOrEqual(25)
    expect(scannedDist).toBeLessThan(45)
  })
})
