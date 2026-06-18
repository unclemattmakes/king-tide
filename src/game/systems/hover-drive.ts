/**
 * The grounded drive branch + its pure helpers: brake, thrust (with tuck),
 * slope momentum + climb assist + velocity redirect, the dev-flagged wave-
 * feel prototypes, landing-momentum redirect, yaw + fishtail, roll PD,
 * lateral drag, and the trailing anti-grav corrections.
 *
 * Split out of `hover.ts` (docs/systems-review.md §4). The two DEV-FLAGGED
 * P4.2 wave-feel prototype blocks (catch-the-wave + wake drafting) are pulled
 * into one helper (`applyWaveFeelPrototypes`) behind their `WAVE_FEEL` flag so
 * they're shippable / deletable as a unit (§4).
 */

import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate } from '@/engine/sim/physics/vec'
import { surfaceGripMul } from '@/engine/sim/surface-types'
import { sampleWakeFromTrail, type WakeSampleOut } from '@/engine/sim/water/wake-trail'
import type { WaveFieldState } from '@/engine/sim/water/wave-field'
import { BoostMeterStore, DriftStateStore } from '@/game/components'
import { getCurrentBoostMultiplier } from '@/game/systems/pickup'
import {
  AG_ALIGN_D,
  AG_ALIGN_P,
  BRAKE_ACCEL,
  CLIMB_ASSIST_FRAC,
  DEFAULT_GRAVITY,
  DRAFT_GAIN,
  DRAFT_TROUGH_SAT,
  DRIFT_LATERAL_DRAG_SCALE,
  DRIFT_STEER_FRAC,
  DRIFT_YAW_BIAS_FRAC,
  DRIFT_YAW_SPEED_REF,
  INWARD_INITIAL_BIAS_MUL,
  INWARD_INITIAL_WINDOW_S,
  INWARD_TAIL_BIAS_MUL,
  LANDING_REDIRECT_MAX,
  LANDING_REDIRECT_SLOPE_FULL,
  LEAN_BASE,
  LEAN_HIGH_SPEED_BOOST,
  LEAN_SPEED_FULL,
  LEAN_SPEED_HIGH,
  REDIRECT_RATE,
  ROLL_D,
  ROLL_LEAN_LIMIT,
  ROLL_P,
  SLOPE_DOWN_GAIN,
  SLOPE_UP_BRAKE,
  slopeAwareSweetSpot,
  tuckFactor,
  WATER_LATERAL_DRAG_MUL,
  WATER_THRUST_MUL,
  WATER_TURN_MUL,
  WAVE_PUSH_GAIN,
  YAW_PIVOT_FWD,
} from './hover-tuning'
import type { Footprint, HoverFrame, SurfaceProbe } from './hover-types'
import { WAVE_FEEL } from './wave-feel-flags'

// Reused scratch for the P4.2 drafting probe (single-threaded sim step).
const _draftWakeScratch: WakeSampleOut = { y: 0, dydx: 0, dydz: 0 }

/**
 * Marble-on-incline acceleration along the bike's horizontal forward axis.
 * Driven by the terrain-tracking pitch (positive = nose-down on a
 * downslope, zero on flat ground, negative on an upslope). This is the
 * surface signal, NOT the chassis's current pitch — feeding chassis pitch
 * would let the rider pitch the nose down on flat ground and harvest free
 * downhill thrust.
 */
export function slopeMomentumAccel(
  surfacePitchTarget: number,
  gravity: number = DEFAULT_GRAVITY,
  downGain: number = SLOPE_DOWN_GAIN,
  upBrake: number = SLOPE_UP_BRAKE,
): number {
  const gain = surfacePitchTarget > 0 ? downGain : upBrake
  return Math.sin(surfacePitchTarget) * gravity * gain
}

