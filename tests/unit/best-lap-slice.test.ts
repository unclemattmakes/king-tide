import { describe, expect, it } from 'vitest'
import { sliceBestLap } from '../../src/engine/replay/best-lap-slice'
import {
  REPLAY_FLOATS_PER_BIKE,
  REPLAY_VERSION,
  type ReplayEvent,
  type ReplayFile,
  type ReplayFrame,
} from '../../src/engine/replay/format'

function frame(t: number, x: number, bikes = 1): ReplayFrame {
  const floats: number[] = []
  for (let b = 0; b < bikes; b++) {
    // Each slot gets its own marker x so the slicer's "player slot
    // only" guarantee can be checked.
    floats.push(x + b * 1000, 0, 0, 0, 0, 0, 1)
  }
  return { t, bikes: floats }
}

function build(bikes: number, frames: ReplayFrame[], events: ReplayEvent[]): ReplayFile {
  return {
    version: REPLAY_VERSION,
    meta: {
      trackId: 'lagoon',
      trackName: 'Lagoon Loop',
      recordedAt: '2026-05-17T00:00:00.000Z',
      durationSeconds: frames[frames.length - 1]?.t ?? 0,
      finishPosition: null,
      finishTime: null,
      bestLap: null,
    },
    bikes: Array.from({ length: bikes }, (_, i) => ({
      slot: i,
      isPlayer: i === 0,
      variantId: 'racer',
      displayName: `Bike ${i}`,
      bodyColor: 0x336699,
    })),
    sampleRateHz: 30,
    frames,
    events,
  }
}

describe('sliceBestLap', () => {
  it('returns null when there are no lap events', () => {
    const r = build(1, [frame(0, 0), frame(1, 10)], [])
    expect(sliceBestLap(r)).toBeNull()
  })

  it('extracts the fastest of three laps', () => {
    // Three laps: lap 1 = 0..30 (30s), lap 2 = 30..50 (20s, fastest),
    // lap 3 = 50..85 (35s). Frames every 10s.
    const r = build(
      1,
      [
        frame(0, 0),
        frame(10, 1),
        frame(20, 2),
        frame(30, 3),
        frame(40, 4),
        frame(50, 5),
        frame(60, 6),
        frame(70, 7),
        frame(80, 8),
        frame(85, 9),
      ],
      [
        { t: 30, kind: 'lap', slot: 0, lap: 1, lapTime: 30 },
        { t: 50, kind: 'lap', slot: 0, lap: 2, lapTime: 20 },
        { t: 85, kind: 'lap', slot: 0, lap: 3, lapTime: 35 },
      ],
    )
    const slice = sliceBestLap(r)
    expect(slice).not.toBeNull()
    expect(slice!.bestLap).toBe(20)
    expect(slice!.sourceLap).toBe(2)
    expect(slice!.replay.meta.bestLap).toBe(20)
    // Rebased: frame at t=30 → t=0, frame at t=50 → t=20.
    expect(slice!.replay.frames[0]!.t).toBe(0)
    expect(slice!.replay.frames[slice!.replay.frames.length - 1]!.t).toBe(20)
    // x marker for slot 0 lap 2 frames: 3..5.
    expect(slice!.replay.frames[0]!.bikes[0]).toBe(3)
  })

  it('strips other bike slots from the slice', () => {
    const r = build(
      2,
      [frame(0, 0, 2), frame(10, 1, 2), frame(20, 2, 2)],
      [{ t: 20, kind: 'lap', slot: 0, lap: 1, lapTime: 20 }],
    )
    const slice = sliceBestLap(r)
    expect(slice).not.toBeNull()
    // Single-bike output regardless of source bike count.
    expect(slice!.replay.bikes).toHaveLength(1)
    expect(slice!.replay.frames[0]!.bikes.length).toBe(REPLAY_FLOATS_PER_BIKE)
    // Player slot's marker (x = 0 at t=0); the AI slot at x = 1000
    // should NOT appear.
    expect(slice!.replay.frames[0]!.bikes[0]).toBe(0)
  })

  it('rejects lap events with negative tStart (lapTime > t)', () => {
    const r = build(
      1,
      [frame(0, 0), frame(10, 1)],
      // lapTime exceeds the event's t — invalid.
      [{ t: 10, kind: 'lap', slot: 0, lap: 1, lapTime: 15 }],
    )
    expect(sliceBestLap(r)).toBeNull()
  })

  it('falls back to null when the window has fewer than 2 frames', () => {
    const r = build(
      1,
      [frame(0, 0), frame(100, 99)],
      // Lap is real but no frames fall inside [80, 100].
      [{ t: 100, kind: 'lap', slot: 0, lap: 1, lapTime: 20 }],
    )
    // Only frame at t=100 falls in window — that's a single frame.
    expect(sliceBestLap(r)).toBeNull()
  })

  it('ignores lap events from other slots', () => {
    const r = build(
      2,
      [frame(0, 0, 2), frame(10, 1, 2), frame(20, 2, 2)],
      [
        { t: 20, kind: 'lap', slot: 1, lap: 1, lapTime: 20 }, // AI slot
      ],
    )
    expect(sliceBestLap(r, 0)).toBeNull()
    // But slicing the AI slot itself works.
    const slice = sliceBestLap(r, 1)
    expect(slice).not.toBeNull()
  })
})
