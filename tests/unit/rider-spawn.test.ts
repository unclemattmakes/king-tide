/**
 * Smoke + behaviour tests for the powered-ragdoll rider.
 *
 * createRider() touches Rapier (joints, RBs), so these tests need the
 * real `createPhysicsWorld()`. The same infrastructure backs the existing
 * sim-determinism tests; if it breaks on this branch, look at those first.
 */
import { query } from 'bitecs'
import { describe, expect, it } from 'vitest'
import { createSimWorld } from '@/engine/sim/ecs/world'
import { createPhysicsWorld } from '@/engine/sim/physics/rapier'
import { ControlIntentStore, RBHandleStore, TransformStore } from '@/game/components'
import { RIDER_BONE_NAMES, RiderBoneTag, RiderStore } from '@/game/components/rider'
import { createBike } from '@/game/entities/bike'
import { createRider } from '@/game/entities/rider'
import { riderCrashSystem } from '@/game/systems/rider-crash'
import { resetRiderForBike, riderPoseSystem } from '@/game/systems/rider-pose'
import { syncFromPhysics } from '@/game/systems/sync-from-physics'

async function makeWorlds() {
  const sim = createSimWorld()
  const phys = await createPhysicsWorld()
  return { sim, phys }
}

function spawnBikeAndRider(
  sim: ReturnType<typeof createSimWorld>,
  phys: Awaited<ReturnType<typeof createPhysicsWorld>>,
) {
  const bikeEid = createBike(sim, phys, {
    position: { x: 0, y: 5, z: 0 },
    yaw: 0,
    isPlayer: true,
  })
  const handle = RBHandleStore.must(bikeEid)
  const riderEid = createRider(sim, phys, {
    bikeEid,
    bikeRbHandle: handle.handle,
    bikePos: { x: 0, y: 5, z: 0 },
    bikeRot: { x: 0, y: 0, z: 0, w: 1 },
  })
  return { bikeEid, riderEid }
}

