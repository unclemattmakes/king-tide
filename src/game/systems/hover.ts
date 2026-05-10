import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate, vecHorizontalLength } from '@/engine/sim/physics/vec'
import { sampleHeight, type WaveFieldState } from '@/engine/sim/water/wave-field'
import {
  BikeStats,
  BikeStatsStore,
  BikeTag,
  ControlIntent,
  ControlIntentStore,
  HoverState,
  HoverStateStore,
  RBHandle,
  RBHandleStore,
} from '@/game/components'
import { getCurrentBoostMultiplier } from '@/game/systems/pickup'

const MAX_HOVER_PROBE = 6
const GRAVITY = 25 // must match PhysicsWorld gravity magnitude

/**
 * Surface probe: looks below an XZ point for the closest "ride surface".
 * Either a hard physical collider (raycast) or the wave field water surface,
 * whichever is *higher* (closer to the bike) wins. This unifies driving on
 * land and driving on water — same controller, different surface y.
 *
 * Used both as the *center probe* (one per bike, drives hover spring +
 * grounded gating + dive logic) and as the *footprint probes* (four per
 * bike at bow / stern / port / starboard, drive surface alignment). The
 * footprint version (`probeSurfaceY`) only needs the height — it doesn't
 * care about isWater/hasSurface gating.
 */
type SurfaceProbe = {
  surfaceY: number
  isWater: boolean
  hasSurface: boolean
}

function probeSurface(
  phys: PhysicsWorld,
  field: WaveFieldState | null,
  fromX: number,
  fromY: number,
  fromZ: number,
  ignore: ReturnType<PhysicsWorld['world']['getRigidBody']>,
): SurfaceProbe {
  const ray = new phys.rapier.Ray({ x: fromX, y: fromY, z: fromZ }, { x: 0, y: -1, z: 0 })
  const hit = phys.world.castRay(
    ray,
    MAX_HOVER_PROBE,
    true,
    undefined,
    undefined,
    undefined,
    ignore ?? undefined,
  )
  const groundY = hit ? fromY - hit.timeOfImpact : Number.NEGATIVE_INFINITY
  const waterY = field ? sampleHeight(field, fromX, fromZ) : Number.NEGATIVE_INFINITY

  // Higher surface wins — that's what the bike rides on.
  if (groundY === Number.NEGATIVE_INFINITY && waterY === Number.NEGATIVE_INFINITY) {
    return { surfaceY: 0, isWater: false, hasSurface: false }
  }
  if (groundY > waterY) {
    return { surfaceY: groundY, isWater: false, hasSurface: true }
  }
  // Water can be sampled anywhere, so water is "always reachable" — but only
  // counts as a ride surface if the bike is within probe range of it.
  const reachable = fromY - waterY < MAX_HOVER_PROBE
  return { surfaceY: waterY, isWater: true, hasSurface: reachable }
}

/**
 * Footprint probe: just the height at (x, z), max of ground raycast and
 * wave field. Returns NEGATIVE_INFINITY if neither is found (caller falls
 * back to the center probe — see surface alignment block).
 */
function probeSurfaceY(
  phys: PhysicsWorld,
  field: WaveFieldState | null,
  x: number,
  fromY: number,
  z: number,
  ignore: ReturnType<PhysicsWorld['world']['getRigidBody']>,
): number {
  const ray = new phys.rapier.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 })
  const hit = phys.world.castRay(
    ray,
    MAX_HOVER_PROBE,
    true,
    undefined,
    undefined,
    undefined,
    ignore ?? undefined,
  )
  const groundY = hit ? fromY - hit.timeOfImpact : Number.NEGATIVE_INFINITY
  const waterY = field ? sampleHeight(field, x, z) : Number.NEGATIVE_INFINITY
  if (groundY === Number.NEGATIVE_INFINITY && waterY === Number.NEGATIVE_INFINITY) {
    return Number.NEGATIVE_INFINITY
  }
  return Math.max(groundY, waterY)
}

/**
 * Per-bike: probe ground/water, apply hover/thrust/steer/lateral-drag.
 * All coefficients are in acceleration units (m/s^2 per unit). Impulses are
 * computed as accel * mass * dt so tuning stays decoupled from mass.
 */
