/**
 * M10.11 — applySnapshot unit tests.
 *
 * Exercises the receiver path against a real Rapier world. The codec lives
 * one layer up (transform-snapshot.test.ts); here we assume a decoded
 * `TransformSnapshot` already exists and verify the rigid-body writes:
 *
 *  1. Dynamic body: setTranslation / setRotation immediate; setLinvel set,
 *     setAngvel zeroed.
 *  2. Kinematic body: setNextKinematicTranslation / setNextKinematicRotation
 *     enqueued — verified by stepping the world once and re-reading.
 *  3. Lookup returns null → record silently skipped.
 *  4. Lookup returns an eid with no RBHandle → record silently skipped.
 *
 * No existing unit test boots Rapier (sim-determinism only exercises the
 * PRNG layer; the physics-determinism harness runs as e2e — see
 * sim-determinism.test.ts:6-8). This test takes the cost of `RAPIER.init()`
 * once via `createPhysicsWorld`; vitest's default timeout is plenty for
 * the WASM bootstrap on a dev machine.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { BikeSnapshotRecord, TransformSnapshot } from '../../src/engine/net/transform-snapshot'
import { createSimWorld, type SimWorld } from '../../src/engine/sim/ecs/world'
import { createPhysicsWorld, type PhysicsWorld } from '../../src/engine/sim/physics/rapier'
import { RBHandleStore } from '../../src/game/components'
import { createBike } from '../../src/game/entities/bike'
import { applySnapshot, type SnapshotEidLookup } from '../../src/game/systems/apply-snapshot'

function makeRecord(overrides?: Partial<BikeSnapshotRecord>): BikeSnapshotRecord {
  return {
    ownerPeerId: 0,
    bikeKind: 0,
    bikeIndex: 0,
    flags: 0,
    position: { x: 10, y: 5, z: -7 },
    rotation: { x: 0, y: Math.sin(Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) },
    velocity: { x: 1.5, y: 0, z: -2.25 },
    ...overrides,
  }
}

function makeSnapshot(bikes: BikeSnapshotRecord[]): TransformSnapshot {
  return { senderPeerId: 0, tick: 0, bikes }
}

describe('applySnapshot', () => {
  let sim: SimWorld
  let phys: PhysicsWorld

  beforeAll(async () => {
    // One world is reused across tests; each test spawns fresh entities so
    // RBHandleStore entries don't collide. We're not asserting determinism
    // here, just per-test behavior — sharing the world keeps the suite fast.
    sim = createSimWorld({ seed: 1 })
    phys = await createPhysicsWorld({ gravity: 0 }) // disable gravity so an
    // un-touched dynamic body holds its pose across the world.step() call
    // we use to commit kinematic next-poses.
  })

  it('applies a snapshot to a dynamic body: pos / rot / velocity set, angvel zeroed', () => {
    const eid = createBike(sim, phys, { position: { x: 0, y: 0, z: 0 } })
    const handle = RBHandleStore.get(eid)!.handle
    const rb = phys.world.getRigidBody(handle)!

    // Seed an angular velocity so we can prove the apply zeroed it.
    rb.setAngvel({ x: 5, y: 0, z: 0 }, true)

    const record = makeRecord({ position: { x: 12.34, y: 8, z: -3.5 } })
    const snap = makeSnapshot([record])
    const lookup: SnapshotEidLookup = () => eid

    applySnapshot(sim, phys, snap, lookup)

    const t = rb.translation()
    expect(t.x).toBeCloseTo(12.34, 5)
    expect(t.y).toBeCloseTo(8, 5)
    expect(t.z).toBeCloseTo(-3.5, 5)

    const r = rb.rotation()
    expect(r.x).toBeCloseTo(record.rotation.x, 5)
    expect(r.y).toBeCloseTo(record.rotation.y, 5)
    expect(r.z).toBeCloseTo(record.rotation.z, 5)
    expect(r.w).toBeCloseTo(record.rotation.w, 5)

    const lv = rb.linvel()
    expect(lv.x).toBeCloseTo(1.5, 5)
    expect(lv.y).toBeCloseTo(0, 5)
    expect(lv.z).toBeCloseTo(-2.25, 5)

    const av = rb.angvel()
    expect(av.x).toBe(0)
    expect(av.y).toBe(0)
    expect(av.z).toBe(0)
  })

  it('applies a snapshot to a kinematic body via setNextKinematic*', () => {
    // createBike always creates Dynamic; flip to KinematicPositionBased after
    // spawn (the same path applyHostRole uses on non-host tabs — see
    // docs/m10-11-state-sync.md §5b).
    const eid = createBike(sim, phys, { position: { x: 0, y: 0, z: 0 } })
    const handle = RBHandleStore.get(eid)!.handle
    const rb = phys.world.getRigidBody(handle)!
    rb.setBodyType(phys.rapier.RigidBodyType.KinematicPositionBased, true)

    const target = { x: -4.5, y: 2, z: 9.25 }
    const targetRot = { x: 0, y: Math.sin(Math.PI / 6), z: 0, w: Math.cos(Math.PI / 6) }
    const record = makeRecord({ position: target, rotation: targetRot })
    const snap = makeSnapshot([record])

    applySnapshot(sim, phys, snap, () => eid)

    // Kinematic next-poses are committed on the next physics step.
    phys.step()

    const t = rb.translation()
    expect(t.x).toBeCloseTo(target.x, 4)
    expect(t.y).toBeCloseTo(target.y, 4)
    expect(t.z).toBeCloseTo(target.z, 4)

    const r = rb.rotation()
    expect(r.x).toBeCloseTo(targetRot.x, 4)
    expect(r.y).toBeCloseTo(targetRot.y, 4)
    expect(r.z).toBeCloseTo(targetRot.z, 4)
    expect(r.w).toBeCloseTo(targetRot.w, 4)
  })

  it('silently skips records when the lookup returns null', () => {
    const eid = createBike(sim, phys, { position: { x: 50, y: 0, z: 50 } })
    const handle = RBHandleStore.get(eid)!.handle
    const rb = phys.world.getRigidBody(handle)!
    const before = rb.translation()

    const snap = makeSnapshot([makeRecord({ position: { x: 99, y: 99, z: 99 } })])

    // Lookup never resolves — the apply should be a no-op for this bike.
    expect(() => applySnapshot(sim, phys, snap, () => null)).not.toThrow()

    const after = rb.translation()
    expect(after.x).toBeCloseTo(before.x, 5)
    expect(after.y).toBeCloseTo(before.y, 5)
    expect(after.z).toBeCloseTo(before.z, 5)
  })

  it('silently skips when the resolved eid has no RBHandle', () => {
    const eid = createBike(sim, phys, { position: { x: -20, y: 0, z: 0 } })
    // Strip the RBHandle store entry — simulates a partially-constructed
    // bike or a stale eid that's been torn down.
    expect(RBHandleStore.delete(eid)).toBe(true)

    const snap = makeSnapshot([makeRecord({ position: { x: 0, y: 0, z: 0 } })])
    expect(() => applySnapshot(sim, phys, snap, () => eid)).not.toThrow()
  })
})
