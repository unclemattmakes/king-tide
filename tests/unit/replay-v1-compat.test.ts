/**
 * Verifies that v1 (legacy, pose-only) replay files still round-trip
 * through the v2 parser + player. The v1 layout has 7 floats per bike
 * (pose only); v2 adds 5 input-state floats and combat tracks.
 *
 * We don't carry a real v1 fixture in the repo — instead we build a v1
 * blob by hand, parse it, and assert the player + reconstructor route
 * through the legacy fallback paths.
 */

import { describe, expect, it } from 'vitest'
import { parseReplay } from '../../src/engine/replay/format'
import { createReplayPlayer, makePoseBuffer } from '../../src/engine/replay/player'

function makeV1Json(): string {
  return JSON.stringify({
    version: 1,
    meta: {
      trackId: 'lagoon',
      trackName: 'Lagoon',
      recordedAt: '2025-01-01T00:00:00.000Z',
      durationSeconds: 1,
      finishPosition: null,
      finishTime: null,
      bestLap: null,
    },
    bikes: [
      {
        slot: 0,
        isPlayer: true,
        variantId: 'racer',
        displayName: 'Racer',
        bodyColor: 0xff0000,
      },
    ],
    sampleRateHz: 30,
    // v1 pose-only — 7 floats per bike, two frames.
    frames: [
      { t: 0, bikes: [0, 0, 0, 0, 0, 0, 1] },
      { t: 1, bikes: [10, 0, 0, 0, 0, 0, 1] },
    ],
    events: [],
  })
}

describe('replay v1 backward compat', () => {
  it('parses a v1 file and flags isLegacyV1', () => {
    const r = parseReplay(makeV1Json())
    expect(r.isLegacyV1).toBe(true)
    expect(r.version).toBe(1)
    expect(r.missiles).toEqual([])
    expect(r.explosions).toEqual([])
  })

  it('player reads pose from v1 frames and reports neutral state slots', () => {
    const r = parseReplay(makeV1Json())
    const p = createReplayPlayer(r)
    p.paused = true
    p.seek(0.5)
    const buf = makePoseBuffer(1)
    p.sample(buf)
    // Pose interpolation works the same on v1.
    expect(buf[0]!.x).toBeCloseTo(5)
    // State slots default to neutral so the reconstructor's legacy
    // fallback path engages cleanly.
    expect(buf[0]!.pitch).toBe(0)
    expect(buf[0]!.throttle).toBe(0)
    expect(buf[0]!.boost).toBe(false)
    expect(buf[0]!.driftDir).toBe(0)
    expect(buf[0]!.driftTier).toBe(0)
  })
})
