/**
 * Swept gate-crossing: the lateral/vertical window is tested at the point
 * where the prev→cur path pierces the gate plane, not at the post-crossing
 * sample one tick later.
 *
 * The bug this guards: a bike crossing a gate at an angle (leaning through on
 * a drift, or arcing through mid wave-launch) steps a finite distance each
 * tick, so by the frame `signed` first reaches >= 0 it has already slid past
 * the plane — and sideways/vertically with it. Sampling the bounds there
 * rejected clean pass-throughs near a post or up high ("rode through the gate,
 * got no credit"). Testing the bounds at the interpolated pierce point fixes
 * it, while still rejecting paths that truly miss the posts.
 *
 * Reuses the minimal Rapier mock from the lap/teleport suites (the race system
 * only reads `translation()`).
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

/** Mutable position the mock body reports; each test moves it between ticks. */
const pos = { x: 0, y: 1, z: -1 }

function mockPhys(): PhysicsWorld {
  const rb = { translation: () => pos }
  return {
    world: { getRigidBody: (h: number) => (h === HANDLE ? rb : null) },
    fixedDt: DT,
  } as unknown as PhysicsWorld
}

/** One gate at the origin (y=1), facing +z, half-width 4 m, height 6 m. */
function makeTrack(): Track {
  return {
    id: 'gate-sweep-test',
    name: 'Gate Sweep Test',
    lapsToFinish: 3,
    start: { position: { x: 0, y: 1, z: -10 }, yaw: 0 },
    checkpoints: [
      {
        index: 0,
        position: { x: 0, y: 1, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 4,
        height: 6,
      },
    ],
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

describe('race system swept gate crossing', () => {
  let sim: SimWorld
  let phys: PhysicsWorld
  let eid: number
  let tick: (sim: SimWorld, phys: PhysicsWorld, dt: number) => void

  beforeEach(() => {
    sim = createSimWorld({ seed: 11 })
    phys = mockPhys()
    pos.x = 0
    pos.y = 1
    pos.z = -1
    eid = spawnRacer(sim)
    tick = createRaceSystem(makeTrack())
  })

  /** Two ticks: settle at `(x0,y0,z0)` (behind the plane), then step to
   *  `(x1,y1,z1)` (in front). The crossing, if any, scores on the 2nd tick. */
  function step(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    pos.x = x0
    pos.y = y0
    pos.z = z0
    tick(sim, phys, DT)
    pos.x = x1
    pos.y = y1
    pos.z = z1
    tick(sim, phys, DT)
  }

  it('scores when the post-crossing sample drifts past a post but the path threaded it', () => {
    // prev x=3.4 (inside), cur x=4.2 (OUTSIDE half-width 4) — a fast diagonal
    // pass. Pierce point at z=0 is x=3.8 (inside): the bike went through.
    step(3.4, 1, -0.5, 4.2, 1, 0.5)
    expect(RacerStore.must(eid).checkpointsCrossed).toBe(1)
    expect(RacerStore.must(eid).nextCheckpoint).toBe(0) // single-gate loop wraps
  })

  it('scores when an airborne sample overshoots above the gate but the path was inside', () => {
    // prev y=8.2 (inside upper bound height+2=8 → vertical 7.2), cur y=9.2
    // (vertical 8.2, OUTSIDE). Pierce point y=8.7 → vertical 7.7, inside.
    step(0, 8.2, -0.5, 0, 9.2, 0.5)
    expect(RacerStore.must(eid).checkpointsCrossed).toBe(1)
  })

  it('does NOT score when the path pierces the plane outside a post', () => {
    // prev x=4.6, cur x=5.4 — the whole crossing is wide of the +x post.
    // Pierce point x=5.0 (> half-width 4): the bike went around, not through.
    step(4.6, 1, -0.5, 5.4, 1, 0.5)
    expect(RacerStore.must(eid).checkpointsCrossed).toBe(0)
  })

  it('does NOT score when the path pierces outside a post even if the sample drifts back inside', () => {
    // prev x=4.6 (outside), cur x=3.8 (inside) — bike clips wide of the post
    // then curves in. Pierce point x=4.2 (> 4): it never threaded the gate.
    step(4.6, 1, -0.5, 3.8, 1, 0.5)
    expect(RacerStore.must(eid).checkpointsCrossed).toBe(0)
  })

  it('still scores a clean dead-center crossing', () => {
    step(0, 1, -0.5, 0, 1, 0.5)
    expect(RacerStore.must(eid).checkpointsCrossed).toBe(1)
  })
})
