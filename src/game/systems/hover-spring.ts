/**
 * Multi-point hover spring + underwater buoyancy + the bad-landing /
 * bad-attitude velocity-kill.
 *
 * Split out of `hover.ts` (docs/systems-review.md §4). The per-tick `points`
 * array that the spring iterates is hoisted to a module-level reusable
 * scratch — mirroring the documented `scratchRay` pattern in `hover-probe.ts`
 * — so a 5-bike field doesn't churn 5 four-element arrays + 20 object
 * literals every fixed tick. Single-threaded sim step, so reuse is safe.
 */

import type { BikeStatsData, HoverProbe } from '@/game/components'
import type { SimTuning } from '@/game/sim-step'
import {
  BAD_GROUND_PITCH,
  BAD_LAND_MIN_SPEED,
  BAD_LAND_PITCH,
  BUOYANCY_CAP,
  BUOYANCY_PER_M,
  DIVE_HOVER_HEIGHT_MIN_MUL,
  DRAG_K_HORIZ,
  DRAG_K_RISE,
  DRAG_K_SINK,
  GROUNDED_DISTANCE_MUL,
  MAX_BOW_LIFT_ERROR,
  POINT_MASS_FRAC,
  SLOPE_DAMP_RELIEF,
  SLOPE_HOVER_BOOST,
  SURFACE_FOLLOW_MAX,
  SURFACE_FOLLOW_MIN,
  WATER_SURFACE_FOLLOW,
} from './hover-tuning'
import type { Footprint, HoverFrame, SurfaceProbe } from './hover-types'

/**
 * Map `stats.surfaceFollow` to the water-side longitudinal spring
 * multiplier with a defensive clamp. Pure helper — exported so tests can
 * lock in the variant ordering without spinning up a Rapier world.
 */
export function resolveWaterLongitudinalSpringMul(stats: BikeStatsData): number {
  return Math.max(SURFACE_FOLLOW_MIN, Math.min(SURFACE_FOLLOW_MAX, stats.surfaceFollow))
}

// ============================================================================
// Bad-landing / bad-attitude crash detection
// ============================================================================

/**
 * Two transient checks that kill horizontal velocity so the rider-crash
 * Δv detector can ragdoll next tick. Both LAND-ONLY (water nose-dives are
 * supposed to plough under, not throw the rider) and ANTI-GRAV-EXEMPT
 * (the world-Y pitch they measure isn't meaningful on a tilted road).
 *
 *  1. Bad LANDING: on airborne→grounded transition, chassis is wildly off
 *     the surface contour while moving forward.
 *  2. Continuous bad ATTITUDE: pitch past 75° on the ground. Without this
 *     the multi-point spring's restoring `r × F` torque collapses to zero
 *     (corner-to-CoM displacement parallel to up) and the bike sits
 *     happily nose-down on flat ground.
 */
export function applyBadLandingChecks(
  frame: HoverFrame,
  probe: SurfaceProbe,
  surfaceForwardSlopeRaw: number,
  prevGrounded: boolean,
  isGrounded: boolean,
): void {
  const { rb, linvel, agActive } = frame
  if (probe.isWater || agActive) return
  if (!isGrounded) return

  // Bad landing
  if (!prevGrounded) {
    const qLand = rb.rotation()
    const r12Land = 2 * (qLand.y * qLand.z - qLand.x * qLand.w)
    const pitchLand = Math.asin(Math.max(-1, Math.min(1, -r12Land)))
    // RAW slope — filter is still seeded from zero on the first ground
    // tick after a flight, so the smoothed value would under-report the
    // landing slope.
    const surfacePitchAtLanding = -Math.atan(surfaceForwardSlopeRaw)
    const pitchOffSurface = Math.abs(pitchLand - surfacePitchAtLanding)
    const horizSpeedLand = Math.hypot(linvel.x, linvel.z)
    if (pitchOffSurface > BAD_LAND_PITCH && horizSpeedLand > BAD_LAND_MIN_SPEED) {
      rb.setLinvel({ x: 0, y: linvel.y, z: 0 }, true)
      return
    }
  }

  // Continuous bad attitude
  const qBad = rb.rotation()
  const r12Bad = 2 * (qBad.y * qBad.z - qBad.x * qBad.w)
  const pitchBad = Math.asin(Math.max(-1, Math.min(1, -r12Bad)))
  if (Math.abs(pitchBad) > BAD_GROUND_PITCH) {
    rb.setLinvel({ x: 0, y: linvel.y, z: 0 }, true)
  }
}

