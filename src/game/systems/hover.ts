import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate, vecHorizontalLength } from '@/engine/sim/physics/vec'
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

const MAX_HOVER_PROBE = 6
const GRAVITY = 25 // must match PhysicsWorld gravity magnitude

/**
 * Per-bike: probe ground, apply hover/thrust/steer/lateral-drag.
 * All coefficients are in acceleration units (m/s^2 per unit). Impulses are
 * computed as accel * mass * dt so tuning stays decoupled from mass.
 */
export function hoverSystem(sim: SimWorld, phys: PhysicsWorld): void {
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

    // 1. Ground probe.
    const ray = new phys.rapier.Ray({ x: t.x, y: t.y, z: t.z }, { x: 0, y: -1, z: 0 })
    const hit = phys.world.castRay(ray, MAX_HOVER_PROBE, true, undefined, undefined, undefined, rb)

    let isGrounded = false
    let groundDistance = MAX_HOVER_PROBE

    if (hit) {
      groundDistance = hit.timeOfImpact
      isGrounded = groundDistance < stats.hoverHeight * 1.6

      // PD hover with gravity compensation. At rest at target height, aUp = g
      // exactly cancels gravity. Below target → push up; overshooting → damp.
      const heightError = stats.hoverHeight - groundDistance
      const aUp = GRAVITY + heightError * stats.hoverSpring - linvel.y * stats.hoverDamp
      rb.applyImpulse({ x: 0, y: aUp * m * dt, z: 0 }, true)
    }

    HoverStateStore.set(eid, { groundDistance, isGrounded })

    if (!isGrounded) continue

    // Local +Z is forward.
    const fwd = quatRotate(q, { x: 0, y: 0, z: 1 })

    // 2. Forward thrust with speed-falloff.
    const speed = vecHorizontalLength({ x: linvel.x, y: 0, z: linvel.z })
    const throttle = intent.throttle
    const direction = throttle >= 0 ? 1 : -1
    const scale = throttle >= 0 ? 1 : stats.reverseScale
    const speedFalloff = Math.max(0, 1 - speed / stats.topSpeed)
    const boost = intent.boost ? stats.boostMul : 1
    const aThrust = Math.abs(throttle) * stats.accel * scale * speedFalloff * boost * direction
    rb.applyImpulse({ x: fwd.x * aThrust * m * dt, y: 0, z: fwd.z * aThrust * m * dt }, true)

    // 3. Yaw torque from steer. Note: torque impulse units = N·m·s, applied to angular velocity
    // proportional to inverse moment of inertia. For arcade purposes, we treat turnTorque as
    // an angular acceleration coefficient and convert via mass (rough approximation — the
    // collider's actual inertia is what Rapier uses, but mass scaling keeps tuning stable).
    const aTurn = -intent.steer * stats.turnTorque
    rb.applyTorqueImpulse({ x: 0, y: aTurn * m * dt, z: 0 }, true)

    // 4. Lateral drag — projects sideways velocity, applies counter-impulse.
    const right = quatRotate(q, { x: 1, y: 0, z: 0 })
    const lateralVel = linvel.x * right.x + linvel.z * right.z
    const aDrag = -lateralVel * stats.lateralDrag
    rb.applyImpulse({ x: right.x * aDrag * m * dt, y: 0, z: right.z * aDrag * m * dt }, true)
  }
}