/**
 * Drift yaw signal as a fraction of `stats.turnTorque` (before the
 * water `turnMul`). Pure + exported so the counter-steer-opens
 * behaviour is unit-pinned without a Rapier world.
 *
 * Two terms:
 *  - **auto-turn-in bias** — `driftDir × DRIFT_YAW_BIAS_FRAC`, scaled
 *    by the inward-drift archetype curve and a low-speed taper. This
 *    is what carves the bike into the corner with no input.
 *  - **player steer** — `-steer × DRIFT_STEER_FRAC` at FULL authority
 *    (no speed taper), so counter-steering away from the drift cancels
 *    (or with a sharp flick, slightly reverses) the bias → a wide line,
 *    and steering into the drift tightens it.
 *
 * Sign convention matches the non-drift path (`aTurn = -intent.steer`):
 * a left drift (`driftDir = -1`) yields a positive bias, same as a
 * left steer would.
 */
export function driftYawFraction(
  driftDir: number,
  steer: number,
  chargeS: number,
  driftStyle: 'inward' | 'outward' | undefined,
  speed: number,
): number {
  let archetypeMul = 1
  if (driftStyle === 'inward') {
    archetypeMul =
      chargeS < INWARD_INITIAL_WINDOW_S ? INWARD_INITIAL_BIAS_MUL : INWARD_TAIL_BIAS_MUL
  }
  const speedTaper = Math.max(0, Math.min(1, speed / DRIFT_YAW_SPEED_REF))
  const bias = -driftDir * DRIFT_YAW_BIAS_FRAC * archetypeMul * speedTaper
  const playerInput = -steer * DRIFT_STEER_FRAC
  return bias + playerInput
}

/**
 * P4.2 prototypes (water-next-research §7.6) — DEV-FLAGGED, both default OFF
 * (WAVE_FEEL gains; `?wavepush=` / `?draft=`). Pulled out of the ground branch
 * into one helper so the whole experiment is shippable / deletable as a unit.
 * Playtest gate: these change race balance, so they exist to be FELT, not
 * shipped silently. No-op unless the flags are set.
 */
function applyWaveFeelPrototypes(
  frame: HoverFrame,
  field: WaveFieldState,
  planeFwdX: number,
  planeFwdY: number,
  planeFwdZ: number,
): void {
  const { rb, eid, m, dt } = frame
  // Catch-the-wave momentum: riding WITH the swell on a rising face
  // gets a forward push — slope momentum is direction-blind (the back
  // of a wave pays like the face of one); this keys the reward to
  // dot(forward, travel) × ∂h/∂t, both already computed. Faces become
  // directional conveyors: surf the set, or fight it and bog.
  if (WAVE_FEEL.wavePush > 0) {
    const travelX = Math.cos(field.waveBearing)
    const travelZ = Math.sin(field.waveBearing)
    const along = planeFwdX * travelX + planeFwdZ * travelZ
    const rising = Math.max(0, frame.waterSurfaceVy)
    const aPush = WAVE_PUSH_GAIN * rising * Math.max(0, along) * WAVE_FEEL.wavePush
    if (aPush > 0) {
      rb.applyImpulse(
        {
          x: planeFwdX * aPush * m * dt,
          y: planeFwdY * aPush * m * dt,
          z: planeFwdZ * aPush * m * dt,
        },
        true,
      )
    }
  }
  // Wake drafting: a forward boost inside the calm center TROUGH of a
  // rival's wake (HTH's best emergent racing mechanic — steer into the
  // V's channel). Keyed to the depth of the rivals' summed wake trough
  // at the bike, saturating at 15 cm; own trail excluded.
  if (WAVE_FEEL.draft > 0 && field.trails.length > 0) {
    let troughDepth = 0
    for (const tr of field.trails) {
      if (tr.id === eid) continue
      sampleWakeFromTrail(tr, frame.t.x, frame.t.z, field.time, _draftWakeScratch)
      troughDepth += Math.min(0, _draftWakeScratch.y)
    }
    const inTrough = Math.min(1, -troughDepth / DRAFT_TROUGH_SAT)
    if (inTrough > 0) {
      const aDraft = DRAFT_GAIN * inTrough * WAVE_FEEL.draft
      rb.applyImpulse(
        {
          x: planeFwdX * aDraft * m * dt,
          y: planeFwdY * aDraft * m * dt,
          z: planeFwdZ * aDraft * m * dt,
        },
        true,
      )
    }
  }
}

// ============================================================================
// Ground branch — motion + steering + anti-grav corrections
// ============================================================================