// ============================================================================
// Multi-point hover spring
// ============================================================================

type SpringPoint = {
  ox: number
  oy: number
  oz: number
  surfProj: number
  longitudinal: boolean
}

// Reused per-tick spring force-application points (bow, stern, starboard,
// port). Hoisted to module scope (the one hot-loop alloc violation called
// out in §5) — mirrors the `scratchRay` reuse pattern. Single-threaded sim
// step, so overwriting in place each call is safe; the loop fully consumes
// each entry within `applyMultiPointHoverSpring` before returning.
const _springPoints: SpringPoint[] = [
  { ox: 0, oy: 0, oz: 0, surfProj: 0, longitudinal: true },
  { ox: 0, oy: 0, oz: 0, surfProj: 0, longitudinal: true },
  { ox: 0, oy: 0, oz: 0, surfProj: 0, longitudinal: false },
  { ox: 0, oy: 0, oz: 0, surfProj: 0, longitudinal: false },
]

/**
 * Multi-point hover spring. Fires only while grounded. Instead of a
 * single force at CoM, apply 1/4-mass vertical impulses at each of the
 * bow, stern, port, starboard probe positions. Each point's upward
 * force is sized by its LOCAL height error vs the surface below it;
 * differential forces naturally torque the chassis to align with the
 * surface contour — bow dips on flat ground → stronger upward kick at
 * bow → pitch nose-up to neutral; starboard sinks into a wave trough
 * → strong kick on starboard → roll left.
 *
 * Sum of per-point forces equals the old single-point force when all
 * four heights agree, so vertical tuning (hoverSpring, hoverDamp)
 * transfers directly. The alignment torque is a free byproduct of the
 * multi-point geometry — no PD reading orientation.
 *
 * Underwater branch (Wave Race feel) stays single-point: when the bike
 * has dived below the water surface (groundDistance < 0 on water),
 * depth-proportional buoyancy + asymmetric drag take over. Symmetric
 * spring would slam the bike back up the instant it dipped below;
 * instead we let dive momentum carry it under, drag bleeds it off,
 * capped buoyancy walks it back up. Tuning targets a peak depth around
 * 1–2 m on a hard dive.
 *
 * `stats.surfaceFollow` scales the WATER longitudinal spring multiplier
 * (bow + stern only; lateral roll stiffness unchanged). Low values
 * plough through chop; high values follow every crest. See
 * `resolveWaterLongitudinalSpringMul` for the clamp.
 */
