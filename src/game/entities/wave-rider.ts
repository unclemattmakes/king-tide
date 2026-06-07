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
 *   - Colliders mirror the prop's own GLB collider descriptors (scaled by
 *     the placement size), so a float collides with its real silhouette.
 *     The archetype-only path (no GLB colliders supplied — e.g. the
 *     `?waveriders=1` test scene) falls back to a chunky primitive
 *     cylinder sized per archetype.
 */

import { addComponent, addEntity } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Vec3 } from '@/engine/sim/physics/vec'
import type { LoadedPropCollider } from '@/game/assets/prop-loader'
import { RBHandle, RBHandleStore, Transform, TransformStore } from '@/game/components'
import {
  WAVE_RIDER_TUNING,
  type WaveRiderArchetypeId,
  WaveRiderStore,
  WaveRiderTag,
  type WaveRiderTuning,
} from '@/game/components/wave-rider'
import { buildPropColliderDesc } from '@/game/entities/prop-collider'

export type CreateWaveRiderOpts = {
  position: Vec3
  /** Initial yaw (rad). Lets authors point logs / hulls along a
   *  particular direction; round floats ignore it but accept it. */
  yaw?: number
  /** Archetype preset (buoy/log). Selects the hand-tuned tuning + the
   *  primitive collider + the primitive render fallback. Omit for
   *  per-instance floats, which pass `tuning` + `colliders` instead. */
  archetype?: WaveRiderArchetypeId
  /** Explicit tuning. Overrides the archetype preset — the per-instance
   *  "float on waves" path passes a size-derived tuning here. */
  tuning?: WaveRiderTuning
  /** The prop's own collider descriptors (from its GLB). When provided +
   *  non-empty, the kinematic body mirrors them (scaled by `size`)
   *  instead of the primitive archetype cylinder, so the float collides
   *  with its real silhouette. */
  colliders?: LoadedPropCollider[]
  /** Placement scale (`Prop.size`) applied to `colliders`. */
  size?: Vec3
}

/** Per-archetype primitive collider sizing for the fallback path (no GLB
 *  colliders supplied — e.g. the `?waveriders=1` test scene). Half-
 *  extents / radii in meters. */
const ARCHETYPE_COLLIDERS = {
  buoy: { halfHeight: 0.45, radius: 0.4 },
  log: { halfHeight: 1.2, radius: 0.3 },
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

  // Prefer the prop's own colliders (per-instance floats + asset props);
  // fall back to the primitive archetype cylinder when none are supplied.
  const size = opts.size ?? { x: 1, y: 1, z: 1 }
  let attached = 0
  if (opts.colliders) {
    for (const c of opts.colliders) {
      const col = buildPropColliderDesc(phys, c, size)
      if (!col) continue
      col.setFriction(0.5).setRestitution(0.2)
      phys.world.createCollider(col, rb)
      attached++
    }
  }
  if (attached === 0) {
    const c = ARCHETYPE_COLLIDERS[opts.archetype ?? 'buoy']
    const colDesc = phys.rapier.ColliderDesc.cylinder(c.halfHeight, c.radius)
      .setFriction(0.5)
      .setRestitution(0.2)
    phys.world.createCollider(colDesc, rb)
  }

  const tuning = opts.tuning ?? WAVE_RIDER_TUNING[opts.archetype ?? 'buoy']

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
    ...(opts.archetype ? { archetype: opts.archetype } : {}),
    tuning: { ...tuning },
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
