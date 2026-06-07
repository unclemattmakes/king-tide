/**
 * `gateFloatsOnWaves` — the shared predicate that decides which checkpoint
 * gates bob on the swell (used by both the render bob and the race-trigger
 * widening, so they always agree).
 */
import { describe, expect, it } from 'vitest'
import { GATE_FLOAT_WATER_BAND_M, gateFloatsOnWaves } from '../../src/game/tracks/gate-float'
import type { Checkpoint, Track } from '../../src/game/tracks/types'

function cpAt(y: number): Checkpoint {
  return {
    index: 0,
    position: { x: 0, y, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    halfWidth: 10,
    height: 6,
  }
}

function track(over: {
  floatGates?: boolean
  water?: { height: number; waveHeight: number; waveFreq: number }
}): Track {
  return { floatGates: false, ...over } as unknown as Track
}

describe('gateFloatsOnWaves', () => {
  it('is false when the track has not opted in', () => {
    expect(gateFloatsOnWaves(track({ floatGates: false }), cpAt(0))).toBe(false)
  })

  it('is true for a gate at the water line when opted in', () => {
    expect(gateFloatsOnWaves(track({ floatGates: true }), cpAt(0))).toBe(true)
  })

  it('is false for a gate raised well above water (auto-off over land)', () => {
    expect(gateFloatsOnWaves(track({ floatGates: true }), cpAt(GATE_FLOAT_WATER_BAND_M + 5))).toBe(
      false,
    )
  })

  it('respects a non-zero water height', () => {
    const t = track({
      floatGates: true,
      water: { height: 20, waveHeight: 1, waveFreq: 1 },
    })
    expect(gateFloatsOnWaves(t, cpAt(20))).toBe(true) // at the raised water line
    expect(gateFloatsOnWaves(t, cpAt(0))).toBe(true) // below water still floats up
    expect(gateFloatsOnWaves(t, cpAt(20 + GATE_FLOAT_WATER_BAND_M + 5))).toBe(false) // on structure
  })
})
