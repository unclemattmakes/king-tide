import { addComponent, addEntity } from 'bitecs'
import { emptyIntent } from '@/engine/input/intent'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { Vec3 } from '@/engine/sim/physics/vec'
import { defaultBikeStats } from '@/game/bikes/stats'
import {
  BikeStats,
  type BikeStatsData,
  BikeStatsStore,
  BikeTag,
  BoostMeter,
  BoostMeterStore,
  ControlIntent,
  ControlIntentStore,
  GhostTag,
  HoverState,
  HoverStateStore,
  PeerControlled,
  PeerControlledStore,
  PlayerTag,
  RBHandle,
  RBHandleStore,
  Transform,
  TransformStore,
  TrickState,
  TrickStateStore,
} from '@/game/components'
import {
  AIController,
  AIControllerStore,
  type AIDifficulty,
  AITag,
  defaultAIController,
} from '@/game/components/ai'
import { PickupSlot, PickupSlotStore } from '@/game/components/pickup'
import { Racer, RacerStore } from '@/game/components/race'

export type CreateBikeOpts = {
  position: Vec3
  /** Yaw in radians (0 = facing +Z). */
  yaw?: number
  isPlayer?: boolean
  /** If set, the bike is controlled by network peer N (M10.5+). Single-
   *  player local bike gets `peerId: 0`. AI-driven bikes do NOT receive
   *  this — their ControlIntent is overwritten each tick by
   *  `aiControlSystem`. */
  peerId?: number
  /** If true, attach a Racer component for race tracking. */
  asRacer?: boolean
  /** If set, attaches AI components and follows the named spline.
   *  `difficulty` (default 'standard') controls per-AI tuning baked in
   *  at spawn — see `src/game/ai/difficulty.ts`. */
  ai?: { splineId: string; lineOffset?: number; difficulty?: AIDifficulty }
  /** Optional sim-side stat override — used by bike variants. Defaults
   *  to defaultBikeStats() if omitted. */
  stats?: BikeStatsData
  /** Render-only ghost bike (Time Trial). Skips RigidBody + collider +
   *  all sim/race/AI/peer components. The ghost-runner system writes
   *  its Transform each render frame from a replay player. */
  ghost?: boolean
}

export function createBike(sim: SimWorld, phys: PhysicsWorld, opts: CreateBikeOpts): number {
  const eid = addEntity(sim)
  const stats = opts.stats ?? defaultBikeStats()

  const yaw = opts.yaw ?? 0
  const halfYaw = yaw / 2
  const startQuat = {
    x: 0,
    y: Math.sin(halfYaw),
    z: 0,
    w: Math.cos(halfYaw),
  }

  if (opts.ghost) {
    // Render-only entity. Sim/AI/race/pickup systems all gate on tags
    // we deliberately skip below; the bike-render system reads
    // GhostTag and swaps in a transparent material.
    addComponent(sim, eid, BikeTag)
    addComponent(sim, eid, GhostTag)
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
    return eid
  }

  const rbDesc = phys.rapier.RigidBodyDesc.dynamic()
    .setTranslation(opts.position.x, opts.position.y, opts.position.z)
    .setRotation(startQuat)
    .setLinearDamping(0.05)
    .setAngularDamping(2.5)
    // Continuous Collision Detection: at top speed (~28 m/s) plus
    // gravity-fed dives off ramps the capsule moves >0.5m per fixed
    // step (1/60s). Without CCD, the discrete broadphase can miss a
    // thin trimesh surface — `attachTrackColliders` registers a
    // 0-thickness plane today and bikes tunnel through. CCD does a
    // swept-shape check per step, which catches the surface before
    // we punch through. The cost is a few % of physics CPU; cheap
    // for one body. (Slab-extruding spec-driven surfaces in
    // build_track.py is the complementary fix on the geometry side.)
    .setCcdEnabled(true)
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
  HoverStateStore.set(eid, {
    groundDistance: 0,
    isGrounded: false,
    surfaceIsWater: false,
    inputPitch: 0,
  })
  addComponent(sim, eid, TrickState)
  TrickStateStore.set(eid, {
    cooldownSec: 0,
    spinPhase: 0,
    spinAxisX: 0,
    spinAxisY: 0,
    spinAxisZ: 0,
    spinDurationSec: 0,
    prevLeftDown: false,
    prevRightDown: false,
    vyPeak: 0,
    vyPeakTicksAgo: 0,
    hopLockoutActive: false,
    hopLockoutAirborneSeen: false,
    hopLockoutSafetyTicks: 0,
    driftArmedButton: 0,
    driftActive: false,
    driftDirection: 0,
    driftChargeSec: 0,
    driftReleaseTier: 0,
    driftReleaseSerial: 0,
  })
  addComponent(sim, eid, BoostMeter)
  BoostMeterStore.set(eid, {
    charge: 0,
    active: false,
    prevBoostDown: false,
  })
  // Every bike has a pickup slot.
  addComponent(sim, eid, PickupSlot)
  PickupSlotStore.set(eid, { held: null })

  if (opts.isPlayer) addComponent(sim, eid, PlayerTag)
  if (opts.peerId !== undefined) {
    addComponent(sim, eid, PeerControlled)
    PeerControlledStore.set(eid, { peerId: opts.peerId })
  }
  if (opts.ai) {
    addComponent(sim, eid, AITag)
    addComponent(sim, eid, AIController)
    const ctrlOpts: { lineOffset: number; difficulty?: AIDifficulty } = {
      lineOffset: opts.ai.lineOffset ?? 0,
    }
    if (opts.ai.difficulty !== undefined) ctrlOpts.difficulty = opts.ai.difficulty
    AIControllerStore.set(eid, defaultAIController(opts.ai.splineId, ctrlOpts))
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
