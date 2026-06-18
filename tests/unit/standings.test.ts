/**
 * `computeStandings` ordering + tie-break.
 *
 * Regression guard for the live-standings bug: ties at equal progress used to
 * break on `raceTime`, which advances identically for every un-finished racer
 * each tick — so the order was arbitrary and flickered when bikes ran abreast.
 * The fix tie-breaks on `lastCheckpointTime` (earlier arrival = ahead).
 */
import { addComponent, addEntity } from 'bitecs'
import { describe, expect, it } from 'vitest'
import { createSimWorld, type SimWorld } from '../../src/engine/sim/ecs/world'
import { Racer, type RacerData, RacerStore } from '../../src/game/components/race'
import { computeStandings } from '../../src/game/systems/standings'
import type { Track } from '../../src/game/tracks/types'

const track = { checkpoints: [{}, {}, {}] } as unknown as Track // N = 3

function spawn(sim: SimWorld, data: Partial<RacerData>): number {
  const eid = addEntity(sim)
  addComponent(sim, eid, Racer)
  RacerStore.set(eid, {
    lap: 1,
    nextCheckpoint: 0,
    checkpointsCrossed: 0,
    finished: false,
    raceTime: 0,
    forfeited: false,
    ...data,
  })
  return eid
}

describe('computeStandings', () => {
  it('orders by progress descending', () => {
    const sim = createSimWorld({ seed: 1 })
    const back = spawn(sim, { lap: 1, nextCheckpoint: 1 }) // progress 4
    const front = spawn(sim, { lap: 2, nextCheckpoint: 0 }) // progress 6
    const mid = spawn(sim, { lap: 1, nextCheckpoint: 2 }) // progress 5

    const order = computeStandings(sim, track).map((s) => s.eid)
    expect(order).toEqual([front, mid, back])
  })

  it('breaks equal-progress ties by earlier checkpoint arrival, not raceTime', () => {
    const sim = createSimWorld({ seed: 1 })
    // Same progress (lap 1, nextCheckpoint 2), same raceTime (as it would be
    // for two live racers), but the early bird stamped its crossing sooner.
    const late = spawn(sim, {
      nextCheckpoint: 2,
      raceTime: 10,
      lastCheckpointTime: 9.5,
    })
    const early = spawn(sim, {
      nextCheckpoint: 2,
      raceTime: 10,
      lastCheckpointTime: 8.0,
    })

    const standings = computeStandings(sim, track)
    expect(standings.map((s) => s.eid)).toEqual([early, late])
    expect(standings[0]!.position).toBe(1)
    expect(standings[1]!.position).toBe(2)
  })

  it('sorts a racer that has crossed ahead of one still on the grid at equal progress', () => {
    const sim = createSimWorld({ seed: 1 })
    const gridded = spawn(sim, { nextCheckpoint: 0 }) // never crossed → undefined
    const crossed = spawn(sim, { nextCheckpoint: 0, lap: 1, lastCheckpointTime: 5 })
    // Force equal progress: bump both to the same lap/checkpoint.
    RacerStore.set(crossed, { ...RacerStore.must(crossed), nextCheckpoint: 0, lap: 1 })
    RacerStore.set(gridded, { ...RacerStore.must(gridded), nextCheckpoint: 0, lap: 1 })
    const order = computeStandings(sim, track).map((s) => s.eid)
    expect(order).toEqual([crossed, gridded])
  })
})
