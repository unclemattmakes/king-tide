/**
 * Race-system teleport guard (docs/m10-11-state-sync.md §11,
 * docs/multiplayer-review.md finding #10).
 *
 * A super-physical per-tick jump (multiplayer snapshot catch-up sweep,
 * OOB respawn, recycled entity slot) whose straight-line path crosses a
 * gate plane must NOT score a checkpoint; ordinary through-the-gate
 * motion must keep scoring exactly as before.
 *
 * Uses the boost-pad suite's minimal Rapier mock — the race system only
 * reads `translation()`.
 */
import { addComponent, addEntity } from 'bitecs'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSimWorld, type SimWorld } from '../../src/engine/sim/ecs/world'
import type { PhysicsWorld } from '../../src/engine/sim/physics/rapier'
import { RBHandle, RBHandleStore } from '../../src/game/components'
import { Racer, RacerStore } from '../../src/game/components/race'
import { createRaceSystem } from '../../src/game/systems/race'
import type { Track } from '../../src/game/tracks/types'

const HANDLE = 1
const DT = 1 / 60

/** Mutable position the mock body reports; tests move it between ticks. */
const pos = { x: 0, y: 1, z: -5 }

function mockPhys(): PhysicsWorld {
  const rb = { translation: () => pos }
  return {
    world: { getRigidBody: (h: number) => (h === HANDLE ? rb : null) },
    fixedDt: DT,
  } as unknown as PhysicsWorld
}

/** Two gates on the z axis, both facing +z, generous trigger windows. */
function makeTrack(): Track {
  const gate = (index: number, z: number) => ({
    index,
    position: { x: 0, y: 1, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    halfWidth: 10,
    height: 5,
  })
  return {
    id: 'teleport-guard-test',
    name: 'Teleport Guard Test',
    lapsToFinish: 3,
    start: { position: { x: 0, y: 1, z: -10 }, yaw: 0 },
    checkpoints: [gate(0, 0), gate(1, 50)],
    surfaces: [],
    pickupSpawns: [],
  } as unknown as Track
}

function spawnRacer(sim: SimWorld): number {
  const eid = addEntity(sim)
  addComponent(sim, eid, RBHandle)
  RBHandleStore.set(eid, { handle: HANDLE })
  addComponent(sim, eid, Racer)
  RacerStore.set(eid, {
    nextCheckpoint: 0,
    checkpointsCrossed: 0,
    lap: 1,
    finished: false,
    forfeited: false,
    raceTime: 0,
  })
  return eid
}

describe('race system teleport guard', () => {
  let sim: SimWorld
  let phys: PhysicsWorld
  let eid: number

  beforeEach(() => {
    sim = createSimWorld({ seed: 7 })
    phys = mockPhys()
    pos.x = 0
    pos.y = 1
    pos.z = -5
    eid = spawnRacer(sim)
  })

  it('still scores an ordinary crossing (sub-threshold per-tick motion)', () => {
    const tick = createRaceSystem(makeTrack())
    // Approach the z=0 gate in 0.4 m steps — physically plausible motion.
    for (let z = -5; z <= 5; z += 0.4) {
      pos.z = z
      tick(sim, phys, DT)
    }
    expect(RacerStore.must(eid).checkpointsCrossed).toBe(1)
    expect(RacerStore.must(eid).nextCheckpoint).toBe(1)
  })

  it('does not score when a teleport sweeps across the gate plane', () => {
    const tick = createRaceSystem(makeTrack())
    // Settle a couple of ticks short of the gate...
    pos.z = -4
    tick(sim, phys, DT)
    pos.z = -3.8
    tick(sim, phys, DT)
    // ...then warp 20 m past it in a single tick (snapshot catch-up /
    // respawn magnitude — far beyond the 5 m/tick threshold).
    pos.z = 16
    tick(sim, phys, DT)
    expect(RacerStore.must(eid).checkpointsCrossed).toBe(0)

    // The guard must also re-seed prevSigned at the landing spot: sitting
    // still (or creeping forward) past the already-behind-us gate must not
    // retroactively score it either.
    pos.z = 16.2
    tick(sim, phys, DT)
    expect(RacerStore.must(eid).checkpointsCrossed).toBe(0)
  })

  it('scores normally again after the warp (next legitimate gate)', () => {
    const tick = createRaceSystem(makeTrack())
    pos.z = -4
    tick(sim, phys, DT)
    pos.z = 16 // warp past gate 0 — not scored
    tick(sim, phys, DT)
    // Ride legitimately through gate 1 at z=50.
    for (let z = 16; z <= 55; z += 0.45) {
      pos.z = z
      tick(sim, phys, DT)
    }
    const racer = RacerStore.must(eid)
    // Gate 0 was skipped by the warp, so gate 0 is still "next" — the
    // sweep through gate 1's plane doesn't count for it. Nothing scored.
    expect(racer.nextCheckpoint).toBe(0)
    expect(racer.checkpointsCrossed).toBe(0)

    // Now loop back and take gate 0 properly: approach from behind it.
    for (let z = 55; z >= -6; z -= 2) {
      pos.z = z // 2 m/tick backwards — below the 5 m threshold, no warp
      tick(sim, phys, DT)
    }
    for (let z = -6; z <= 6; z += 0.45) {
      pos.z = z
      tick(sim, phys, DT)
    }
    expect(RacerStore.must(eid).checkpointsCrossed).toBe(1)
    expect(RacerStore.must(eid).nextCheckpoint).toBe(1)
  })
})