/**
 * The grounded-body update: brake, thrust, slope momentum + climb assist
 * + velocity redirect, landing-momentum redirect, yaw + fishtail, roll
 * PD, lateral drag, and the trailing anti-grav corrections.
 *
 * Force order matters — see the inline comments. Notable ordering rule:
 * the slope velocity redirect re-reads `rb.linvel()` mid-tick so it sees
 * post-brake / post-thrust velocity; the landing redirect and lateral
 * drag deliberately use the TICK-START `linvel` (captured on the frame)
 * so the fishtail's lateral kick this tick isn't immediately damped.
 */
export function applyGroundBranch(
  frame: HoverFrame,
  footprint: Footprint,
  probe: SurfaceProbe,
  prevGrounded: boolean,
  groundDistance: number,
  field: WaveFieldState | null,
): void {
  const { rb, stats, intent, dt, m, gravity, eid, linvel, q, upX, upY, upZ, agActive } = frame
  const fwd = quatRotate(q, { x: 0, y: 0, z: 1 })

  // Bike-fwd projected into the up-plane — the "horizontal" forward in
  // the bike's local frame. When up = Y this is just (fwd.x, 0, fwd.z),
  // matching the historic XZ horizontal forward. In anti-grav this stays
  // in the road plane so thrust pushes the bike along the road surface.
  const fwdDotUpG = fwd.x * upX + fwd.y * upY + fwd.z * upZ
  let planeFwdX = fwd.x - upX * fwdDotUpG
  let planeFwdY = fwd.y - upY * fwdDotUpG
  let planeFwdZ = fwd.z - upZ * fwdDotUpG
  const planeFwdLen = Math.hypot(planeFwdX, planeFwdY, planeFwdZ)
  if (planeFwdLen > 0.01) {
    planeFwdX /= planeFwdLen
    planeFwdY /= planeFwdLen
    planeFwdZ /= planeFwdLen
  }
  // Up-plane "right" — used by lateral drag + fishtail.
  const planeRightX = upY * planeFwdZ - upZ * planeFwdY
  const planeRightY = upZ * planeFwdX - upX * planeFwdZ
  const planeRightZ = upX * planeFwdY - upY * planeFwdX

  // Velocity projected onto the up-plane. Used for brake / thrust /
  // drag / slope-momentum speed reads.
  const linvelUpG = linvel.x * upX + linvel.y * upY + linvel.z * upZ
  const vPlaneX = linvel.x - upX * linvelUpG
  const vPlaneY = linvel.y - upY * linvelUpG
  const vPlaneZ = linvel.z - upZ * linvelUpG
  const speed = Math.hypot(vPlaneX, vPlaneY, vPlaneZ)

  const surfaceForwardSlope = footprint.surfaceForwardSlope

  // ── Brake ──────────────────────────────────────────────────────────
  if (intent.brake > 0 && speed > 0.5) {
    const brakeAccel = intent.brake * BRAKE_ACCEL // m/s^2 at full brake
    rb.applyImpulse(
      {
        x: -(vPlaneX / speed) * brakeAccel * m * dt,
        y: -(vPlaneY / speed) * brakeAccel * m * dt,
        z: -(vPlaneZ / speed) * brakeAccel * m * dt,
      },
      true,
    )
  }

  // ── Forward thrust (boost-raised cap) ──────────────────────────────
  // Water adds extra drag — slightly less responsive. Applied along the
  // full bike-fwd vector (not the up-plane projection) so chassis pitch
  // vectors thrust on the ground the same way it does in the air: pop a
  // wheelie + throttle and the bike lifts; tip into a downslope and the
  // throttle drives you into the wave face. Lets pitch be an expressive
  // control on land/water, not just airborne.
  const throttle = intent.throttle
  const direction = throttle >= 0 ? 1 : -1
  const scale = throttle >= 0 ? 1 : stats.reverseScale
  const meterActive = BoostMeterStore.get(eid)?.active === true
  const heldBoost = meterActive ? stats.boostMul : 1
  const pickupBoost = getCurrentBoostMultiplier(eid)
  // Tuck — folded into the nose-down lean (see tuckFactor / the dive-aid's
  // `diveAmount`). Signed: at the sweet spot it raises the cap (and cuts
  // drag, below); past it the factor goes negative and the cap drops below
  // base — the belly-scrape penalty for burying the nose. The cap lift only
  // converts to real speed when something is already pushing past base
  // topSpeed (slope momentum on a descent, throttle into a wave face,
  // pickup boost), so a feathered lean down a hill is where it pays.
  //
  // The sweet spot slides toward the feathered end as the (anticipated,
  // forward) downslope steepens: on a descent the chassis is already
  // pitched nose-down to the surface tangent and the dive clamp eats the
  // rest of the player's travel, so a fixed notch would grade the reward
  // off input the bike can't execute. `surfaceForwardSlope` is the same
  // speed-anticipated, low-pass read the pitch PD + slope-momentum trust,
  // so the notch pre-shifts for the wave face / ramp the bow probe sees.
  const tuckSweet = slopeAwareSweetSpot(-Math.atan(surfaceForwardSlope))
  const tf = tuckFactor(Math.max(-intent.pitch, 0), tuckSweet)
  const tuckMul = 1 + (stats.tuckSpeedBoost - 1) * tf
  const boost = heldBoost * pickupBoost * tuckMul
  // Boost raises the speed cap (see air branch for rationale).
  const speedFalloff = Math.max(0, 1 - speed / (stats.topSpeed * boost))
  const surfaceMul = probe.isWater ? WATER_THRUST_MUL : 1.0
  const aThrust =
    Math.abs(throttle) * stats.accel * scale * speedFalloff * boost * direction * surfaceMul
  rb.applyImpulse(
    {
      x: fwd.x * aThrust * m * dt,
      y: fwd.y * aThrust * m * dt,
      z: fwd.z * aThrust * m * dt,
    },
    true,
  )

  // ── Slope momentum + climb assist + velocity redirect ──────────────
  // Slope momentum: project gravity along the surface's forward axis
  // (marble-on-incline). The hover spring cancels gravity vertically, so
  // without this the chassis would pitch on a slope but coast at the
  // same speed regardless of grade. Strongly asymmetric coupling (see
  // SLOPE_DOWN_GAIN / SLOPE_UP_BRAKE) gives the motocross slingshot down
  // and a featherweight tax up.
  //
  // Climb assist: arcade compensator for the gravity-along-slope tax.
  // On a 25° hill the physically-honest tax is m·g·tan(θ) ≈ 11.7 m/s²,
  // saturating the bike's 19 m/s² accel curve at a steady-state ~12 m/s.
  // Compensate CLIMB_ASSIST_FRAC of the tax as extra forward thrust so
  // climbs read closer to flat-ground speed. Uphill only, land only.
  //
  // Velocity redirect: when entering a fast steep climb the spring can't
  // generate enough lift to lift the chassis at the surface's vertical
  // rate; the capsule clips the trimesh and the contact resolver burns
  // ~50% of forward speed in 150 ms. Below the hover band on a positive
  // slope, nudge velocity toward the slope tangent so the chassis rides
  // the slope instead of plowing into it.
  if (planeFwdLen > 0.01) {
    const aSlope = slopeMomentumAccel(-Math.atan(surfaceForwardSlope), gravity)
    rb.applyImpulse(
      {
        x: planeFwdX * aSlope * m * dt,
        y: planeFwdY * aSlope * m * dt,
        z: planeFwdZ * aSlope * m * dt,
      },
      true,
    )

    // DEV-FLAGGED P4.2 prototypes — both default OFF (see helper).
    if (probe.isWater && field) {
      applyWaveFeelPrototypes(frame, field, planeFwdX, planeFwdY, planeFwdZ)
    }

    // Scaled by forward throttle so the assist only fires when the player
    // is actually climbing under power. Without this gate the unconditional
    // forward push (~6.5 m/s² net on a 25° slope) overwhelms the meek
    // uphill marble-on-incline brake and free-climbs a coasting bike.
    const climbThrottle = Math.max(intent.throttle, 0)
    if (surfaceForwardSlope > 0.05 && !probe.isWater && climbThrottle > 0) {
      const aClimb = surfaceForwardSlope * gravity * CLIMB_ASSIST_FRAC * climbThrottle
      rb.applyImpulse(
        {
          x: planeFwdX * aClimb * m * dt,
          y: planeFwdY * aClimb * m * dt,
          z: planeFwdZ * aClimb * m * dt,
        },
        true,
      )
    }

    if (
      !agActive &&
      !probe.isWater &&
      surfaceForwardSlope > 0.05 &&
      groundDistance < stats.hoverHeight * 0.85
    ) {
      // Fresh-read linvel — earlier `linvel` is the tick-start snapshot.
      const cur = rb.linvel()
      const speedH = Math.hypot(cur.x, cur.z)
      if (speedH > 4) {
        const slopeAngle = Math.atan(surfaceForwardSlope)
        const cs = Math.cos(slopeAngle)
        const sn = Math.sin(slopeAngle)
        const speed3d = Math.hypot(cur.x, cur.y, cur.z)
        // Target: velocity along bike-fwd tilted up by slopeAngle,
        // preserving total speed.
        const tangentVx = planeFwdX * cs * speed3d
        const tangentVy = sn * speed3d
        const tangentVz = planeFwdZ * cs * speed3d
        // Soft pull (~70 ms half-life) — quick enough to clear a slope
        // transition before the capsule clips the trimesh, slow enough
        // not to fight intentional player Q/E pitch input.
        const blend = Math.min(1, REDIRECT_RATE * dt)
        const dvx = (tangentVx - cur.x) * blend
        const dvy = (tangentVy - cur.y) * blend
        const dvz = (tangentVz - cur.z) * blend
        rb.applyImpulse({ x: dvx * m, y: dvy * m, z: dvz * m }, true)
      }
    }
  }

  // ── Landing momentum redirect ─────────────────────────────────────
  // Motocross "hit the lip right" reward. On airborne→grounded, if the
  // bike is descending onto a downward slope, convert part of the
  // vertical descent into forward velocity along the slope. The spring
  // would otherwise eat the descent (damp kills upward velocity but the
  // descending KE just becomes spring-displacement work). Redirecting
  // before the spring sees it makes a clean ramp landing read as a
  // slingshot exit, not a slap.
  //
  // RAW slope here — fires only on the transition, when the filter is
  // still seeded from zero. Filtered value would gate the redirect off
  // on the first ground tick.
  if (
    !prevGrounded &&
    linvel.y < -2 &&
    footprint.surfaceForwardSlopeRaw < -0.1 &&
    planeFwdLen > 0.01
  ) {
    const descend = -linvel.y // positive m/s
    const slopeAngle = Math.atan(-footprint.surfaceForwardSlopeRaw) // positive
    const redirectFrac =
      Math.min(slopeAngle / LANDING_REDIRECT_SLOPE_FULL, 1) * LANDING_REDIRECT_MAX
    const dvForward = descend * redirectFrac
    rb.applyImpulse(
      {
        x: planeFwdX * dvForward * m,
        y: planeFwdY * dvForward * m,
        z: planeFwdZ * dvForward * m,
      },
      true,
    )
  }

  // ── Yaw torque around the "pure heading" axis ─────────────────────
  // Up with the bike-fwd projection removed — perpendicular to bike-fwd
  // by construction, so steering can't leak into roll regardless of
  // pitch. In anti-grav we substitute the zone's up so yaw rotates
  // around the road normal (MK8 anti-grav feel).
  //
  // Drift override: while the bike is in active drift, the base yaw is
  // replaced by `driftYawFraction` — a speed-tapered auto-turn-in bias
  // plus a FULL-authority counter-steer term. At full speed:
  //   - no steer:         carves in at ~0.45× turnTorque (wide arc)
  //   - steer into drift: up to ~0.9× (tightens the line)
  //   - counter-steer:    ~0× or slightly negative (opens to a wide /
  //                        straight line — "hold away for a wide drift")
  // The bias tapers to zero below DRIFT_YAW_SPEED_REF so a drift that
  // has bled speed doesn't whip the bike around to a 180.
  // Sign convention: positive aTurn rotates around +up; `-intent.steer`
  // for steerLeft (-1) → +aTurn → bike yaws toward the left of screen.
  // A left drift (driftDir=-1) maps to a matching positive bias.
  const turnMul = probe.isWater ? WATER_TURN_MUL : 1.0
  const drift = DriftStateStore.get(eid)
  const drifting = !!drift && drift.driftDir !== 0
  let aTurn: number
  if (drifting) {
    aTurn =
      driftYawFraction(drift.driftDir, intent.steer, drift.chargeS, stats.driftStyle, speed) *
      stats.turnTorque *
      turnMul
  } else {
    aTurn = -intent.steer * stats.turnTorque * turnMul
  }
  const yawAxXG = upX - fwdDotUpG * fwd.x
  const yawAxYG = upY - fwdDotUpG * fwd.y
  const yawAxZG = upZ - fwdDotUpG * fwd.z
  const yawAxLenG = Math.hypot(yawAxXG, yawAxYG, yawAxZG)
  if (yawAxLenG > 0.01) {
    const invLenG = 1 / yawAxLenG
    rb.applyTorqueImpulse(
      {
        x: yawAxXG * invLenG * aTurn * m * dt,
        y: yawAxYG * invLenG * aTurn * m * dt,
        z: yawAxZG * invLenG * aTurn * m * dt,
      },
      true,
    )
  }

  // ── Fishtail bias ─────────────────────────────────────────────────
  // Shifts the perceived yaw pivot forward of CoM so the front "bites"
  // and the rear sweeps out, Jet-Moto-style. Geometric trick: a lateral
  // CoM acceleration of `α × pivotOffset` timed with the yaw torque
  // makes the point YAW_PIVOT_FWD metres ahead of CoM the instantaneous
  // rotation centre instead of CoM itself; the rear swings outward by
  // `2 × YAW_PIVOT_FWD × ω`. Faded in with speed so parking-lot wiggles
  // don't slide the bike sideways — fishtail is a high-speed feel.
  const fishtailFade = Math.min(speed / 8, 1)
  if (fishtailFade > 0) {
    const aLatFish = -aTurn * YAW_PIVOT_FWD * fishtailFade
    rb.applyImpulse(
      {
        x: planeRightX * aLatFish * m * dt,
        y: planeRightY * aLatFish * m * dt,
        z: planeRightZ * aLatFish * m * dt,
      },
      true,
    )
  }

  // ── Roll PD (ground, non-anti-grav only) ─────────────────────────
  // Corrals roll toward `surfaceRoll + steer × leanLimit × speed-scale`.
  // Critical for keeping racers from spinning out after a fishtail or
  // wave strike (free roll runs away inside a few hundred ms otherwise).
  //
  // In anti-grav: skipped. The world-Y roll target fights zone-up
  // alignment. The multi-point spring's port/starboard differential plus
  // the AG alignment torque below handle roll there.
  if (!agActive) {
    const speedFracR = Math.min(speed / LEAN_SPEED_FULL, 1)
    const baseLeanScale = LEAN_BASE + (1 - LEAN_BASE) * speedFracR
    const highSpeedFrac = Math.min(
      Math.max(speed - LEAN_SPEED_FULL, 0) / (LEAN_SPEED_HIGH - LEAN_SPEED_FULL),
      1,
    )
    const leanScale = baseLeanScale + highSpeedFrac * LEAN_HIGH_SPEED_BOOST
    // Surface roll component — multi-probe height differential across
    // the bike's width. Banks the bike into a wave normal when riding
    // diagonally across chop.
    const surfaceRollTarget = Math.atan2(
      footprint.starboardProj - footprint.portProj,
      2 * footprint.probeHalfWidth,
    )
    const targetRoll = surfaceRollTarget + intent.steer * ROLL_LEAN_LIMIT * leanScale
    // Extract true YXZ roll from current rotation.
    const r10R = 2 * (q.x * q.y + q.z * q.w)
    const r11R = 1 - 2 * (q.x * q.x + q.z * q.z)
    const currentRoll = Math.atan2(r10R, r11R)
    const fwdR = quatRotate(q, { x: 0, y: 0, z: 1 })
    const angvR = rb.angvel()
    const rollVel = angvR.x * fwdR.x + angvR.y * fwdR.y + angvR.z * fwdR.z
    // PD gains tuned for a ~0.3s settle, slightly underdamped (lively).
    const aRollPD = (targetRoll - currentRoll) * ROLL_P - rollVel * ROLL_D
    rb.applyTorqueImpulse(
      {
        x: fwdR.x * aRollPD * m * dt,
        y: fwdR.y * aRollPD * m * dt,
        z: fwdR.z * aRollPD * m * dt,
      },
      true,
    )
  }

  // ── Lateral drag ──────────────────────────────────────────────────
  // Water has *more* lateral resistance (skis don't slide sideways
  // easily). Measured along the up-plane right axis so drag opposes
  // sideways drift across the road surface (not across world XZ).
  // While drifting, scale the drag down so the bike actually slides
  // sideways like an MK kart in mid-drift — `DRIFT_LATERAL_DRAG_SCALE`
  // applied as a pure multiplier on top of the water/land switch.
  //
  // Surface grip: per-material multiplier from the surface registry —
  // 1.0 for DEFAULT / untagged land (so existing tracks are unchanged)
  // and WATER (its 1.4 lateral is handled by `dragMul` above), <1 for
  // loose/slick surfaces (sand, ice), >1 for clingy ones (metal). Reads
  // in both normal driving AND drift so a surface feels coherent — ice
  // is slippery whether or not you're sliding.
  const dragMul = probe.isWater ? WATER_LATERAL_DRAG_MUL : 1.0
  // Drift: cut lateral grip so the bike slides sideways like an MK kart.
  const driftDragMul = drifting ? DRIFT_LATERAL_DRAG_SCALE : 1.0
  // Surface grip: per-material multiplier from the surface registry.
  const gripMul = surfaceGripMul(probe.surfaceType)
  // Tuck (same signed factor as the cap lift): a clean lean cuts sideways
  // scrub so the bike tracks its line; an over-tuck (negative factor)
  // raises drag above base as the belly skims and grabs.
  const tuckDrag = 1 - (1 - stats.tuckDragMul) * tf
  const lateralVel = linvel.x * planeRightX + linvel.y * planeRightY + linvel.z * planeRightZ
  const aDrag = -lateralVel * stats.lateralDrag * dragMul * driftDragMul * gripMul * tuckDrag
  rb.applyImpulse(
    {
      x: planeRightX * aDrag * m * dt,
      y: planeRightY * aDrag * m * dt,
      z: planeRightZ * aDrag * m * dt,
    },
    true,
  )
}

