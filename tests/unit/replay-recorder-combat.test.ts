/**
 * Verifies that the recorder's v2 combat-recording extensions
 * (`sampleMissiles`, `markMissileDetonated`, `recordExplosion`)
 * aggregate per-frame snapshots into the `missiles` + `explosions`
 * arrays on the finalized ReplayFile, and that those arrays parse
 * back cleanly through `parseReplay`.
 */

import { describe, expect, it } from 'vitest'
import { parseReplay, serializeReplay } from '../../src/engine/replay/format'
import { createReplayRecorder } from '../../src/engine/replay/recorder'

const ZERO_BIKE_FRAME = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]

describe('replay recorder v2 — combat', () => {
  it('aggregates missile snapshots into a single track per simEid', () => {
    const recorder = createReplayRecorder({
      trackId: 'lagoon',
      trackName: 'Lagoon',
      bikes: [
        {
          slot: 0,
          isPlayer: true,
          variantId: 'racer',
          displayName: 'P',
          bodyColor: 0xff0000,
        },
      ],
      sampleRateHz: 30,
    })
    recorder.sample(0, ZERO_BIKE_FRAME)
    recorder.sampleMissiles(0, [{ simEid: 99, x: 1, y: 2, z: 3, vx: 4, vy: 5, vz: 6 }])
    recorder.sample(0.05, ZERO_BIKE_FRAME)
    recorder.sampleMissiles(0.05, [{ simEid: 99, x: 2, y: 3, z: 4, vx: 4, vy: 5, vz: 6 }])
    const file = recorder.finalize({
      finishPosition: null,
      finishTime: null,
      bestLap: null,
    })
    expect(file.missiles).toHaveLength(1)
    const track = file.missiles[0]!
    expect(track.spawnT).toBeCloseTo(0)
    expect(track.endT).toBeCloseTo(0.05)
    expect(track.samples).toHaveLength(14) // 2 sample windows × 7 floats
  })

  it('records detonation position + flag', () => {
    const recorder = createReplayRecorder({
      trackId: 'lagoon',
      trackName: 'Lagoon',
      bikes: [
        {
          slot: 0,
          isPlayer: true,
          variantId: 'racer',
          displayName: 'P',
          bodyColor: 0xff0000,
        },
      ],
      sampleRateHz: 30,
    })
    recorder.sample(0, ZERO_BIKE_FRAME)
    recorder.sampleMissiles(0, [{ simEid: 7, x: 0, y: 0, z: 0, vx: 1, vy: 0, vz: 0 }])
    recorder.markMissileDetonated(7, 0.5, { x: 5, y: 1, z: 0 })
    const file = recorder.finalize({
      finishPosition: null,
      finishTime: null,
      bestLap: null,
    })
    const track = file.missiles[0]!
    expect(track.detonated).toBe(true)
    expect(track.detonatedAt).toEqual([5, 1, 0])
    expect(track.endT).toBeCloseTo(0.5)
  })

  it('round-trips explosion bursts through serialize → parse', () => {
    const recorder = createReplayRecorder({
      trackId: 'lagoon',
      trackName: 'Lagoon',
      bikes: [
        {
          slot: 0,
          isPlayer: true,
          variantId: 'racer',
          displayName: 'P',
          bodyColor: 0xff0000,
        },
      ],
    })
    recorder.recordExplosion({ t: 1.5, x: 1, y: 2, z: 3, color: 0xff5577, lifetime: 0.6 })
    recorder.recordExplosion({ t: 2.0, x: 4, y: 5, z: 6, color: 0x66ff99, lifetime: 0.6 })
    const file = recorder.finalize({
      finishPosition: null,
      finishTime: null,
      bestLap: null,
    })
    const out = parseReplay(serializeReplay(file))
    expect(out.explosions).toHaveLength(2)
    expect(out.explosions[0]).toMatchObject({ t: 1.5, x: 1, color: 0xff5577 })
    expect(out.explosions[1]).toMatchObject({ t: 2.0, x: 4, color: 0x66ff99 })
  })

  it('detonation marker on an unknown simEid is a safe no-op', () => {
    const recorder = createReplayRecorder({
      trackId: 'lagoon',
      trackName: 'Lagoon',
      bikes: [
        {
          slot: 0,
          isPlayer: true,
          variantId: 'racer',
          displayName: 'P',
          bodyColor: 0xff0000,
        },
      ],
    })
    expect(() => recorder.markMissileDetonated(999, 1.0, { x: 0, y: 0, z: 0 })).not.toThrow()
  })
})
