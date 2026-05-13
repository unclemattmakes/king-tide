import type { Vec3 } from '@/engine/sim/physics/vec'
import { pointAtT, tangentAtT } from './catmull-rom'

/**
 * Default gate spacing in metres when a track JSON doesn't specify one.
 *
 * Picked to preserve Lagoon Loop's ~9-gate density while fixing the
 * uneven 42–100m gap variance that uniform-T placement gave it. With a
 * 522m loop arc length, 60m spacing → 9 gates, ~58m apart in metres.
 *
 * Authored in `tracks/<id>.json` as the top-level `gateSpacing` field.
 */
export const DEFAULT_GATE_SPACING_M = 60

export type GatePlacement = {
  /** Parameter along the closed spline in [0, 1). */
  t: number
  /** Position resolved from the spline at `t`. y is taken from the spline. */
  position: Vec3
  /** Tangent direction (xz-unit, y=0). */
  tangent: Vec3
}

/**
 * Resample a closed AI spline polyline by arc length, producing evenly
 * spaced gate placements in metres.
 *
 * Gate **count** is chosen as the integer N ≥ 1 that minimises deviation
 * from the requested spacing — strict-spacing on a closed loop would
 * leave a ragged remainder at the loop closure, which races visibly. The
 * caller asks for ~target, we round to the cleanest fit, gates then
 * land at exactly `length / N` apart along the curve.
 *
 * Algorithm:
 *   1. Compute total xz arc length of the closed polyline. (xz only,
 *      matching the existing AI-spline convention in `spline-query.ts`
 *      and `catmull-rom.pointAtT`.)
 *   2. N = max(1, round(length / targetSpacing)).
 *   3. For each i ∈ [0, N), find the arc-distance i/N * length and
 *      linearly interpolate to its `t` ∈ [0, 1) on the polyline.
 *
 * Sim-safe — no Three.js imports.
 *
 * @param points Closed-loop dense polyline (e.g. `aiSpline.points`).
 *   Treated as looped: segment N-1 → 0 closes the curve.
 * @param targetSpacing Desired gate spacing in metres. Must be > 0.
 * @returns Empty array if `points.length < 2` or the curve has zero
 *   length. Otherwise at least 1 placement; usually
 *   `round(length / targetSpacing)`.
 */
export function resampleByArcLength(
  points: readonly Vec3[],
  targetSpacing: number,
): GatePlacement[] {
  if (points.length < 2) return []
  if (!(targetSpacing > 0)) {
    throw new Error(`resampleByArcLength: targetSpacing must be positive (got ${targetSpacing})`)
  }

  // Cumulative xz arc length at each vertex. cum[i] = length from
  // points[0] to points[i]; cum[n] = total closed-loop length.
  const n = points.length
  const cum = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    const a = points[i]!
    const b = points[(i + 1) % n]!
    cum[i + 1] = cum[i]! + Math.hypot(b.x - a.x, b.z - a.z)
  }
  const total = cum[n]!
  if (total === 0) return []

  const gateCount = Math.max(1, Math.round(total / targetSpacing))
  const placements: GatePlacement[] = []
  const writable = points as Vec3[]

  let segIdx = 0
  for (let i = 0; i < gateCount; i++) {
    const targetDist = (i / gateCount) * total
    // Advance segIdx to the segment whose end is ≥ targetDist. Cap at
    // n-1 — that's the loop-closing segment from points[n-1] to
    // points[0], which `pointAtT` parameterises as t ∈ [(n-1)/n, 1).
    while (segIdx < n - 1 && cum[segIdx + 1]! < targetDist) {
      segIdx++
    }
    const segStart = cum[segIdx]!
    const segLen = cum[segIdx + 1]! - segStart
    const frac = segLen > 0 ? (targetDist - segStart) / segLen : 0
    // (segIdx, frac) → t. pointAtT/tangentAtT use t * n as the polyline
    // float index, so the inverse is (i + frac) / n.
    const t = (segIdx + frac) / n
    placements.push({
      t,
      position: pointAtT(writable, t),
      tangent: tangentAtT(writable, t),
    })
  }

  return placements
}