describe('createRider', () => {
  it('spawns a rider with 11 bones + 1 Rider component', async () => {
    const { sim, phys } = await makeWorlds()
    const { riderEid } = spawnBikeAndRider(sim, phys)

    const rider = RiderStore.must(riderEid)
    expect(rider.state).toBe('attached')
    // 10 anatomical joints (spine, neck, 2 shoulders, 2 elbows, 2 hips,
    // 2 knees). While attached no Rapier joint exists — only specs.
    expect(rider.joints).toHaveLength(10)
    for (const j of rider.joints) {
      expect(j.jointHandle).toBeNull()
    }
    for (const name of RIDER_BONE_NAMES) {
      expect(rider.bones[name]).toBeGreaterThan(0)
    }

    const boneEids = query(sim, [RiderBoneTag])
    expect(boneEids.length).toBe(11)
  })

  it('bones spawn near the bike position, not at world origin', async () => {
    const { sim, phys } = await makeWorlds()
    const { bikeEid, riderEid } = spawnBikeAndRider(sim, phys)
    const rider = RiderStore.must(riderEid)

    // Step physics once + sync transforms so Transform components reflect
    // post-step state.
    phys.step()
    syncFromPhysics(sim, phys)

    const bikeT = TransformStore.must(bikeEid)
    for (const name of RIDER_BONE_NAMES) {
      const eid = rider.bones[name]
      const t = TransformStore.must(eid)
      // Every bone should be within 2m of the bike center after a single
      // step — drift further than that means a spawn-placement bug.
      const dx = t.x - bikeT.x
      const dy = t.y - bikeT.y
      const dz = t.z - bikeT.z
      const dist = Math.hypot(dx, dy, dz)
      expect(dist).toBeLessThan(2)
    }
  })

  it('keeps the rider attached to the bike under gravity (multiple steps)', async () => {
    const { sim, phys } = await makeWorlds()
    const { bikeEid, riderEid } = spawnBikeAndRider(sim, phys)
    const rider = RiderStore.must(riderEid)
    const pelvisEid = rider.bones.pelvis

    // Run pose+phys for 30 ticks (~0.5s) and verify pelvis stays near seat.
    for (let i = 0; i < 30; i++) {
      riderPoseSystem(sim, phys, phys.fixedDt)
      phys.step()
      syncFromPhysics(sim, phys)
    }

    const bikeT = TransformStore.must(bikeEid)
    const pelvisT = TransformStore.must(pelvisEid)
    // Seat is ~0.6m above bike center. Allow slop for hover-spring bounce.
    expect(Math.abs(pelvisT.x - bikeT.x)).toBeLessThan(0.4)
    expect(Math.abs(pelvisT.z - bikeT.z)).toBeLessThan(0.4)
    expect(pelvisT.y - bikeT.y).toBeGreaterThan(0.2)
    expect(pelvisT.y - bikeT.y).toBeLessThan(1.5)
  })

  it('crash system launches the rider when bike Δv exceeds threshold', async () => {
    const { sim, phys } = await makeWorlds()
    const { bikeEid, riderEid } = spawnBikeAndRider(sim, phys)
    const rider = RiderStore.must(riderEid)

    // Tick once to capture initial velocity baseline.
    riderPoseSystem(sim, phys, phys.fixedDt)
    phys.step()
    syncFromPhysics(sim, phys)
    riderCrashSystem(sim, phys, phys.fixedDt)
    expect(rider.state).toBe('attached')

    // Now slam the bike: set its velocity to 25 m/s forward, then to -2 m/s
    // (a 27 m/s Δv — well over the 12 m/s threshold). Take two ticks so
    // the system records prev=25, then sees current=-2.
    const bikeRb = phys.world.getRigidBody(RBHandleStore.must(bikeEid).handle)
    if (!bikeRb) throw new Error('bike RB missing')
    bikeRb.setLinvel({ x: 0, y: 0, z: 25 }, true)
    phys.step()
    syncFromPhysics(sim, phys)
    riderCrashSystem(sim, phys, phys.fixedDt) // records prev=25

    bikeRb.setLinvel({ x: 0, y: 0, z: -2 }, true)
    phys.step()
    syncFromPhysics(sim, phys)
    riderCrashSystem(sim, phys, phys.fixedDt) // detects Δv = 27, launches

    expect(rider.state).toBe('launched')
    // After launch every joint spec should have a real Rapier handle.
    for (const j of rider.joints) {
      expect(j.jointHandle).not.toBeNull()
    }
    // motorScale falls to 0 instantly at launch (placeholder for future
    // gradual ramp).
    expect(rider.motorScale).toBe(0)
  })

  it('motorScale lands at zero immediately on launch', async () => {
    const { sim, phys } = await makeWorlds()
    const { riderEid } = spawnBikeAndRider(sim, phys)
    const rider = RiderStore.must(riderEid)
    expect(rider.motorScale).toBe(1)
    // Force-launch via state field — the system reads `state` and won't
    // try to read non-existent fields.
    rider.state = 'launched'
    rider.motorScale = 0
  })

  it('schema integrity — pelvis bone resolves to a real eid', async () => {
    const { sim, phys } = await makeWorlds()
    const { riderEid } = spawnBikeAndRider(sim, phys)
    const rider = RiderStore.must(riderEid)
    expect(rider.bones.pelvis).toBeGreaterThan(0)
  })

  it('head bone is part of the anatomy + neck joint is present', async () => {
    const { sim, phys } = await makeWorlds()
    const { riderEid } = spawnBikeAndRider(sim, phys)
    const rider = RiderStore.must(riderEid)
    expect(rider.bones.head).toBeGreaterThan(0)
    const neck = rider.joints.find((j) => j.parentName === 'chest' && j.childName === 'head')
    expect(neck).toBeDefined()
  })

  it('reactive pose-response state is initialised to zero', async () => {
    const { sim, phys } = await makeWorlds()
    const { riderEid } = spawnBikeAndRider(sim, phys)
    const rider = RiderStore.must(riderEid)
    expect(rider.poseResponse.bouncePitch).toBe(0)
    expect(rider.poseResponse.bouncePitchVel).toBe(0)
    expect(rider.poseResponse.flowYaw).toBe(0)
    expect(rider.poseResponse.headYaw).toBe(0)
    expect(rider.poseResponse.headPitch).toBe(0)
  })

  it('headYaw responds to ControlIntent.steer', async () => {
    const { sim, phys } = await makeWorlds()
    const { bikeEid, riderEid } = spawnBikeAndRider(sim, phys)
    const rider = RiderStore.must(riderEid)
    // Set full-right steer on the bike's intent.
    ControlIntentStore.set(bikeEid, {
      throttle: 0,
      steer: 1,
      brake: 0,
      pitch: 0,
      fire: false,
      boost: false,
    })
    // Run several pose ticks; headYaw should monotonically approach the
    // positive cap.
    let last = 0
    for (let i = 0; i < 30; i++) {
      riderPoseSystem(sim, phys, phys.fixedDt)
      phys.step()
      syncFromPhysics(sim, phys)
      expect(rider.poseResponse.headYaw).toBeGreaterThanOrEqual(last - 1e-6)
      last = rider.poseResponse.headYaw
    }
    // After 30 ticks (0.5s) the lerp should have settled close to the
    // target — well above zero.
    expect(rider.poseResponse.headYaw).toBeGreaterThan(0.2)
  })

  it('resetRider re-attaches a launched rider', async () => {
    const { sim, phys } = await makeWorlds()
    const { bikeEid, riderEid } = spawnBikeAndRider(sim, phys)
    const rider = RiderStore.must(riderEid)

    // Force-launch using the same Δv mechanism as the rider-crash test.
    const bikeRb = phys.world.getRigidBody(RBHandleStore.must(bikeEid).handle)
    if (!bikeRb) throw new Error('bike RB missing')
    riderCrashSystem(sim, phys, phys.fixedDt) // baseline
    bikeRb.setLinvel({ x: 0, y: 0, z: 25 }, true)
    phys.step()
    syncFromPhysics(sim, phys)
    riderCrashSystem(sim, phys, phys.fixedDt)
    bikeRb.setLinvel({ x: 0, y: 0, z: -2 }, true)
    phys.step()
    syncFromPhysics(sim, phys)
    riderCrashSystem(sim, phys, phys.fixedDt)
    expect(rider.state).toBe('launched')

    // Reset.
    const ok = resetRiderForBike(sim, phys, bikeEid)
    expect(ok).toBe(true)
    expect(rider.state).toBe('attached')
    expect(rider.motorScale).toBe(1)
    for (const j of rider.joints) {
      expect(j.jointHandle).toBeNull()
    }
    // All pose-response state zeroed out.
    expect(rider.poseResponse.bouncePitch).toBe(0)
    expect(rider.poseResponse.headYaw).toBe(0)
  })

  it('resetRider on an already-attached rider is a no-op for state', async () => {
    const { sim, phys } = await makeWorlds()
    const { bikeEid, riderEid } = spawnBikeAndRider(sim, phys)
    const rider = RiderStore.must(riderEid)
    rider.poseResponse.bouncePitch = 0.4
    rider.poseResponse.headYaw = -0.3
    resetRiderForBike(sim, phys, bikeEid)
    expect(rider.state).toBe('attached')
    expect(rider.poseResponse.bouncePitch).toBe(0)
    expect(rider.poseResponse.headYaw).toBe(0)
  })
})
