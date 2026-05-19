/**
 * AI pump-hint binding — Phase A gap 7 of `docs/v1-asset-pipeline-plan.md`.
 *
 * Walks an AI spline against the track's wave-zone list and flags the
 * spline indices that lie inside a "heavy" zone (any zone whose
 * `heightMult` clears the configurable threshold — default 1.2, matching
 * the plan's prose). The AI controller reads the resulting boolean array
 * each tick: when the AI's current spline cursor is on a flagged index,
 * the controller samples the local surface vy and — if the swell is
 * rising hard enough — drives a brief pitch-up pump input.
 *
 * This is the simpler derivation called out in gap 7: "derive
 * automatically from spline proximity to `wave_zone_NN` empties with
 * `height_mult > 1.2`". No new authoring surface is required; the same
 * wave-zone authoring that already shipped in Phase A drives this.
 *
 * Pure module — no Three.js, no physics. The XZ OBB test mirrors
 * `wave-field.ts::pointInWaveZone3D` but drops the Y gate so spline
 * points authored slightly above/below the zone centre still register.
 * The blend radius is honoured (smoothstep weight > 0 counts as a hint)
 * so the AI starts arming the pump as it enters the soft edge, not just
 * after it's already deep inside the OBB.
 */

import type { Vec3 } from '@/engine/sim/physics/vec'
import type { AISpline, WaveZone } from '@/game/tracks/types'

/** Default minimum `heightMult` for a wave zone to register as a pump
 *  hint. Matches the prose in `v1-asset-pipeline-plan.md` gap 7 —
 *  "height_mult > 1.2". Zones at or below this threshold are treated as
 *  cosmetic amplitude tweaks that don't warrant a pump action. */
export const DEFAULT_MIN_HEIGHT_MULT = 1.2

export type BuildPumpHintsOpts = {
  spline: AISpline
  zones: readonly WaveZone[]
  /** Override `DEFAULT_MIN_HEIGHT_MULT`. Useful for tests or per-difficulty
   *  tuning if a future pass wants hard AI to react to lighter swells. */
  minHeightMult?: number
}

/**
 * Build a per-spline-index boolean array marking which points lie inside
 * any wave zone whose `heightMult` clears the threshold. Includes the
 * blend-radius soft edge so the AI arms its pump as it approaches the
 * zone, not just after it's already deep inside the OBB.
 *
 * Returns an array the same length as `spline.points`. All-false when
 * no zone qualifies — callers can fast-path on that to skip the per-tick
 * cursor check entirely.
 */
export function buildPumpHints(opts: BuildPumpHintsOpts): boolean[] {
  const { spline, zones } = opts
  const minHeightMult = opts.minHeightMult ?? DEFAULT_MIN_HEIGHT_MULT
  const out = new Array<boolean>(spline.points.length).fill(false)
  if (zones.length === 0) return out

  // Pre-extract heavy zones with their yaw cosines so the per-point
  // loop below is allocation-free.
  const heavy: HeavyZone[] = []
  for (const z of zones) {
    if (z.heightMult > minHeightMult) heavy.push(toHeavyZone(z))
  }
  if (heavy.length === 0) return out

  for (let i = 0; i < spline.points.length; i++) {
    const p = spline.points[i]
    if (!p) continue
    for (const z of heavy) {
      if (pointInflated(z, p)) {
        out[i] = true
        break
      }
    }
  }
  return out
}

/** True when any index in the hint array is hot — lets the controller
 *  skip the per-tick lookup on tracks with no heavy zones. */
export function hasAnyHints(hints: readonly boolean[]): boolean {
  for (const h of hints) {
    if (h) return true
  }
  return false
}

// ────────────────────────────────────────────────────────────────────
// Internal — yaw-only OBB-XZ test inflated by the zone's blend radius.
// ────────────────────────────────────────────────────────────────────

type HeavyZone = {
  cx: number
  cz: number
  halfWidth: number
  halfDepth: number
  blendRadius: number
  cosYaw: number
  sinYaw: number
}

function toHeavyZone(z: WaveZone): HeavyZone {
  const yaw = yawFromQuat(z.rotation)
  return {
    cx: z.position.x,
    cz: z.position.z,
    halfWidth: z.halfWidth,
    halfDepth: z.halfDepth,
    blendRadius: z.blendRadiusM,
    cosYaw: Math.cos(yaw),
    sinYaw: Math.sin(yaw),
  }
}

function pointInflated(z: HeavyZone, p: Vec3): boolean {
  const dx = p.x - z.cx
  const dz = p.z - z.cz
  const lx = dx * z.cosYaw + dz * z.sinYaw
  const lz = -dx * z.sinYaw + dz * z.cosYaw
  // Inflated OBB — anywhere within blendRadius of the box surface
  // (smoothstep weight > 0 in `wave-field.ts::zoneWeight`) counts.
  return Math.abs(lx) <= z.halfWidth + z.blendRadius && Math.abs(lz) <= z.halfDepth + z.blendRadius
}

/** World-Y yaw of a quaternion. Mirrors `wave-field.ts::yawFromQuat`
 *  — both modules use the YXZ Euler decomposition's heading term. */
function yawFromQuat(q: { x: number; y: number; z: number; w: number }): number {
  const r02 = 2 * (q.x * q.z + q.y * q.w)
  const r22 = 1 - 2 * (q.x * q.x + q.y * q.y)
  return Math.atan2(r02, r22)
}
