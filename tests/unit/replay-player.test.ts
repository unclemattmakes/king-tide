import { describe, expect, it } from 'vitest'
import type { ReplayFile } from '../../src/engine/replay/format'
import { REPLAY_VERSION } from '../../src/engine/replay/format'
import { createReplayPlayer, makePoseBuffer } from '../../src/engine/replay/player'

function buildReplay(frames: { t: number; bikes: number[] }[], bikeCount = 1): ReplayFile {
  return {
    version: REPLAY_VERSION,
    meta: {
      trackId: 'lagoon',
      trackName: 'Lagoon',
      recordedAt: '2024-01-01T00:00:00.000Z',
      durationSeconds: frames.length > 0 ? frames[frames.length - 1]!.t : 0,
      finishPosition: null,
      finishTime: null,
      bestLap: null,
    },
    bikes: Array.from({ length: bikeCount }, (_, i) => ({
      slot: i,
      isPlayer: i === 0,
      variantId: 'racer',
      displayName: `Bike ${i}`,
      bodyColor: 0xff0000,
    })),
    sampleRateHz: 30,
    frames,
    events: [],
  }
}

describe('replay player', () => {
  it('reports duration from the last frame', () => {
    const replay = buildReplay([
      { t: 0, bikes: [0, 0, 0, 0, 0, 0, 1] },
      { t: 1, bikes: [10, 0, 0, 0, 0, 0, 1] },
    ])
    const p = createReplayPlayer(replay)
    expect(p.duration).toBe(1)
  })

  it('linearly interpolates positions between frames', () => {
    const replay = buildReplay([
      { t: 0, bikes: [0, 0, 0, 0, 0, 0, 1] },
      { t: 1, bikes: [10, 4, -2, 0, 0, 0, 1] },
    ])
    const p = createReplayPlayer(replay)
    p.paused = true
    p.seek(0.5)
    const buf = makePoseBuffer(1)
    p.sample(buf)
    expect(buf[0]!.x).toBeCloseTo(5)
    expect(buf[0]!.y).toBeCloseTo(2)
    expect(buf[0]!.z).toBeCloseTo(-1)
  })

  it('clamps below the first frame and at the last frame', () => {
    const replay = buildReplay([
      { t: 0, bikes: [1, 1, 1, 0, 0, 0, 1] },
      { t: 1, bikes: [9, 9, 9, 0, 0, 0, 1] },
    ])
    const p = createReplayPlayer(replay)
    p.paused = true
    const buf = makePoseBuffer(1)
    p.seek(-5)
    p.sample(buf)
    expect(buf[0]!.x).toBeCloseTo(1)
    p.seek(100)
    p.sample(buf)
    expect(buf[0]!.x).toBeCloseTo(9)
  })

  it('advances time by realDt × speed when not paused', () => {
    const replay = buildReplay([
      { t: 0, bikes: [0, 0, 0, 0, 0, 0, 1] },
      { t: 2, bikes: [20, 0, 0, 0, 0, 0, 1] },
    ])
    const p = createReplayPlayer(replay)
    p.speed = 2
    const buf = makePoseBuffer(1)
    p.tick(0.5, buf) // playtime 1.0 due to 2× speed
    expect(p.time).toBeCloseTo(1)
    expect(buf[0]!.x).toBeCloseTo(10)
  })

  it('slerp keeps quaternions normalized', () => {
    // Identity → 90° around Y. At u=0.5 should be 45° around Y.
    const c = Math.cos(Math.PI / 4)
    const s = Math.sin(Math.PI / 4)
    const replay = buildReplay([
      { t: 0, bikes: [0, 0, 0, 0, 0, 0, 1] },
      { t: 1, bikes: [0, 0, 0, 0, s, 0, c] },
    ])
    const p = createReplayPlayer(replay)
    p.paused = true
    p.seek(0.5)
    const buf = makePoseBuffer(1)
    p.sample(buf)
    const len = Math.hypot(buf[0]!.qx, buf[0]!.qy, buf[0]!.qz, buf[0]!.qw)
    expect(len).toBeCloseTo(1)
    // Half-rotation = 45° → sin(22.5°) on y, cos(22.5°) on w.
    expect(buf[0]!.qy).toBeCloseTo(Math.sin(Math.PI / 8), 4)
    expect(buf[0]!.qw).toBeCloseTo(Math.cos(Math.PI / 8), 4)
  })

  it('takes the short way around for opposite-sign quaternions', () => {
    // q and -q represent the same orientation. Slerp should pick the short
    // path so we don't loop the long way around.
    const replay = buildReplay([
      { t: 0, bikes: [0, 0, 0, 0, 0, 0, 1] },
      { t: 1, bikes: [0, 0, 0, 0, 0, 0, -1] }, // same orientation, double-cover flip
    ])
    const p = createReplayPlayer(replay)
    p.paused = true
    p.seek(0.5)
    const buf = makePoseBuffer(1)
    p.sample(buf)
    // Short-path slerp between q and -q stays on q (both represent identity).
    // Worst case it should not be near the antipode.
    const dot = 0 + 0 + 0 + 1 * buf[0]!.qw
    expect(Math.abs(dot)).toBeGreaterThan(0.9)
  })

  it('handles multiple bike slots', () => {
    const replay = buildReplay(
      [
        {
          t: 0,
          bikes: [
            0,
            0,
            0,
            0,
            0,
            0,
            1, // bike 0
            5,
            0,
            0,
            0,
            0,
            0,
            1, // bike 1
          ],
        },
        {
          t: 1,
          bikes: [10, 0, 0, 0, 0, 0, 1, 15, 0, 0, 0, 0, 0, 1],
        },
      ],
      2,
    )
    const p = createReplayPlayer(replay)
    p.paused = true
    p.seek(0.5)
    const buf = makePoseBuffer(2)
    p.sample(buf)
    expect(buf[0]!.x).toBeCloseTo(5)
    expect(buf[1]!.x).toBeCloseTo(10)
  })
})
