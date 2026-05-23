/**
 * WaveRider entity factory. Builds a kinematic-position Rapier body
 * with a primitive collider sized for the archetype + the ECS
 * components the wave-rider sim system reads each tick.
 *
 * Physics integration:
 *   - Body is `kinematicPositionBased` so the wave-rider system can drive
 *     pose by calling `setNextKinematic{Translation,Rotation}` without
 *     fighting Rapier's solver. Bikes (dynamic) collide with it normally
 *     and feel a real wall.
 *   - Collider sizes are intentionally chunky (cylinder for buoy, capsule-
 *     lying-flat for log) — exact silhouette comes from the render mesh.
 */

import { addComponent, addEntity } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Vec3 } from '@/engine/sim/physics/vec'
import { RBHandle, RBHandleStore, Transform, TransformStore } from '@/game/components'
import {
  WAVE_RIDER_TUNING,
  type WaveRiderArchetypeId,
  WaveRiderStore,
  WaveRiderTag,
} from '@/game/components/wave-rider'

export type CreateWaveRiderOpts = {
  position: Vec3
  archetype: WaveRiderArchetypeId
  /** Initial yaw (rad). Lets authors point logs along a particular
   *  direction; buoys ignore it but accept it for shape symmetry. */
  yaw?: number
}

/** Per-archetype collider sizing. Half-extents / radii in meters. */
const ARCHETYPE_COLLIDERS = {
  buoy: { kind: 'cylinder' as const, halfHeight: 0.45, radius: 0.4 },
  log: { kind: 'cylinder' as const, halfHeight: 1.2, radius: 0.3 },
}

export function createWaveRider(
  sim: SimWorld,
  phys: PhysicsWorld,
  opts: CreateWaveRiderOpts,
): number {
  const eid = addEntity(sim)
  const yaw = opts.yaw ?? 0
  const halfYaw = yaw / 2
  const startQuat = {
    x: 0,
    y: Math.sin(halfYaw),
    z: 0,
    w: Math.cos(halfYaw),
  }

  const rbDesc = phys.rapier.RigidBodyDesc.kinematicPositionBased()
    .setTranslation(opts.position.x, opts.position.y, opts.position.z)
    .setRotation(startQuat)
  const rb = phys.world.createRigidBody(rbDesc)

  const c = ARCHETYPE_COLLIDERS[opts.archetype]
  // Cylinder collider — local Y is the axis. For the log archetype the
  // mesh is rotated so the cylinder reads as horizontal; the collider
  // rotates with the body so the math stays simple.
  const colDesc = phys.rapier.ColliderDesc.cylinder(c.halfHeight, c.radius)
    .setFriction(0.5)
    .setRestitution(0.2)
  phys.world.createCollider(colDesc, rb)

  addComponent(sim, eid, WaveRiderTag)
  addComponent(sim, eid, Transform)
  addComponent(sim, eid, RBHandle)

  RBHandleStore.set(eid, { handle: rb.handle })
  TransformStore.set(eid, {
    x: opts.position.x,
    y: opts.position.y,
    z: opts.position.z,
    qx: startQuat.x,
    qy: startQuat.y,
    qz: startQuat.z,
    qw: startQuat.w,
  })
  WaveRiderStore.set(eid, {
    archetype: opts.archetype,
    tuning: { ...WAVE_RIDER_TUNING[opts.archetype] },
    perturbY: 0,
    perturbYVel: 0,
    tiltDirX: 0,
    tiltDirZ: 0,
    tiltVelX: 0,
    tiltVelZ: 0,
    yawDrift: yaw,
    anchorX: opts.position.x,
    anchorZ: opts.position.z,
  })

  return eid
}
