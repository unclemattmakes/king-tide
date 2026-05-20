/**
 * Spline math for the track editor.
 *
 * The editor surfaces two flavours of main spline:
 *   - Catmull-Rom-anchored splines, where `anchors` is the user-facing
 *     control set and `points` is the dense runtime sample.
 *   - Legacy polyline splines, where `points` is the only data.
 *
 * `editableSplinePoints` returns whichever array the user should manipulate.
 * `recomputeSplineDerived` resamples the dense `points` (if anchored) and
 * repositions any splineT-bound gates to follow the new curve.
 *
 * The geometry helpers `nearestAnchorInsertIndex` / `distToSegmentXZ` are
 * used by +Spline-pt placement so the inserted anchor falls into the
 * segment closest to the click.
 *
 * Extracted from `track-editor.ts` to keep the orchestrator focused on
 * gizmo + I/O wiring.
 */

import type { Vec3 } from '@/engine/sim/physics/vec'
import { pointAtT, sampleCatmullRom, tangentAtT } from '@/game/tracks/catmull-rom'
import type { Track } from '@/game/tracks/types'

/**
 * Returns the "editable" array of the main spline:
 *  - For Catmull-Rom-anchored splines, that's `anchors`.
 *  - For legacy polyline splines, that's `points`.
 * The dense `points` is always the runtime-consumed output; anchors
 * are the user-facing controls.
 */
export function editableSplinePoints(draft: Track): Vec3[] {
  const main = draft.aiSplines.find((s) => s.id === 'main')
  if (!main) return []
  return main.anchors ?? main.points
}

/**
 * Resample the main spline (if anchored) and reposition any
 * splineT-bound gates (and the player start, if bound) to match. Called
 * whenever an anchor moves or a bound entity's splineT changes.
 */
export function recomputeSplineDerived(draft: Track): void {
  const main = draft.aiSplines.find((s) => s.id === 'main')
  if (!main) return
  if (main.anchors && main.anchors.length >= 2) {
    main.points = sampleCatmullRom(main.anchors, {
      divisionsPerSegment: 12,
      closed: true,
    })
  }
  for (const cp of draft.checkpoints) {
    if (typeof cp.splineT === 'number') {
      const p = pointAtT(main.points, cp.splineT)
      const tan = tangentAtT(main.points, cp.splineT)
      cp.position.x = p.x
      cp.position.z = p.z
      const yaw = Math.atan2(tan.x, tan.z)
      const halfA = yaw / 2
      cp.rotation = { x: 0, y: Math.sin(halfA), z: 0, w: Math.cos(halfA) }
    }
  }
  if (typeof draft.start.splineT === 'number') {
    const p = pointAtT(main.points, draft.start.splineT)
    const tan = tangentAtT(main.points, draft.start.splineT)
    draft.start.position.x = p.x
    draft.start.position.z = p.z
    draft.start.yaw = Math.atan2(tan.x, tan.z)
  }
}

/**
 * Find the index at which a new anchor should be inserted into
 * `anchors` so the curve passes through the click as naturally as
 * possible. Picks the segment whose midpoint is closest to the click.
 */
export function nearestAnchorInsertIndex(hit: { x: number; z: number }, anchors: Vec3[]): number {
  if (anchors.length === 0) return 0
  let bestI = anchors.length
  let bestD = Infinity
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!
    const b = anchors[(i + 1) % anchors.length]!
    const d = distToSegmentXZ(hit.x, hit.z, a.x, a.z, b.x, b.z)
    if (d < bestD) {
      bestD = d
      bestI = i + 1
    }
  }
  return bestI
}

export function distToSegmentXZ(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax
  const dz = bz - az
  const len2 = dx * dx + dz * dz
  if (len2 === 0) return Math.hypot(px - ax, pz - az)
  let t = ((px - ax) * dx + (pz - az) * dz) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx
  const cz = az + t * dz
  return Math.hypot(px - cx, pz - cz)
}
