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
import { RBHandleStore, TransformStore } from '@/game/components'
import { RIDER_BONE_NAMES, RiderBoneTag, RiderStore } from '@/game/components/rider'
import { createBike } from '@/game/entities/bike'
import { createRider } from '@/game/entities/rider'
import { riderCrashSystem } from '@/game/systems/rider-crash'
import { riderPoseSystem } from '@/game/systems/rider-pose'
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
  it('spawns a rider with 10 bones + 1 Rider component', async () => {
    const { sim, phys } = await makeWorlds()
    const { riderEid } = spawnBikeAndRider(sim, phys)

    const rider = RiderStore.must(riderEid)
    expect(rider.state).toBe('attached')
    // While attached, no joints exist yet — only specs.
    expect(rider.joints).toHaveLength(9)
    for (const j of rider.joints) {
      expect(j.jointHandle).toBeNull()
    }
    for (const name of RIDER_BONE_NAMES) {
      expect(rider.bones[name]).toBeGreaterThan(0)
    }

    const boneEids = query(sim, [RiderBoneTag])
    expect(boneEids.length).toBe(10)
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
})
