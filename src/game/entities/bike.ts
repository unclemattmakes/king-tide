import { addComponent, addEntity } from 'bitecs'
import { emptyIntent } from '@/engine/input/intent'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Vec3 } from '@/engine/sim/physics/vec'
import { defaultBikeStats } from '@/game/bikes/stats'
import {
  BikeStats,
  BikeStatsStore,
  BikeTag,
  ControlIntent,
  ControlIntentStore,
  HoverState,
  HoverStateStore,
  PlayerTag,
  RBHandle,
  RBHandleStore,
  Transform,
  TransformStore,
} from '@/game/components'
import { AIController, AIControllerStore, AITag, defaultAIController } from '@/game/components/ai'
import { Racer, RacerStore } from '@/game/components/race'

export type CreateBikeOpts = {
  position: Vec3
  /** Yaw in radians (0 = facing +Z). */
  yaw?: number
  isPlayer?: boolean
  /** If true, attach a Racer component for race tracking. */
  asRacer?: boolean
  /** If set, attaches AI components and follows the named spline. */
  ai?: { splineId: string }
}

export function createBike(sim: SimWorld, phys: PhysicsWorld, opts: CreateBikeOpts): number {
  const eid = addEntity(sim)
  const stats = defaultBikeStats()

  const yaw = opts.yaw ?? 0
  const halfYaw = yaw / 2
  const startQuat = {
    x: 0,
    y: Math.sin(halfYaw),
    z: 0,
    w: Math.cos(halfYaw),
  }
  const rbDesc = phys.rapier.RigidBodyDesc.dynamic()
    .setTranslation(opts.position.x, opts.position.y, opts.position.z)
    .setRotation(startQuat)
    .setLinearDamping(0.05)
    .setAngularDamping(2.5)
  const rb = phys.world.createRigidBody(rbDesc)

  // Capsule body, length along Z (forward).
  const halfHeight = 0.6
  const radius = 0.45
  const colliderDesc = phys.rapier.ColliderDesc.capsule(halfHeight, radius)
    .setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 })
    .setMass(stats.mass)
    .setFriction(0.05)
    .setRestitution(0.05)
  phys.world.createCollider(colliderDesc, rb)

  addComponent(sim, eid, BikeTag)
  addComponent(sim, eid, RBHandle)
  RBHandleStore.set(eid, { handle: rb.handle })
  addComponent(sim, eid, Transform)
  TransformStore.set(eid, {
    x: opts.position.x,
    y: opts.position.y,
    z: opts.position.z,
    qx: startQuat.x,
    qy: startQuat.y,
    qz: startQuat.z,
    qw: startQuat.w,
  })
  addComponent(sim, eid, BikeStats)
  BikeStatsStore.set(eid, stats)
  addComponent(sim, eid, ControlIntent)
  ControlIntentStore.set(eid, emptyIntent())
  addComponent(sim, eid, HoverState)
  HoverStateStore.set(eid, { groundDistance: 0, isGrounded: false })
  if (opts.isPlayer) addComponent(sim, eid, PlayerTag)
  if (opts.ai) {
    addComponent(sim, eid, AITag)
    addComponent(sim, eid, AIController)
    AIControllerStore.set(eid, defaultAIController(opts.ai.splineId))
  }
  if (opts.asRacer) {
    addComponent(sim, eid, Racer)
    RacerStore.set(eid, {
      lap: 1,
      nextCheckpoint: 0,
      checkpointsCrossed: 0,
      finished: false,
      raceTime: 0,
    })
  }

  return eid
}

export function createGround(phys: PhysicsWorld): void {
  const desc = phys.rapier.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0)
  const rb = phys.world.createRigidBody(desc)
  const col = phys.rapier.ColliderDesc.cuboid(500, 0.5, 500).setFriction(0.6)
  phys.world.createCollider(col, rb)
}
