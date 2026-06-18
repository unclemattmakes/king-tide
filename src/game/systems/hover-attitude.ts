/**
 * Attitude control for the hover system: the grounded pitch PD, the player
 * pitch torque (+ its motocross-pivot rebalance + dive/release-kick tapers),
 * and the airborne control branch (hang-time lift, pitch-vectored thrust,
 * reduced-authority yaw, soft-tapered roll leveler).
 *
 * Split out of `hover.ts` (docs/systems-review.md §4). Pure physics-impulse
 * helpers — they read the `HoverFrame` and apply torques/impulses against
 * `rb`, never mutating the frame.
 */

import { quatRotate } from '@/engine/sim/physics/vec'
import { BoostMeterStore } from '@/game/components'
import { getCurrentBoostMultiplier } from '@/game/systems/pickup'
import {
  AIR_LIFT_FRAC,
  AIR_PITCH_COEF,
  AIR_ROLL_D,
  AIR_ROLL_P,
  AIR_ROLL_TAPER_HI,
  AIR_ROLL_TAPER_LO,
  AIR_THRUST_MUL,
  AIR_TURN_MUL,
  DIVE_KICK_DURATION_S,
  DIVE_KICK_TORQUE_MUL,
  DIVE_PITCH_FWD_LIMIT_RAD,
  GROUND_PITCH_COEF,
  GROUNDED_PITCH_D,
  GROUNDED_PITCH_P,
  PITCH_INERTIA_COEF,
  PITCH_UPPER_BAND_RAD,
  PIVOT_OFFSET,
  RELEASE_KICK_DURATION_S,
  RELEASE_KICK_TORQUE_MUL,
} from './hover-tuning'
import type { HoverFrame } from './hover-types'

// ============================================================================
// Pitch PD + player pitch torque
// ============================================================================

/**
 * Grounded pitch PD — self-righting torque while on land OR water.
 *
 * P targets the surface's pitch attitude (`-atan(slope)`) so flat ground /
 * flat water reads as "sit level" and a slope or wave face still lets the
 * chassis tilt onto its tangent. The level band is ±45°; past that, P
 * drops and only D damps so a deliberate committed trick (wave-pump dive,
 * big-air wheelie) isn't fought.
 *
 * Originally water-only — on water the multi-point spring is softened
 * along the longitudinal axis and can't restore from a held pitch input
 * on its own. On land the multi-point spring provides strong differential
 * lift, but holding a wheelie at low speed pumps the chassis past the
 * locally-airborne gate and runs away to a backflip crash. Sharing the PD
 * between both surfaces bounds the wheelie equilibrium to ~21° on land /
 * ~31° on water with a held back-stick — committed but not crashy.
 */
export function applyGroundedPitchPD(frame: HoverFrame, surfaceForwardSlope: number): void {
  const { rb, dt, m } = frame
  const rightG = quatRotate(rb.rotation(), { x: 1, y: 0, z: 0 })
  const angvG = rb.angvel()
  const pitchVelG = angvG.x * rightG.x + angvG.y * rightG.y + angvG.z * rightG.z
  const qG = rb.rotation()
  const r12G = 2 * (qG.y * qG.z - qG.x * qG.w)
  const pitchAngleG = Math.asin(Math.max(-1, Math.min(1, -r12G)))
  const surfacePitchTarget = -Math.atan(surfaceForwardSlope)
  const pitchErrG = pitchAngleG - surfacePitchTarget
  // Upper-band cutoff at 45° lets a committed wheelie/backflip run
  // free (P drops to 0 past the cutoff, only D damps). Dive side is
  // P-active all the way to the safety clamp; no dive-side softening
  // since the player-torque rate limit handles "let me dive" already.
  const aPitchP = pitchErrG > PITCH_UPPER_BAND_RAD ? 0 : -pitchErrG * GROUNDED_PITCH_P
  const aPitchD = -pitchVelG * GROUNDED_PITCH_D
  const aPitchG = aPitchP + aPitchD
  rb.applyTorqueImpulse(
    {
      x: rightG.x * aPitchG * m * dt,
      y: rightG.y * aPitchG * m * dt,
      z: rightG.z * aPitchG * m * dt,
    },
    true,
  )
}

