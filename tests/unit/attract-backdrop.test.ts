import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ATTRACT_MIN_SEA_STATE_BEAUFORT,
  ATTRACT_TRACK_ID,
  attractSeaLevel,
  attractSeaStateBeaufort,
} from '@/boot/attract-backdrop'
import { beaufortToAmplitudeScale } from '@/engine/render/sky'
import { buildTrackFromJson } from '@/game/tracks/json-loader'
import type { Track } from '@/game/tracks/types'

/** The shipped menu-backdrop venue, parsed the way the boot parses it —
 *  Mayday Bay (slug `sandbar`): a −1.5 m mean sea with a ±3 m king-tide,
 *  authored at a near-glassy Beaufort 1 for the tutorial race. Reading the
 *  real JSON means a retune of the track's water is felt here, not silently
 *  in the menu. */
const sandbar: Track = buildTrackFromJson(
  JSON.parse(readFileSync(`public/tracks/${ATTRACT_TRACK_ID}.json`, 'utf8')),
)
const SANDBAR_WATER = sandbar.water
const SANDBAR_SKY = sandbar.sky

describe('attract backdrop venue', () => {
  it('is a shipped, art-passed track — not a procedural dev fixture', () => {
    // The menu is the shop window; `lagoon` / `cliffside` are code-built dev
    // fixtures with no environment GLB behind them.
    expect(ATTRACT_TRACK_ID).toBe('sandbar')
    expect(sandbar.environmentGlb).toBeTruthy()
    expect(sandbar.aiSplines.find((s) => s.id === 'main')?.points.length ?? 0).toBeGreaterThan(20)
  })
})

describe('attract backdrop sea level', () => {
  it('holds Mayday Bay at the bottom of its tide swing', () => {
    // mean −1.5 m − 3 m amplitude = the exposed-sandbar read.
    expect(SANDBAR_WATER?.height).toBeCloseTo(-1.5, 6)
    expect(SANDBAR_WATER?.tide?.amplitudeM).toBeCloseTo(3, 6)
    expect(attractSeaLevel(SANDBAR_WATER)).toBeCloseTo(-4.5, 6)
  })

  it('ignores the track-authored start phase', () => {
    // The backdrop is always at low water, whatever phase a race would open
    // on — the menu never advances the tide clock.
    const openingHigh: Track['water'] = {
      height: -1.5,
      tide: { amplitudeM: 3, periodS: 120, phase: 0.25 },
    }
    expect(attractSeaLevel(openingHigh)).toBeCloseTo(-4.5, 6)
  })

  it('falls back to the mean height for a track with no tide', () => {
    expect(attractSeaLevel({ height: -2 })).toBeCloseTo(-2, 6)
    expect(attractSeaLevel({ height: 4, tide: { amplitudeM: 0, periodS: 120 } })).toBeCloseTo(4, 6)
    expect(attractSeaLevel(undefined)).toBe(0)
  })
})

describe('attract backdrop sea state', () => {
  it('lifts a glassy venue to the slight-chop floor', () => {
    expect(SANDBAR_SKY?.seaStateBeaufort).toBe(1)
    expect(attractSeaStateBeaufort(SANDBAR_SKY)).toBe(ATTRACT_MIN_SEA_STATE_BEAUFORT)
    // Sandbar's own Beaufort 1 would run the wave bank at 0.3x; the floor is
    // the 1.0x bank `defaultWaves()` was authored at. Its cove wave-zone
    // (heightMult 0.5) halves that again, so the backdrop lands on a slight
    // chop rather than the near-flat water the tutorial races on.
    expect(beaufortToAmplitudeScale(attractSeaStateBeaufort(SANDBAR_SKY))).toBeCloseTo(1, 6)
    expect(beaufortToAmplitudeScale(1)).toBeLessThan(0.5)
    // The cove zone is what keeps the floor honest: it still halves the bank
    // over the water the broadcast camera actually frames.
    expect(sandbar.waveZones?.[0]?.heightMult).toBeCloseTo(0.5, 6)
  })

  it('leaves a rougher authored sea alone', () => {
    expect(attractSeaStateBeaufort({ seaStateBeaufort: 7 } as Track['sky'])).toBe(7)
  })

  it('treats an unauthored sea state as the race boot does', () => {
    // No `seaStateBeaufort` means no scaling in race-boot, i.e. the 1.0x
    // default bank == Beaufort 4 — which is also the floor.
    expect(attractSeaStateBeaufort(undefined)).toBe(4)
    expect(beaufortToAmplitudeScale(4)).toBeCloseTo(1, 6)
  })
})
