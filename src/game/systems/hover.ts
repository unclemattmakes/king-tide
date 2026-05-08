import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate, vecHorizontalLength } from '@/engine/sim/physics/vec'
import { sampleHeight, sampleSurface, type WaveFieldState } from '@/engine/sim/water/wave-field'
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
 * Surface probe: looks below the bike for the closest "ride surface".
 * Either a hard physical collider (raycast) or the wave field water surface,
 * whichever is *higher* (closer to the bike) wins. This unifies driving on
 * land and driving on water — same controller, different surface y.
 */
function probeSurface(
  phys: PhysicsWorld,
  field: WaveFieldState | null,
  fromX: number,
  fromY: number,
  fromZ: number,
  ignore: ReturnType<PhysicsWorld['world']['getRigidBody']>,
): { surfaceY: number; isWater: boolean; hasSurface: boolean } {
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

    // Surface alignment: sample the normal under the bike so the chassis can
    // sit perpendicular to the wave it's riding (or to the ground). For
    // water we have an analytic gradient via sampleSurface; for the flat
    // island top the world up vector is good enough. When airborne we don't
    // know what surface the bike is heading toward, so the targets stay 0
    // and the bike just holds its current attitude.
    let surfacePitchTarget = 0
    let surfaceRollTarget = 0
    if (isGrounded) {
      let nx = 0
      let ny = 1
      let nz = 0
      if (probe.isWater && field) {
        const ws = sampleSurface(field, t.x, t.z)
        nx = ws.nx
        ny = ws.ny
        nz = ws.nz
      }
      // Project normal into the bike's yawed (but unrolled, unpitched) frame.
      // Need the yaw, which we'll also use for the kinematic block below.
      const q0_ = rb.rotation()
      const r02_ = 2 * (q0_.x * q0_.z + q0_.y * q0_.w)
      const r22_ = 1 - 2 * (q0_.x * q0_.x + q0_.y * q0_.y)
      const yaw_ = Math.atan2(r02_, r22_)
      const cy_ = Math.cos(yaw_)
      const sy_ = Math.sin(yaw_)
      // Components of the normal along bike-right and bike-fwd in the
      // horizontal plane (the bike's yaw direction).
      const nR = nx * cy_ - nz * sy_
      const nZ = nx * sy_ + nz * cy_
      // Altitude-faded follow: skimming the surface fully tracks terrain;
      // riding high smooths out into a hover. Linear from 1.0 at the
      // surface to 0.0 at the grounded/airborne boundary, so at nominal
      // hover (groundDistance ≈ hoverHeight) the bike inherits ~37% of
      // its base surfaceFollow. Dipping into a wave trough kicks the
      // factor back up; cresting a wave eases it off.
      const surfFadeFar = stats.hoverHeight * 1.6
      const altitudeFactor = Math.max(0, Math.min(1, 1 - groundDistance / surfFadeFar))
      const followNow = stats.surfaceFollow * altitudeFactor
      // For YXZ Euler with bike-up = N: γ = -asin(nR), β = atan2(nZ, ny).
      // (Derived from R_y(yaw) R_x(β) R_z(γ) * (0,1,0) ≈ (-sin γ, cos β cos γ,
      // sin β cos γ) in the yawed frame, matched component-wise to N.)
      surfaceRollTarget = followNow * -Math.asin(Math.max(-1, Math.min(1, nR)))
      surfacePitchTarget = followNow * Math.atan2(nZ, ny)
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
    const pitchMul = probe.isWater ? 1.0 : 0.7
    {
      const speedNow = Math.hypot(linvel.x, linvel.z)
      const leanScale = Math.min(speedNow / LEAN_SPEED_FULL, 1)
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
      if (
        Math.abs(currentRoll - targetRoll) > 1e-5 ||
        Math.abs(currentPitch - targetPitch) > 1e-5
      ) {
        const yawAngle = Math.atan2(r02, r22)
        const cy = Math.cos(yawAngle / 2)
        const sy = Math.sin(yawAngle / 2)
        const cp = Math.cos(targetPitch / 2)
        const sp = Math.sin(targetPitch / 2)
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
    if (probe.hasSurface && isGrounded) {
      const heightError = stats.hoverHeight - groundDistance
      const aUp = GRAVITY + heightError * stats.hoverSpring - linvel.y * stats.hoverDamp
      rb.applyImpulse({ x: 0, y: aUp * m * dt, z: 0 }, true)
    }

    HoverStateStore.set(eid, { groundDistance, isGrounded })

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