/**
 * Player pitch torque — applied around the bike's right axis. Fires in
 * BOTH grounded and airborne states with different coefficients.
 *
 * Sign: intent.pitch=+1 ("nose up") → torque around -rightAxis, rotates
 * fwd toward +y. intent.pitch=-1 ("nose down / dive").
 *
 * Magnitude is a *torque coefficient*, not the angular acceleration
 * directly: it multiplies `mass * dt` to form the torque impulse, so the
 * effective angular acceleration is `coef * mass / I_pitch`. For the
 * capsule (I_pitch ≈ m·0.34) that's roughly `coef × 2.94` rad/s² at full
 * input.
 *
 *   - Grounded (GROUND_PITCH_COEF, both directions): paired with the
 *     grounded pitch PD above (P=9, D=3, ±45° band). Equilibrium under
 *     held wheelie is ~21° on land / ~31° on water — committed but
 *     bounded. Grounded also fires the motocross-pivot rebalance below —
 *     see comments inside the function.
 *   - Air (AIR_PITCH_COEF=1.8): 60% of the prior 3.0 — air pitch felt
 *     twitchy at 3.0. 1.8 stretches a full backflip to ~3s while still
 *     keeping fwd.y monotonic over the 1s m9-air-control sample window.
 *     Air keeps the pure-torque feel; flips spin around CM.
 */
export function applyPlayerPitchTorque(
  frame: HoverFrame,
  isGrounded: boolean,
  isOverWater: boolean,
  surfaceForwardSlope: number,
  diveHoldS: number,
  releaseKickS: number,
): void {
  const { rb, intent, q, dt, m } = frame
  // Release kick — fires when releaseKickS > 0 (set by the hover loop
  // on the rising edge of a dive release; ticks down to 0). Brief
  // nose-UP torque so the bow leads as the bike rises back to baseline
  // hover height. Grounded only; airborne handled by free physics.
  // Skipped if the player has fresh input — re-press cancels it via
  // the loop's gate, but if they swung to pitch-up the player torque
  // path below handles it directly with full authority.
  if (releaseKickS > 0 && isGrounded && Math.abs(intent.pitch) <= 0.05) {
    const rightR = quatRotate(q, { x: 1, y: 0, z: 0 })
    const kickMul = RELEASE_KICK_TORQUE_MUL * (releaseKickS / RELEASE_KICK_DURATION_S)
    // intent.pitch = +1 (nose up) sign convention: torque sign is `-coef`
    // → applies around -rightAxis → rotates fwd toward +y. Match that.
    const aRelease = -1 * GROUND_PITCH_COEF * kickMul
    rb.applyTorqueImpulse(
      {
        x: rightR.x * aRelease * m * dt,
        y: rightR.y * aRelease * m * dt,
        z: rightR.z * aRelease * m * dt,
      },
      true,
    )
    return
  }
  if (Math.abs(intent.pitch) <= 0.05) return
  // Dive-clamp safety: past DIVE_PITCH_FWD_LIMIT_RAD below the surface
  // tangent, suppress the nose-down torque. Primary dive bounding is the
  // diveHoldS taper below; this is a backstop for rapid-tap accumulation
  // or kick-out-of-band momentum. Grounded path also gets full-P
  // restoring from applyGroundedPitchPD; the airborne-over-water path
  // relies on input suppression alone (air has no PD by design —
  // residual nose-down angular velocity carried airborne will still
  // rotate the chassis somewhat, just no fresh torque past the limit).
  // Airborne over LAND is unaffected — jump tricks off ramps run free.
  //
  // Sign convention: pitchAngle = asin(−fwd.y), so positive = nose DOWN
  // (the grounded PD above corrects positive error with nose-up torque).
  // The clamp therefore fires on pitchAngle − target > +limit; with the
  // comparison mirrored it instead eats the dive kick on any nose-high
  // wave/ramp launch over an unfavourable slope — Q randomly dead for
  // the whole arc.
  if ((isGrounded || isOverWater) && intent.pitch < 0) {
    const qChk = rb.rotation()
    const r12Chk = 2 * (qChk.y * qChk.z - qChk.x * qChk.w)
    const pitchAngle = Math.asin(Math.max(-1, Math.min(1, -r12Chk)))
    const surfacePitchTarget = -Math.atan(surfaceForwardSlope)
    if (pitchAngle - surfacePitchTarget > DIVE_PITCH_FWD_LIMIT_RAD) return
  }
  const rightP = quatRotate(q, { x: 1, y: 0, z: 0 })
  const coef = isGrounded ? GROUND_PITCH_COEF : AIR_PITCH_COEF
  // Dive-kick taper: nose-down torque starts at DIVE_KICK_TORQUE_MUL ×
  // baseline and fades to zero over DIVE_KICK_DURATION_S after the
  // player starts holding pitch-down. After the kick, the pitch PD
  // pulls the chassis back to surface tangent and sustained input
  // reads as altitude control via the hover-height drop. Pitch-up
  // (wheelie) is unaffected.
  const kickMul =
    intent.pitch < 0 ? DIVE_KICK_TORQUE_MUL * Math.max(0, 1 - diveHoldS / DIVE_KICK_DURATION_S) : 1
  const aPitch = -intent.pitch * coef * kickMul
  const tx = rightP.x * aPitch * m * dt
  const ty = rightP.y * aPitch * m * dt
  const tz = rightP.z * aPitch * m * dt
  rb.applyTorqueImpulse({ x: tx, y: ty, z: tz }, true)
  if (!isGrounded) return

  // Off-center rebalance — motocross pivot. A pure torque rotates the
  // chassis around its CM, so a wheelie swings the front up AND the rear
  // down by the same arc, which reads as "the whole bike tips". To make
  // pitch feel like pivoting around the rear (wheelie) or the front
  // (endo/stoppie), add a linear impulse that cancels the angular
  // contribution to velocity at the chosen pivot: Δv_cm = -Δω × r_anchor.
  // Net effect, the chosen end is instantaneously stationary and the
  // opposite end swings through twice the arc.
  //
  // Asymmetric on purpose — pitch-up pivots rear (wheelie), pitch-down
  // pivots front (endo) — matching how a real motorcycle pivots on each
  // direction. Air pitch keeps its center-pivot feel so backflips spin
  // around CM as before; flips that pivoted off-axis felt floaty.
  //
  // Note: at held-pitch equilibrium the player torque is still applied
  // every tick (the grounded pitch PD cancels it), so this rebalance is
  // also still applied each tick. The hover spring absorbs the resulting
  // steady upward bias; expect the chassis to ride slightly higher
  // during a sustained wheelie. Reads as "the bike rises while popped"
  // which matches the motocross feel — but if it floats too much in
  // playtest, dial PIVOT_OFFSET down toward 0.
  const fwdP = quatRotate(q, { x: 0, y: 0, z: 1 })
  const sign = intent.pitch > 0 ? -1 : 1
  const rx = fwdP.x * PIVOT_OFFSET * sign
  const ry = fwdP.y * PIVOT_OFFSET * sign
  const rz = fwdP.z * PIVOT_OFFSET * sign
  // Δω = T / I_pitch. I_pitch ≈ m·0.34 for the capsule (see torque
  // coefficient comment above). Linear impulse = m · -Δω × r_anchor.
  const invI = 1 / (m * PITCH_INERTIA_COEF)
  const wx = tx * invI
  const wy = ty * invI
  const wz = tz * invI
  rb.applyImpulse(
    {
      x: -m * (wy * rz - wz * ry),
      y: -m * (wz * rx - wx * rz),
      z: -m * (wx * ry - wy * rx),
    },
    true,
  )
}

