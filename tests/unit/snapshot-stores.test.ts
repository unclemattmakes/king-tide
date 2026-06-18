/**
 * Determinism snapshot now hashes sim-carrying component stores, not just
 * Rapier bodies (docs/systems-review.md §1.3). Render-only stores stay out so
 * interpolation can't manufacture false desync mismatches.
 */
import { addComponent, addEntity } from 'bitecs'
import { describe, expect, it } from 'vitest'
import { createSimWorld } from '../../src/engine/sim/ecs/world'
import type { PhysicsWorld } from '../../src/engine/sim/physics/rapier'
import { captureSnapshot, snapshotToString } from '../../src/engine/sim/snapshot'
import type { WaveFieldState } from '../../src/engine/sim/water/wave-field'
import { DriftState, DriftStateStore, Transform, TransformStore } from '../../src/game/components'
import { Racer, RacerStore } from '../../src/game/components/race'

const phys = { world: { getRigidBody: () => null } } as unknown as PhysicsWorld
const wave = { time: 0 } as unknown as WaveFieldState

describe('captureSnapshot store coverage', () => {
  it('includes sim stores and excludes render-only stores', () => {
    const sim = createSimWorld({ seed: 1 })
    const eid = addEntity(sim)
    addComponent(sim, eid, Racer)
    RacerStore.set(eid, {
      lap: 1,
      nextCheckpoint: 0,
      checkpointsCrossed: 0,
      finished: false,
      raceTime: 0,
      forfeited: false,
    })
    addComponent(sim, eid, Transform)
    TransformStore.set(eid, { x: 1, y: 2, z: 3, qx: 0, qy: 0, qz: 0, qw: 1 })

    const names = captureSnapshot(sim, phys, wave).stores.map(([n]) => n)
    expect(names).toContain('Racer')
    expect(names).not.toContain('Transform') // render-only
  })

  it('changes the hash when a gameplay store mutates', () => {
    const sim = createSimWorld({ seed: 1 })
    const eid = addEntity(sim)
    addComponent(sim, eid, DriftState)
    DriftStateStore.set(eid, {
      driftDir: 1,
      chargeS: 0,
      highestTier: 0,
      sinceReleaseS: 0,
      ungroundedDuringDriftS: 0,
      prevLeftDown: false,
      prevRightDown: false,
      releasedThisTick: false,
      releasedTier: 0,
    })
    const before = snapshotToString(captureSnapshot(sim, phys, wave))

    DriftStateStore.set(eid, { ...DriftStateStore.must(eid), chargeS: 1.25, highestTier: 2 })
    const after = snapshotToString(captureSnapshot(sim, phys, wave))

    expect(after).not.toEqual(before)
  })
})
