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
    const q = rb.rotation()
    const linvel = rb.linvel()
    const dt = phys.fixedDt
    const m = stats.mass

    const probe = probeSurface(phys, field, t.x, t.y, t.z, rb)
    const groundDistance = probe.hasSurface ? t.y - probe.surfaceY : MAX_HOVER_PROBE
    const isGrounded = probe.hasSurface && groundDistance < stats.hoverHeight * 1.6

    if (probe.hasSurface) {
      // PD hover with gravity comp. Same on land or water.
      const heightError = stats.hoverHeight - groundDistance
      const aUp = GRAVITY + heightError * stats.hoverSpring - linvel.y * stats.hoverDamp
      rb.applyImpulse({ x: 0, y: aUp * m * dt, z: 0 }, true)
    }

    HoverStateStore.set(eid, { groundDistance, isGrounded })

    if (!isGrounded) continue

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

    // Yaw torque. Convention: positive steer = right turn (D / right stick / right arrow).
    // Per playtest, this requires NEGATIVE Y torque in Rapier's convention — empirical;
    // my earlier sign analysis was inverted.
    const turnMul = probe.isWater ? 1.1 : 1.0
    const aTurn = -intent.steer * stats.turnTorque * turnMul
    rb.applyTorqueImpulse({ x: 0, y: aTurn * m * dt, z: 0 }, true)

    // Upright stabilizer: torque the bike back toward world-up plus a damping
    // term on the tilting angular velocity. Without the damping, the spring
    // alone would oscillate forever on collisions. Together they're a PD
    // controller on tilt-angle, fast and well-behaved.
    const bikeUp = quatRotate(q, { x: 0, y: 1, z: 0 })
    const STABILIZE_K = 38 // spring (m/s^2 per unit tilt component)
    const STABILIZE_D = 6 // damper (m/s^2 per rad/s of tilting velocity)
    rb.applyTorqueImpulse(
      {
        x: (bikeUp.z * STABILIZE_K - rb.angvel().x * STABILIZE_D) * m * dt,
        y: 0,
        z: (-bikeUp.x * STABILIZE_K - rb.angvel().z * STABILIZE_D) * m * dt,
      },
      true,
    )

    // Lateral drag — water has *more* lateral resistance (skis don't slide sideways easily).
    const dragMul = probe.isWater ? 1.4 : 1.0
    const right = quatRotate(q, { x: 1, y: 0, z: 0 })
    const lateralVel = linvel.x * right.x + linvel.z * right.z
    const aDrag = -lateralVel * stats.lateralDrag * dragMul
    rb.applyImpulse({ x: right.x * aDrag * m * dt, y: 0, z: right.z * aDrag * m * dt }, true)
  }
}