// ============================================================================
// Air control branch
// ============================================================================

/**
 * Air control — lift (hang-time), pitch-vectored thrust, reduced-authority
 * yaw, and a soft-tapered roll leveler. The air branch is fully free
 * physics aside from these arcade aids: backflips, barrel rolls, dives,
 * whatever the player commits to via input integrates freely.
 */
export function applyAirControlBranch(frame: HoverFrame): void {
  const { rb, stats, intent, dt, m, gravity, eid, linvel, q, upX, upY, upZ } = frame

  // Hang-time: counter ~60% of gravity so the bike floats through arcs
  // JetMoto-style instead of dropping like a brick. Effective gravity in
  // air ≈ 0.4·G ≈ 10 m/s² — close to real-world Earth pull, well below
  // arcade ground gravity. In anti-grav, lift is along the zone's up
  // (matching the manual gravity applied at end-of-loop along −up).
  const airLiftMag = gravity * AIR_LIFT_FRAC * m * dt
  rb.applyImpulse({ x: upX * airLiftMag, y: upY * airLiftMag, z: upZ * airLiftMag }, true)

  // Pitch-vectored thrust: airborne thrust pushes along bike-fwd.
  //   Q (intent.pitch=-1) → fwd.y < 0 → thrust dives.
  //   E (intent.pitch=+1) → fwd.y > 0 → thrust extends air time.
  // Slightly weaker than ground thrust so the player can't infinite-
  // hover by aiming up + boost; speedFalloff3d (with boost-raised cap)
  // still caps any sustained climb at the effective top speed.
  const fwdAir = quatRotate(q, { x: 0, y: 0, z: 1 })
  if (Math.abs(intent.throttle) > 0) {
    const speed3d = Math.hypot(linvel.x, linvel.y, linvel.z)
    const dirAir = intent.throttle >= 0 ? 1 : -1
    const scaleAir = intent.throttle >= 0 ? 1 : stats.reverseScale
    // Held-boost is gated by the boost-meter `active` flag — see
    // boost-meter.ts for the rising-edge / drain rules.
    const meterActive = BoostMeterStore.get(eid)?.active === true
    const boostAir = (meterActive ? stats.boostMul : 1) * getCurrentBoostMultiplier(eid)
    // Boost raises the speed cap: speedFalloff stays positive past base
    // topSpeed as long as boost > 1, so the boost actually pushes the
    // bike faster on a long straight (Burnout feel). Without this, at
    // speed=topSpeed thrust vanishes regardless of boost — the meter
    // would only shorten the time-to-cap, not the cap itself.
    const speedFalloff3d = Math.max(0, 1 - speed3d / (stats.topSpeed * boostAir))
    const aAir =
      Math.abs(intent.throttle) *
      stats.accel *
      scaleAir *
      speedFalloff3d *
      boostAir *
      dirAir *
      AIR_THRUST_MUL
    rb.applyImpulse(
      { x: fwdAir.x * aAir * m * dt, y: fwdAir.y * aAir * m * dt, z: fwdAir.z * aAir * m * dt },
      true,
    )
  }

  // Yaw around the "pure heading" axis: up with the bike-fwd projection
  // removed (then normalised). Perpendicular to bike-fwd by construction,
  // so steering in the air can't leak into roll even when the bike is
  // pitched up after a ramp. In anti-grav we use the zone's up so yaw
  // rotates around the road normal, not world-Y. Reduced authority
  // (×0.3) preserved for landing alignment.
  const aTurnAir = -intent.steer * stats.turnTorque * AIR_TURN_MUL
  const fwdAxisDot = fwdAir.x * upX + fwdAir.y * upY + fwdAir.z * upZ
  const yawAxXAir = upX - fwdAxisDot * fwdAir.x
  const yawAxYAir = upY - fwdAxisDot * fwdAir.y
  const yawAxZAir = upZ - fwdAxisDot * fwdAir.z
  const yawAxLenAir = Math.hypot(yawAxXAir, yawAxYAir, yawAxZAir)
  if (yawAxLenAir > 0.01) {
    const invLen = 1 / yawAxLenAir
    rb.applyTorqueImpulse(
      {
        x: yawAxXAir * invLen * aTurnAir * m * dt,
        y: yawAxYAir * invLen * aTurnAir * m * dt,
        z: yawAxZAir * invLen * aTurnAir * m * dt,
      },
      true,
    )
  }

  // Air roll leveler — gentle PD toward zero roll. The roll ANGLE at
  // takeoff (e.g. a fully laid-over corner) is preserved by the air
  // branch's "free physics" approach, which left the bike stuck on its
  // side mid-jump. Low gain so steer-driven aerial banking still works
  // as a transient, but neutral is the attractor over ~2s.
  //
  // Softly tapered out between 60° and 80° of pitch (was a hard cutoff
  // at 60°). Past 80° we don't touch roll at all so a committed
  // backflip/dive runs free; below 60° full restoring authority; lerped
  // between for a continuous handoff (no snap when re-entering the band).
  const r10A = 2 * (q.x * q.y + q.z * q.w)
  const r11A = 1 - 2 * (q.x * q.x + q.z * q.z)
  const r12A = 2 * (q.y * q.z - q.x * q.w)
  const pitchA = Math.asin(Math.max(-1, Math.min(1, -r12A)))
  const absPitchA = Math.abs(pitchA)
  if (absPitchA < AIR_ROLL_TAPER_HI) {
    const taper =
      absPitchA <= AIR_ROLL_TAPER_LO
        ? 1
        : 1 - (absPitchA - AIR_ROLL_TAPER_LO) / (AIR_ROLL_TAPER_HI - AIR_ROLL_TAPER_LO)
    const currentRollA = Math.atan2(r10A, r11A)
    const angvA = rb.angvel()
    const rollVelA = angvA.x * fwdAir.x + angvA.y * fwdAir.y + angvA.z * fwdAir.z
    const aRollAir = (-currentRollA * AIR_ROLL_P - rollVelA * AIR_ROLL_D) * taper
    rb.applyTorqueImpulse(
      {
        x: fwdAir.x * aRollAir * m * dt,
        y: fwdAir.y * aRollAir * m * dt,
        z: fwdAir.z * aRollAir * m * dt,
      },
      true,
    )
  }
}