export function applyMultiPointHoverSpring(
  frame: HoverFrame,
  footprint: Footprint,
  probe: SurfaceProbe,
  groundDistance: number,
  debugOn: boolean,
  debugCorners: HoverProbe[],
  tuning: SimTuning,
): void {
  const { rb, stats, dt, m, gravity, t, linvel, upX, upY, upZ } = frame

  if (probe.isWater && groundDistance < 0) {
    // Submerged: capped buoyancy + asymmetric drag, single-point.
    const submersion = -groundDistance
    // Asymmetric Y-axis drag: full strength when SINKING (kills dive
    // momentum so the bike actually slows as it reaches max depth),
    // much weaker when RISING so accumulated buoyancy isn't fought by
    // drag on the way up.
    const aBuoy = Math.min(submersion * BUOYANCY_PER_M, BUOYANCY_CAP)
    const speed = Math.hypot(linvel.x, linvel.y, linvel.z)
    const horizDragCoef = -DRAG_K_HORIZ * speed
    const yDragK = linvel.y > 0 ? DRAG_K_RISE : DRAG_K_SINK
    const yDragCoef = -yDragK * speed
    rb.applyImpulse(
      {
        x: linvel.x * horizDragCoef * m * dt,
        y: (gravity + aBuoy + linvel.y * yDragCoef) * m * dt,
        z: linvel.z * horizDragCoef * m * dt,
      },
      true,
    )
    return
  }

  const angv = rb.angvel()
  // Force vs sample length: `probeHalfLength` grows with speed
  // (anticipation reach — sampling the surface ahead helps the bike
  // pre-pitch into climbs). The FORCE arm, though, has to stay at the
  // bike's physical footprint, otherwise the spring's restoring torque
  // on a wheelie scales with speed²: longer arm × bigger height
  // differential on a tilted chassis = wheelies become impossible at
  // top speed. `forceHalfLength` decouples the two — sampling still
  // anticipates, but the impulse is applied at the body's real
  // bow/stern position. Width has no speed anticipation so port /
  // starboard use the physical arm directly.
  const forceHalfLength = tuning.hoverProbeHalfLength
  const halfW = footprint.probeHalfWidth
  // Bow / stern / starboard / port — written into the reused scratch.
  const pBow = _springPoints[0]!
  pBow.ox = footprint.forceFwdX * forceHalfLength
  pBow.oy = footprint.forceFwdY * forceHalfLength
  pBow.oz = footprint.forceFwdZ * forceHalfLength
  pBow.surfProj = footprint.bowProj
  const pStern = _springPoints[1]!
  pStern.ox = -footprint.forceFwdX * forceHalfLength
  pStern.oy = -footprint.forceFwdY * forceHalfLength
  pStern.oz = -footprint.forceFwdZ * forceHalfLength
  pStern.surfProj = footprint.sternProj
  const pStarboard = _springPoints[2]!
  pStarboard.ox = footprint.forceRightX * halfW
  pStarboard.oy = footprint.forceRightY * halfW
  pStarboard.oz = footprint.forceRightZ * halfW
  pStarboard.surfProj = footprint.starboardProj
  const pPort = _springPoints[3]!
  pPort.ox = -footprint.forceRightX * halfW
  pPort.oy = -footprint.forceRightY * halfW
  pPort.oz = -footprint.forceRightZ * halfW
  pPort.surfProj = footprint.portProj
  const points = _springPoints
  // Dive-aid takes the form of a hover-height drop + a rate-limited
  // pitch torque (see DIVE_KICK_DURATION_S); per-corner spring
  // multipliers aren't modulated by dive intent.
  const diveAmount = Math.max(-frame.intent.pitch, 0)
  // Per-bike longitudinal water spring multiplier — sourced from
  // `stats.surfaceFollow` so variants differentiate on chop behaviour.
  const waterLongMul = resolveWaterLongitudinalSpringMul(stats)
  const slopeBoost = probe.isWater ? 0 : Math.abs(footprint.surfaceForwardSlope) * SLOPE_HOVER_BOOST
  // Dive aid: target ride height drops with held pitch-down. Scale is
  // applied BEFORE slopeBoost so the climb-margin reaches its normal
  // value — the dive sinks the level-flight target only.
  const diveHoverMul = 1 - (1 - DIVE_HOVER_HEIGHT_MIN_MUL) * diveAmount
  const effHover = stats.hoverHeight * diveHoverMul + slopeBoost
  const heightErrorCap = MAX_BOW_LIFT_ERROR + slopeBoost
  const groundedCutoff = stats.hoverHeight * GROUNDED_DISTANCE_MUL

  // Bow/stern force direction: zone-up projected onto the bike's
  // sagittal plane (the local Y-Z plane, perpendicular to local +X).
  // On an upright bike `up · forceRight = 0` and this is identity. When
  // the bike is rolled to bank into a lateral slope, zone-up picks up a
  // body-X component — crossed with the bow/stern offset (along body-Z)
  // that becomes a body-Y (yaw) torque, and any forward-slope asymmetry
  // in per-corner lift (bow drags up-slope, stern down-slope) yaws the
  // bike further up-slope. Positive feedback runs the heading to ±90°
  // off the contour line. Projecting kills the coupling exactly while
  // leaving port/starboard's roll authority along zone-up untouched.
  const upDotRight =
    upX * footprint.forceRightX + upY * footprint.forceRightY + upZ * footprint.forceRightZ
  const longFX = upX - upDotRight * footprint.forceRightX
  const longFY = upY - upDotRight * footprint.forceRightY
  const longFZ = upZ - upDotRight * footprint.forceRightZ

  for (let pi = 0; pi < points.length; pi++) {
    const p = points[pi]!
    // Probe point's projection on up = (t + offset) · up.
    const probeProj = (t.x + p.ox) * upX + (t.y + p.oy) * upY + (t.z + p.oz) * upZ
    const localDist = probeProj - p.surfProj
    // Per-corner "locally grounded" gate. The bow probe, with its
    // speed-anticipation reach, projects past a ramp lip before the
    // bike does — past the lip it samples the much lower surface
    // beyond, and a naive heightError would fire a huge DOWNWARD
    // spring force at the bow right at takeoff (the "sticky nose"
    // nose-dive). Skip a corner once its local surface is further
    // than the grounded threshold below it.
    if (localDist > groundedCutoff) continue

    // v at this offset, projected on up:
    //   v_at_point = linvel + (angv × offset)
    //   v_at_point · up = linvel·up + (angv × offset)·up
    const crossX = angv.y * p.oz - angv.z * p.oy
    const crossY = angv.z * p.ox - angv.x * p.oz
    const crossZ = angv.x * p.oy - angv.y * p.ox
    const vAtPointUp =
      linvel.x * upX + linvel.y * upY + linvel.z * upZ + crossX * upX + crossY * upY + crossZ * upZ
    // Damp only the EXCESS upward velocity beyond what a steady climb
    // of this slope requires. On flat ground tangentUpVel=0 and we get
    // legacy "damp any lift-off" behaviour. On a climb at v m/s along a
    // tan(θ) slope, vy must be v·tan(θ) just to stay on the surface;
    // treating that as "lifting off" would let damp (~70 m/s² on a 25°
    // hill at 18 m/s) overwhelm the spring and pin the chassis below
    // hoverHeight — visible as "dragging".
    const horizFwdSpeed =
      linvel.x * footprint.sampleFwdX +
      linvel.y * footprint.sampleFwdY +
      linvel.z * footprint.sampleFwdZ
    const tangentUpVel = probe.isWater
      ? frame.waterSurfaceVy * WATER_SURFACE_FOLLOW
      : horizFwdSpeed * footprint.surfaceForwardSlope * SLOPE_DAMP_RELIEF
    const dampV = Math.max(vAtPointUp - tangentUpVel, 0)

    let aUp: number
    if (probe.isWater && localDist < 0) {
      // Submerged on water — capped buoyancy instead of the stiff
      // spring so a nose-dive actually goes under. Anti-grav can't
      // reach here (probe.isWater is false when probeField is null).
      const submersion = -localDist
      const aBuoy = Math.min(submersion * BUOYANCY_PER_M, BUOYANCY_CAP)
      aUp = gravity + aBuoy - dampV * stats.hoverDamp
    } else {
      // heightError clamped on the positive side (a bow probe looking
      // ahead at a steep slope can read +5m+, which would fire the
      // spring at ~6-8G of corner lift and whip-pitch the chassis sky-
      // ward). Slope-momentum handles the climb signal via the bow /
      // stern projection differential — the clamp only limits the
      // CORNER lift kick.
      const rawHeightError = effHover - localDist
      const heightError = Math.min(rawHeightError, heightErrorCap)
      const springMul = probe.isWater && p.longitudinal ? waterLongMul : 1.0
      aUp = gravity + heightError * stats.hoverSpring * springMul - dampV * stats.hoverDamp
    }
    if (debugOn) {
      const dc = debugCorners[pi]!
      dc.aUp = aUp
      dc.active = true
    }
    // Lift at the probe point's world position. The point location
    // includes the bike's pitch contribution, which is what gives
    // flat-ground attitude restoration (nose-up bike's bow is higher
    // → spring pushes bow DOWN → levels chassis). Bow/stern impulses
    // are routed through the sagittal-plane projection of zone-up
    // (`longFX/Y/Z`, see above) so a rolled-into-the-slope chassis
    // doesn't leak the spring's forward-slope correction into a yaw
    // torque. Port/starboard stay along zone-up so the spring's lateral
    // roll authority is unchanged.
    const fX = p.longitudinal ? longFX : upX
    const fY = p.longitudinal ? longFY : upY
    const fZ = p.longitudinal ? longFZ : upZ
    const impMag = aUp * POINT_MASS_FRAC * m * dt
    rb.applyImpulseAtPoint(
      { x: fX * impMag, y: fY * impMag, z: fZ * impMag },
      { x: t.x + p.ox, y: t.y + p.oy, z: t.z + p.oz },
      true,
    )
  }
}
