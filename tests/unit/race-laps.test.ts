/**
 * Lap-counting + finish-line path for the race system.
 *
 * The agent review flagged that the lap/finish logic — correct but subtle
 * (first cp-0 crossing starts lap 1; each later cp-0 crossing increments;
 * finish fires when lap > lapsToFinish) — had no direct coverage. This drives
 * a single racer around a 2-gate loop for a full 3-lap race and asserts the
 * lap counter and finish flag at each milestone.
 *
 * Reuses the minimal Rapier mock from the teleport-guard suite (the race
 * system only reads `translation()`).
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
const pos = { x: 0, y: 1, z: -6 }

function mockPhys(): PhysicsWorld {
  const rb = { translation: () => pos }
  return {
    world: { getRigidBody: (h: number) => (h === HANDLE ? rb : null) },
    fixedDt: DT,
  } as unknown as PhysicsWorld
}

/** Gate 0 at z=0, gate 1 at z=50, both facing +z. lapsToFinish = 3. */
function makeTrack(): Track {
  const gate = (index: number, z: number) => ({
    index,
    position: { x: 0, y: 1, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    halfWidth: 10,
    height: 5,
  })
  return {
    id: 'lap-test',
    name: 'Lap Test',
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

describe('race system lap counting + finish', () => {
  let sim: SimWorld
  let phys: PhysicsWorld
  let eid: number
  let tick: (sim: SimWorld, phys: PhysicsWorld, dt: number) => void

  beforeEach(() => {
    sim = createSimWorld({ seed: 3 })
    phys = mockPhys()
    pos.x = 0
    pos.y = 1
    pos.z = -6
    eid = spawnRacer(sim)
    tick = createRaceSystem(makeTrack())
  })

  /** Sweep pos.z from `from` to `to` in sub-teleport-threshold steps. */
  function sweep(from: number, to: number, step: number): void {
    const s = from < to ? Math.abs(step) : -Math.abs(step)
    for (let z = from; s > 0 ? z <= to : z >= to; z += s) {
      pos.z = z
      tick(sim, phys, DT)
    }
  }

  /** Drive one full loop: through gate 0 (+z), gate 1 (+z), then back behind
   *  gate 0 (−z, sub-threshold so it isn't a teleport and isn't a +z cross). */
  function loopThroughGate0ThenAround(): void {
    sweep(-6, 6, 0.45) // cross gate 0 going +z
    sweep(6, 56, 0.45) // cross gate 1 going +z
    sweep(56, -6, 2) // drift back behind gate 0 going −z (no scoring)
  }

  it('counts laps and finishes after lapsToFinish crossings of the line', () => {
    // First loop: first gate-0 crossing starts lap 1 (no increment).
    loopThroughGate0ThenAround()
    expect(RacerStore.must(eid).lap).toBe(1)
    expect(RacerStore.must(eid).finished).toBe(false)

    // Second gate-0 crossing → lap 2.
    loopThroughGate0ThenAround()
    expect(RacerStore.must(eid).lap).toBe(2)
    expect(RacerStore.must(eid).finished).toBe(false)

    // Third → lap 3.
    loopThroughGate0ThenAround()
    expect(RacerStore.must(eid).lap).toBe(3)
    expect(RacerStore.must(eid).finished).toBe(false)

    // Fourth gate-0 crossing pushes lap to 4 (> lapsToFinish=3) → finished.
    sweep(-6, 6, 0.45)
    const racer = RacerStore.must(eid)
    expect(racer.lap).toBe(4)
    expect(racer.finished).toBe(true)
  })

  it('stamps lastCheckpointTime on crossings (monotonic increasing)', () => {
    sweep(-6, 6, 0.45) // gate 0
    const t0 = RacerStore.must(eid).lastCheckpointTime
    expect(t0).toBeGreaterThan(0)
    sweep(6, 56, 0.45) // gate 1
    const t1 = RacerStore.must(eid).lastCheckpointTime!
    expect(t1).toBeGreaterThan(t0!)
  })
})
