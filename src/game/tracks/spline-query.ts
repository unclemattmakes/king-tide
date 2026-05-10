import type { Vec3 } from '@/engine/sim/physics/vec'

/**
 * Pure query helpers for AI splines (closed polylines in top-down xz).
 *
 * Splines passed to these functions are treated as **looped** — index N
 * wraps to 0. Vertical (y) is intentionally ignored: AI follows the line
 * in the xz plane and lets the hover system handle altitude.
 *
 * Extracted from ai-control.ts so the same primitives can be reused by
 * the track editor, debug overlays, and unit tests.
 */

/** Squared xz-plane distance between a spline point and a position. */
function distXZSquared(p: Vec3, x: number, z: number): number {
  const dx = p.x - x
  const dz = p.z - z
  return dx * dx + dz * dz
}

/**
 * Find the index of the closest spline point to (x, z), searching only
 * within ±`window` indices of `hintIndex`. Pass the previous tick's
 * closest index as the hint so an AI moving along the spline amortises
 * the search to O(window) per call.
 *
 * Wraps around the loop. If the AI somehow jumps far from the spline,
 * the returned index will only be the closest *within the window* — not
 * the globally closest. That's the trade-off; in practice bikes don't
 * teleport.
 */
export function findClosestIndexLooped(
  points: readonly Vec3[],
  x: number,
  z: number,
  hintIndex: number,
  window: number,
): number {
  const n = points.length
  let bestIdx = hintIndex
  let bestDist = Number.POSITIVE_INFINITY
  for (let i = -window; i <= window; i++) {
    const idx = (hintIndex + i + n) % n
    const d = distXZSquared(points[idx]!, x, z)
    if (d < bestDist) {
      bestDist = d
      bestIdx = idx
    }
  }
  return bestIdx
}

/**
 * Walk forward (in index order) along a closed spline from `startIndex`,
 * summing xz-plane segment lengths, until we've covered at least
 * `targetDist` meters. Returns the index reached.
 *
 * If `targetDist` exceeds the loop's total length, returns
 * `(startIndex + 1) % n` as a safe fallback — matches the prior inline
 * implementation in ai-control.ts.
 */
export function lookaheadIndexLooped(
  points: readonly Vec3[],
  startIndex: number,
  targetDist: number,
): number {
  const n = points.length
  let cumulative = 0
  for (let i = 0; i < n; i++) {
    const a = points[(startIndex + i) % n]!
    const b = points[(startIndex + i + 1) % n]!
    cumulative += Math.hypot(b.x - a.x, b.z - a.z)
    if (cumulative >= targetDist) {
      return (startIndex + i + 1) % n
    }
  }
  return (startIndex + 1) % n
}

/**
 * Walk forward from `startIndex` summing arc length until either the
 * whole loop has been scanned or `maxScanDist` meters have been covered.
 * Sum the absolute heading-change angle between consecutive segments.
 *
 * Returned curvature (1/m) is `totalBend / scannedDist`. A long shallow
 * arc and a sharp single jog with the same integrated bend register the
 * same way, which matches how the AI experiences upcoming corners.
 *
 * Segments shorter than 1e-6m are skipped (degenerate / duplicate points)
 * so they don't contribute spurious zero-length headings.
 */
export function curvatureAheadLooped(
  points: readonly Vec3[],
  startIndex: number,
  maxScanDist: number,
): { totalBend: number; scannedDist: number } {
  const n = points.length
  let scanned = 0
  let totalBend = 0
  let prevDx = 0
  let prevDz = 0
  let initialized = false
  for (let i = 0; i < n && scanned < maxScanDist; i++) {
    const a = points[(startIndex + i) % n]!
    const b = points[(startIndex + i + 1) % n]!
    const segDx = b.x - a.x
    const segDz = b.z - a.z
    const segLen = Math.hypot(segDx, segDz)
    if (segLen < 1e-6) continue
    if (initialized) {
      const cross = prevDx * segDz - prevDz * segDx
      const dot = prevDx * segDx + prevDz * segDz
      totalBend += Math.abs(Math.atan2(cross, dot))
    }
    prevDx = segDx
    prevDz = segDz
    initialized = true
    scanned += segLen
  }
  return { totalBend, scannedDist: scanned }
}