/**
 * Anti-grav trailing corrections — manual gravity along −up + PD that
 * aligns the bike's local +Y to the zone up. Runs only on grounded ticks
 * with `agActive` set; the spring's port/starboard differential already
 * does the bulk of the alignment, so this PD is mostly a transition aid
 * that speeds up rotation on zone enter/exit.
 */
export function applyAntiGravCorrections(frame: HoverFrame): void {
  const { rb, dt, m, gravity, upX, upY, upZ } = frame
  rb.applyImpulse(
    {
      x: -upX * gravity * m * dt,
      y: -upY * gravity * m * dt,
      z: -upZ * gravity * m * dt,
    },
    true,
  )
  // PD alignment: bring the bike's local +Y onto up. cross(bikeUp, up) is
  // the rotation-axis × sin(angle) — standard restoring torque direction
  // for "align A to B". Reduced gain (20) now that the spring also
  // aligns; this just smooths the transition.
  const bUp = quatRotate(rb.rotation(), { x: 0, y: 1, z: 0 })
  const cx = bUp.y * upZ - bUp.z * upY
  const cy = bUp.z * upX - bUp.x * upZ
  const cz = bUp.x * upY - bUp.y * upX
  const angvA = rb.angvel()
  rb.applyTorqueImpulse(
    {
      x: (cx * AG_ALIGN_P - angvA.x * AG_ALIGN_D) * m * dt,
      y: (cy * AG_ALIGN_P - angvA.y * AG_ALIGN_D) * m * dt,
      z: (cz * AG_ALIGN_P - angvA.z * AG_ALIGN_D) * m * dt,
    },
    true,
  )
}
