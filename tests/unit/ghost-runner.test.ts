import { describe, expect, it } from 'vitest'
import { REPLAY_VERSION, type ReplayFile } from '../../src/engine/replay/format'
import { TransformStore } from '../../src/game/components'
import { createGhostRunner } from '../../src/game/systems/ghost-runner'

let nextEid = 10000
function fakeEid(): number {
  // Use a high number to avoid clashing with any real test entities.
  return nextEid++
}

function build(frames: { t: number; x: number }[]): ReplayFile {
  return {
    version: REPLAY_VERSION,
    meta: {
      trackId: 'lagoon',
      trackName: 'Lagoon Loop',
      recordedAt: '2026-05-17T00:00:00.000Z',
      durationSeconds: frames[frames.length - 1]?.t ?? 0,
      finishPosition: null,
      finishTime: null,
      bestLap: frames[frames.length - 1]?.t ?? 0,
    },
    bikes: [
      {
        slot: 0,
        isPlayer: true,
        variantId: 'racer',
        displayName: 'Racer',
        bodyColor: 0x336699,
      },
    ],
    sampleRateHz: 30,
    frames: frames.map((f) => ({
      t: f.t,
      bikes: [f.x, 0, 0, 0, 0, 0, 1],
    })),
    events: [],
  }
}

describe('ghost-runner', () => {
  it('plants the ghost at the start pose on construction', () => {
    const eid = fakeEid()
    createGhostRunner({
      ghostEid: eid,
      ghostReplay: build([
        { t: 0, x: 5 },
        { t: 10, x: 105 },
      ]),
    })
    const t = TransformStore.get(eid)
    expect(t?.x).toBeCloseTo(5)
  })

  it('drives the ghost off the player lap time when armed', () => {
    const eid = fakeEid()
    const runner = createGhostRunner({
      ghostEid: eid,
      ghostReplay: build([
        { t: 0, x: 0 },
        { t: 10, x: 100 },
      ]),
    })
    runner.tick(0.016, 2.5, true)
    const t = TransformStore.get(eid)
    expect(t?.x).toBeCloseTo(25) // 25% along the 0..100 lap.
  })

  it('seeks back to t=0 when the player crosses the line', () => {
    const eid = fakeEid()
    const runner = createGhostRunner({
      ghostEid: eid,
      ghostReplay: build([
        { t: 0, x: 0 },
        { t: 10, x: 100 },
      ]),
    })
    // Mid-lap.
    runner.tick(0.016, 7, true)
    expect(TransformStore.get(eid)!.x).toBeCloseTo(70)
    // Player crosses the line — lap time resets toward 0.
    runner.tick(0.016, 0.1, true)
    expect(TransformStore.get(eid)!.x).toBeCloseTo(1)
  })

  it('holds the ghost at start while not armed (pre-countdown)', () => {
    const eid = fakeEid()
    const runner = createGhostRunner({
      ghostEid: eid,
      ghostReplay: build([
        { t: 0, x: 0 },
        { t: 10, x: 100 },
      ]),
    })
    // Try advancing on a high lap time but with arm=false.
    runner.tick(0.016, 8, false)
    expect(TransformStore.get(eid)!.x).toBeCloseTo(0)
  })

  it('reset() returns the ghost to t=0', () => {
    const eid = fakeEid()
    const runner = createGhostRunner({
      ghostEid: eid,
      ghostReplay: build([
        { t: 0, x: 0 },
        { t: 10, x: 100 },
      ]),
    })
    runner.tick(0.016, 6, true)
    expect(TransformStore.get(eid)!.x).toBeCloseTo(60)
    runner.reset()
    expect(TransformStore.get(eid)!.x).toBeCloseTo(0)
  })

  it('clamps when the player lap time exceeds the ghost duration', () => {
    const eid = fakeEid()
    const runner = createGhostRunner({
      ghostEid: eid,
      ghostReplay: build([
        { t: 0, x: 0 },
        { t: 10, x: 100 },
      ]),
    })
    // Player is slower than the ghost — ghost should freeze at the
    // end pose until the player crosses the line.
    runner.tick(0.016, 50, true)
    expect(TransformStore.get(eid)!.x).toBeCloseTo(100)
  })
})