export function hoverSystem(sim: SimWorld, phys: PhysicsWorld, field: WaveFieldState | null): void {
  const eids = query(sim, [BikeTag, RBHandle, BikeStats, ControlIntent, HoverState])
  for (const eid of eids) {
    const { handle } = RBHandleStore.must(eid)
    const stats = BikeStatsStore.must(eid)
    const intent = ControlIntentStore.must(eid)
    const rb = phys.world.getRigidBody(handle)
    if (!rb) continue

    const t = rb.translation()
    const linvel = rb.linvel()
    const dt = phys.fixedDt
    const m = stats.mass

    const probe = probeSurface(phys, field, t.x, t.y, t.z, rb)
    const groundDistance = probe.hasSurface ? t.y - probe.surfaceY : MAX_HOVER_PROBE
    const isGrounded = probe.hasSurface && groundDistance < stats.hoverHeight * 1.6

    // Surface alignment: figure out how the chassis should sit relative to
    // the surface it's riding. When airborne we don't know what surface the
    // bike is heading toward, so the targets stay 0 and the bike just holds
    // its current attitude.
    //
    // Multi-probe sampling (SoT/Atlas-style), unified across water + ground.
    // Read the surface height at four points around the bike — bow, stern,
    // port, starboard — and let pitch/roll fall out of differential heights:
    //
    //     pitch ≈ atan2(y_bow − y_stern, 2·halfLength)
    //     roll  ≈ atan2(y_starboard − y_port, 2·halfWidth)
    //
    // Each probe takes max(ground raycast, wave field height), so a bike
    // straddling the shoreline correctly reads the high terrain on one side
    // and the wave on the other. This is *more correct* than reading the
    // local wave normal under the bike's center, because the bike has a
    // real footprint in world space:
    //   1. Long swells naturally tilt the bike across the wave.
    //   2. Short chops + sub-footprint terrain bumps average between probes
    //      so the bike doesn't whip-snap to every ripple or trimesh edge.
    //   3. Mixed water/terrain transitions (water lapping a ledge, bow over
    //      a ramp with stern still on water) read continuously instead of
    //      flickering between water-only and ground-only branches.
    let surfacePitchTarget = 0
    let surfaceRollTarget = 0
    if (isGrounded) {
      // Yaw-only frame for projecting bike-fwd/right into world XZ. Same
      // yaw is recomputed in the kinematic block below; the duplication
      // is intentional — they read different parts of `rb.rotation()`.
      const q0_ = rb.rotation()
      const r02_ = 2 * (q0_.x * q0_.z + q0_.y * q0_.w)
      const r22_ = 1 - 2 * (q0_.x * q0_.x + q0_.y * q0_.y)
      const yaw_ = Math.atan2(r02_, r22_)
      const cy_ = Math.cos(yaw_)
      const sy_ = Math.sin(yaw_)

      // Altitude-faded follow: skimming the surface fully tracks terrain;
      // riding high smooths out into a hover. Linear from 1.0 at the
      // surface to 0.0 at the grounded/airborne boundary, so at nominal
      // hover (groundDistance ≈ hoverHeight) the bike inherits ~37% of
      // its base follow. Dipping into a trough or skimming a ramp kicks
      // the factor back up.
      //
      // Base follow: water uses the per-bike `surfaceFollow` (chop is
      // noisy enough that 0.5 reads as a sturdy hover bike); ground uses
      // 1.0 so the chassis fully matches a clean ramp slope as the new
      // neutral attitude. The center probe's surface type picks which
      // baseline applies — straddling-the-shoreline transitions briefly
      // hand off as the center crosses, which is fine: the multi-probe
      // height differential is what's doing the heavy lifting either way.
      const surfFadeFar = stats.hoverHeight * 1.6
      const altitudeFactor = Math.max(0, Math.min(1, 1 - groundDistance / surfFadeFar))
      const baseFollow = probe.isWater ? stats.surfaceFollow : 1.0
      const followNow = baseFollow * altitudeFactor

      // Probe footprint matches the bike's visual scale (~1.6m × 0.8m).
      const PROBE_HALF_LENGTH = 0.8
      const PROBE_HALF_WIDTH = 0.4
      // Bike-fwd in world XZ: (sin(yaw), cos(yaw)).
      // Bike-right in world XZ: (cos(yaw), -sin(yaw)).
      const fwdX = sy_
      const fwdZ = cy_
      const rightX = cy_
      const rightZ = -sy_
      // Each probe casts from the bike's center Y so terrain sticking up in
      // front of the bike (e.g. a wall, a ramp lip) is correctly intersected.
      // probeSurfaceY returns max(ground, water) per location; falls back to
      // the center probe's surfaceY if neither hit (bike overhanging an edge
      // with nothing below — read the missing side as flat with the center
      // rather than NaN).
      const fallbackY = probe.surfaceY
      const sampleAt = (px: number, pz: number): number => {
        const y = probeSurfaceY(phys, field, px, t.y, pz, rb)
        return y === Number.NEGATIVE_INFINITY ? fallbackY : y
      }
      const yBow = sampleAt(t.x + fwdX * PROBE_HALF_LENGTH, t.z + fwdZ * PROBE_HALF_LENGTH)
      const yStern = sampleAt(t.x - fwdX * PROBE_HALF_LENGTH, t.z - fwdZ * PROBE_HALF_LENGTH)
      const yStarboard = sampleAt(t.x + rightX * PROBE_HALF_WIDTH, t.z + rightZ * PROBE_HALF_WIDTH)
      const yPort = sampleAt(t.x - rightX * PROBE_HALF_WIDTH, t.z - rightZ * PROBE_HALF_WIDTH)
      // Sign convention (YXZ Euler):
      //   bow > stern → bike climbing → nose up → NEGATIVE pitch.
      //   starboard > port → right side high → POSITIVE roll.
      surfacePitchTarget = followNow * -Math.atan2(yBow - yStern, 2 * PROBE_HALF_LENGTH)
      surfaceRollTarget = followNow * Math.atan2(yStarboard - yPort, 2 * PROBE_HALF_WIDTH)
    }

    // Kinematic attitude shape. Decompose the bike's orientation into YXZ
    // intrinsic Euler (yaw → pitch → roll) and re-impose BOTH pitch and
    // roll each tick so the bike sits exactly at:
    //   pitch = surfacePitchTarget + player pitch input
    //   roll  = surfaceRollTarget  + steer-driven lean
    //
    // Pitch was previously a soft PD with surfacePitchTarget biasing the
    // target. That worked but produced a subtle yaw drift: when surface
    // alignment caused the bike to oscillate in roll up to ±20° on waves,
    // the pitch PD's torque (along bikeRight) acquired a world-Y component
    // and slowly yawed the bike off course (caught by the m5-pickup test).
    // Going fully kinematic for both pitch and roll removes the PD →
    // physics → pitch coupling entirely. Yaw remains the only physics-
    // driven attitude axis.
    //
    // Why kinematic instead of a soft PD: any roll PD that reads
    // bikeRight.y false-positives on yaw-while-pitched and pumps real
    // roll velocity into the body (M9.x bug). Pitch had its own version
    // of the same problem under surface alignment.
    const PITCH_LIMIT = Math.PI / 6 // 30° max player-driven pitch
    const ROLL_LEAN_LIMIT = Math.PI / 15 // ~12° max steer-driven lean
    const LEAN_SPEED_FULL = 5 // m/s — full lean kicks in once moving
    // Lean baseline: bike still leans into a turn at zero forward speed.
    // 0.5 means stationary lean is half full; LEAN_SPEED_FULL+ is full.
    // The user wanted "still leans, even more when moving" — base + (1-base)·speedFrac
    // gives both: visible lean at idle, stronger when racing.
    const LEAN_BASE = 0.5
    // Pitch smoothing rates (exponential approach, units 1/s). Active = stick
    // is being held; release = stick at neutral. Release ≈ active/2 so
    // letting off the stick feels heavy — the bike retains its attitude
    // rather than snapping back to flat. Tuneable; the earlier behaviour
    // was effectively rate=∞ (snap each fixed step). Slowed from the
    // original (12, 3) — the snappier rates read as twitchy on the stick
    // when combined with the closer camera.
    const PITCH_RATE_ACTIVE = 4 // 95% of target in ~750ms
    const PITCH_RATE_RELEASE = 2 // 95% of target in ~1.5s
    const pitchMul = probe.isWater ? 1.0 : 0.7
    {
      const speedNow = Math.hypot(linvel.x, linvel.z)
      const speedFrac = Math.min(speedNow / LEAN_SPEED_FULL, 1)
      const leanScale = LEAN_BASE + (1 - LEAN_BASE) * speedFrac
      // Sign convention is empirical (see hoverSystem header). steer=+1
      // banks INTO the perceived turn; intent.pitch=+1 dives (nose down,
      // negative pitch angle in our YXZ convention).
      const targetRoll = surfaceRollTarget + intent.steer * ROLL_LEAN_LIMIT * leanScale
      const targetPitch = surfacePitchTarget + -intent.pitch * PITCH_LIMIT * pitchMul

      const q0 = rb.rotation()
      const r02 = 2 * (q0.x * q0.z + q0.y * q0.w)
      const r10 = 2 * (q0.x * q0.y + q0.z * q0.w)
      const r11 = 1 - 2 * (q0.x * q0.x + q0.z * q0.z)
      const r12 = 2 * (q0.y * q0.z - q0.x * q0.w)
      const r22 = 1 - 2 * (q0.x * q0.x + q0.y * q0.y)
      const currentRoll = Math.atan2(r10, r11)
      const currentPitch = Math.asin(Math.max(-1, Math.min(1, -r12)))

      // Smooth pitch toward target with active/release rates. Roll snaps
      // (steer-driven lean is meant to read instant). The lerp uses the
      // exponential-time-constant formulation `1 − exp(−rate·dt)` so the
      // motion is frame-rate-independent and stable at any rate.
      const pitchInputActive = Math.abs(intent.pitch) > 0.05
      const pitchRate = pitchInputActive ? PITCH_RATE_ACTIVE : PITCH_RATE_RELEASE
      const pitchAlpha = 1 - Math.exp(-pitchRate * dt)
      const newPitch = currentPitch + (targetPitch - currentPitch) * pitchAlpha
      if (Math.abs(currentRoll - targetRoll) > 1e-5 || Math.abs(currentPitch - newPitch) > 1e-5) {
        const yawAngle = Math.atan2(r02, r22)
        const cy = Math.cos(yawAngle / 2)
        const sy = Math.sin(yawAngle / 2)
        const cp = Math.cos(newPitch / 2)
        const sp = Math.sin(newPitch / 2)
        const cr = Math.cos(targetRoll / 2)
        const sr = Math.sin(targetRoll / 2)
        rb.setRotation(
          {
            w: cy * cp * cr + sy * sp * sr,
            x: cy * sp * cr + sy * cp * sr,
            y: sy * cp * cr - cy * sp * sr,
            z: cy * cp * sr - sy * sp * cr,
          },
          true,
        )
      }
      // Strip rotation around bikeFwd (roll axis) AND bikeRight (pitch
      // axis) from angvel. The kinematic update owns both; physics
      // shouldn't accumulate either. Yaw (rotation around bikeUp /
      // world-Y) is preserved.
      const qNow = rb.rotation()
      const fwdNow = quatRotate(qNow, { x: 0, y: 0, z: 1 })
      const rightNow = quatRotate(qNow, { x: 1, y: 0, z: 0 })
      const angvNow = rb.angvel()
      const rollVel = angvNow.x * fwdNow.x + angvNow.y * fwdNow.y + angvNow.z * fwdNow.z
      const pitchVel = angvNow.x * rightNow.x + angvNow.y * rightNow.y + angvNow.z * rightNow.z
      if (Math.abs(rollVel) > 1e-5 || Math.abs(pitchVel) > 1e-5) {
        rb.setAngvel(
          {
            x: angvNow.x - rollVel * fwdNow.x - pitchVel * rightNow.x,
            y: angvNow.y - rollVel * fwdNow.y - pitchVel * rightNow.y,
            z: angvNow.z - rollVel * fwdNow.z - pitchVel * rightNow.z,
          },
          true,
        )
      }
    }

    const q = rb.rotation()

    // Hover spring only fires while grounded. Above hoverHeight*1.6 the
    // bike is airborne and uses air-lift / gravity instead — the spring's
    // big restoring term would otherwise act as a "leash" that yanks the
    // bike back down the moment it leaves a ramp, killing all hang-time.
    //
    // Underwater branch (M9.23 — Wave Race feel): when the bike has dived
    // below the water surface (groundDistance < 0 on water), replace the
    // hover spring with depth-proportional buoyancy + quadratic drag.
    // Symmetric spring would slam the bike back up the instant it dipped
    // below; instead we let dive momentum carry it under, drag bleeds the
    // momentum off (so deeper = slower), and once velocity is killed the
    // capped buoyancy walks the bike back up — at which point the regular
    // spring takes over and pops it out. Tuning targets a peak depth
    // around 1–2m on a hard dive.
    if (probe.hasSurface && isGrounded) {
      if (probe.isWater && groundDistance < 0) {
        const submersion = -groundDistance
        const BUOYANCY_PER_M = 14
        const BUOYANCY_CAP = 20
        // Asymmetric Y-axis drag: full strength when SINKING (kills dive
        // momentum so the bike actually slows as it reaches max depth),
        // much weaker when RISING so the accumulated buoyancy isn't
        // fought by drag on the way up. Net effect: the bike "loads"
        // potential energy as it sinks and releases it as a slingshot
        // pop on the way out. Horizontal drag stays symmetric — water is
        // thick laterally regardless of which way you're moving through it.
        const DRAG_K_HORIZ = 0.1
        const DRAG_K_SINK = 0.1
        const DRAG_K_RISE = 0.03
        const aBuoy = Math.min(submersion * BUOYANCY_PER_M, BUOYANCY_CAP)
        const speed = Math.hypot(linvel.x, linvel.y, linvel.z)
        const horizDragCoef = -DRAG_K_HORIZ * speed
        const yDragK = linvel.y > 0 ? DRAG_K_RISE : DRAG_K_SINK
        const yDragCoef = -yDragK * speed
        // Cancel gravity (GRAVITY+) so buoyancy is the net upward force —
        // decouples buoyancy tuning from the gravity constant.
        rb.applyImpulse(
          {
            x: linvel.x * horizDragCoef * m * dt,
            y: (GRAVITY + aBuoy + linvel.y * yDragCoef) * m * dt,
            z: linvel.z * horizDragCoef * m * dt,
          },
          true,
        )
      } else {
        // One-sided damp: only damp UPWARD velocity (anti-bounce on a wave
        // crest or when the spring overshoots) — let descents flow through
        // unbraked so dive momentum off a ramp can carry the bike into the
        // underwater branch instead of dying in the spring zone above water.
        //
        // Pitch-modulated ride height: pulling back on the stick (intent.pitch>0,
        // nose up) raises the target hover height; pushing forward (nose down)
        // lowers it. Spring's PD smooths the transition so it feels like the
        // bike "leans into" the new altitude rather than snapping. ±0.5m
        // limit keeps the bike from popping out of the wave field at full lift
        // or grinding the surface at full dive.
        const PITCH_HEIGHT_RANGE = 0.5
        const effectiveHoverHeight = stats.hoverHeight + intent.pitch * PITCH_HEIGHT_RANGE
        const heightError = effectiveHoverHeight - groundDistance
        const dampVy = Math.max(linvel.y, 0)
        const aUp = GRAVITY + heightError * stats.hoverSpring - dampVy * stats.hoverDamp
        rb.applyImpulse({ x: 0, y: aUp * m * dt, z: 0 }, true)
      }
    }

    HoverStateStore.set(eid, {
      groundDistance,
      isGrounded,
      surfaceIsWater: probe.hasSurface && probe.isWater,
    })

    if (!isGrounded) {
      // --- Air control ---
      // Hang-time: counter ~60% of gravity so the bike floats through
      // arcs JetMoto-style instead of dropping like a brick. Effective
      // gravity in air ≈ 10 m/s² vs 25 on the ground — close to
      // real-world Earth pull, well below arcade ground gravity.
      const AIR_LIFT_FRAC = 0.6
      rb.applyImpulse({ x: 0, y: GRAVITY * AIR_LIFT_FRAC * m * dt, z: 0 }, true)

      // Pitch-vectored thrust: airborne thrust pushes along the bike's
      // true forward direction. The bike's visual nose orientation
      // matches its body +Z axis, so:
      //   Q (intent.pitch=-1) → fwd.y < 0 (nose visibly down) → thrust
      //     along fwd pushes the bike DOWN = dives.
      //   E (intent.pitch=+1) → fwd.y > 0 (nose visibly up) → thrust
      //     pushes the bike UP = extends air time.
      // The keyboard.ts comments ("Q = pitch up / jump off a wave")
      // describe the rider's body action ("lean back"), not the bike's
      // pitch — playtest is the source of truth here. Slightly weaker
      // than ground thrust so the player can't infinite-hover by aiming
      // up + boost; speedFalloff in 3D also caps any sustained climb at
      // topSpeed.
      if (Math.abs(intent.throttle) > 0) {
        const fwdAir = quatRotate(q, { x: 0, y: 0, z: 1 })
        const speed3d = Math.hypot(linvel.x, linvel.y, linvel.z)
        const dirAir = intent.throttle >= 0 ? 1 : -1
        const scaleAir = intent.throttle >= 0 ? 1 : stats.reverseScale
        const speedFalloff3d = Math.max(0, 1 - speed3d / stats.topSpeed)
        const boostAir = (intent.boost ? stats.boostMul : 1) * getCurrentBoostMultiplier(eid)
        const AIR_THRUST_MUL = 0.85
        const aAir =
          Math.abs(intent.throttle) *
          stats.accel *
          scaleAir *
          speedFalloff3d *
          boostAir *
          dirAir *
          AIR_THRUST_MUL
        rb.applyImpulse(
          {
            x: fwdAir.x * aAir * m * dt,
            y: fwdAir.y * aAir * m * dt,
            z: fwdAir.z * aAir * m * dt,
          },
          true,
        )
      }

      // Reduced yaw authority for landing alignment.
      const AIR_TURN_MUL = 0.3
      const aTurnAir = -intent.steer * stats.turnTorque * AIR_TURN_MUL
      rb.applyTorqueImpulse({ x: 0, y: aTurnAir * m * dt, z: 0 }, true)

      continue
    }

    const fwd = quatRotate(q, { x: 0, y: 0, z: 1 })

    const speed = vecHorizontalLength({ x: linvel.x, y: 0, z: linvel.z })

    // Brake — opposes current horizontal velocity. Lets the AI (and the
    // player) actually slow down before a corner instead of relying solely
    // on letting off the throttle.
    if (intent.brake > 0 && speed > 0.5) {
      const brakeAccel = intent.brake * 18 // m/s^2 at full brake
      rb.applyImpulse(
        {
          x: -(linvel.x / speed) * brakeAccel * m * dt,
          y: 0,
          z: -(linvel.z / speed) * brakeAccel * m * dt,
        },
        true,
      )
    }

    // Forward thrust (water adds extra drag — slightly less responsive).
    const throttle = intent.throttle
    const direction = throttle >= 0 ? 1 : -1
    const scale = throttle >= 0 ? 1 : stats.reverseScale
    const speedFalloff = Math.max(0, 1 - speed / stats.topSpeed)
    const heldBoost = intent.boost ? stats.boostMul : 1
    const pickupBoost = getCurrentBoostMultiplier(eid)
    const boost = heldBoost * pickupBoost
    const surfaceMul = probe.isWater ? 0.85 : 1.0
    const aThrust =
      Math.abs(throttle) * stats.accel * scale * speedFalloff * boost * direction * surfaceMul
    rb.applyImpulse({ x: fwd.x * aThrust * m * dt, y: 0, z: fwd.z * aThrust * m * dt }, true)

    // Yaw torque around WORLD Y. M9.3 tried bike-local up to avoid the
    // direct projection onto the body's roll axis, but that produced a
    // worse second-order bug: rotating around the tilted local-up axis
    // spins the bike's right vector OUT of the world horizontal plane,
    // so the roll PD (which reads bikeRight.y) registered yaw-induced
    // tilt as roll and pumped real angular velocity into the roll axis.
    // World-Y yaw keeps bikeRight.y at zero across any pitch, so the
    // roll PD only ever sees actual roll. The first-order projection
    // onto the roll axis is small and the strong roll PD eats it.
    const turnMul = probe.isWater ? 1.1 : 1.0
    const aTurn = -intent.steer * stats.turnTorque * turnMul
    rb.applyTorqueImpulse({ x: 0, y: aTurn * m * dt, z: 0 }, true)

    // (Pitch + roll attitude is set kinematically at the top of the loop.
    // Yaw is the only physics-driven attitude axis.)

    // Lateral drag — water has *more* lateral resistance (skis don't slide sideways easily).
    const dragMul = probe.isWater ? 1.4 : 1.0
    const right = quatRotate(q, { x: 1, y: 0, z: 0 })
    const lateralVel = linvel.x * right.x + linvel.z * right.z
    const aDrag = -lateralVel * stats.lateralDrag * dragMul
    rb.applyImpulse({ x: right.x * aDrag * m * dt, y: 0, z: right.z * aDrag * m * dt }, true)
  }
}
