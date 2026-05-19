/**
 * AI pump-hint binding — verifies `buildPumpHints` only flags spline
 * indices that lie inside a "heavy" wave zone, honours the blend
 * radius, ignores low-amplitude zones, and exposes the right
 * fast-path metadata for `hasAnyHints`.
 *
 * Companion to the integration the AI controller does in
 * `ai-control.ts`: those hints gate whether a tick can fire a pump,
 * so getting the index set right is what makes "Hard AI pumps where
 * the wave zones tell them to" actually work.
 */

import { describe, expect, it } from 'vitest'
import { DIFFICULTY_TUNING } from '../../src/game/ai/difficulty'
import { buildPumpHints, DEFAULT_MIN_HEIGHT_MULT, hasAnyHints } from '../../src/game/ai/pump-hints'
import type { AISpline, WaveZone } from '../../src/game/tracks/types'

const IDENTITY_QUAT = { x: 0, y: 0, z: 0, w: 1 }

function spline(points: { x: number; y: number; z: number }[]): AISpline {
  return { id: 'main', points }
}

function zone(overrides: Partial<WaveZone>): WaveZone {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: IDENTITY_QUAT,
    halfWidth: 10,
    halfHeight: 5,
    halfDepth: 10,
    heightMult: 2,
    freqMult: 1,
    blendRadiusM: 2,
    ...overrides,
  }
}

describe('buildPumpHints', () => {
  it('returns all-false on an empty zone list', () => {
    const hints = buildPumpHints({
      spline: spline([
        { x: 0, y: 0, z: 0 },
        { x: 5, y: 0, z: 0 },
      ]),
      zones: [],
    })
    expect(hints).toEqual([false, false])
    expect(hasAnyHints(hints)).toBe(false)
  })

  it('flags indices inside a heavy zone, not those outside', () => {
    const hints = buildPumpHints({
      spline: spline([
        { x: 0, y: 0, z: 0 }, // inside (OBB centre)
        { x: 9, y: 0, z: 0 }, // inside (OBB edge)
        { x: 50, y: 0, z: 0 }, // outside (no blend reach)
      ]),
      zones: [zone({})],
    })
    expect(hints).toEqual([true, true, false])
    expect(hasAnyHints(hints)).toBe(true)
  })

  it('includes the blend-radius soft edge so the AI arms before the OBB face', () => {
    // OBB half-width = 10, blend = 5, so points up to x=15 should flag.
    const hints = buildPumpHints({
      spline: spline([
        { x: 11, y: 0, z: 0 }, // inside blend ring
        { x: 14.5, y: 0, z: 0 }, // edge of blend ring
        { x: 20, y: 0, z: 0 }, // past blend ring
      ]),
      zones: [zone({ blendRadiusM: 5 })],
    })
    expect(hints[0]).toBe(true)
    expect(hints[1]).toBe(true)
    expect(hints[2]).toBe(false)
  })

  it('ignores zones at or below the height-mult threshold', () => {
    const hints = buildPumpHints({
      spline: spline([{ x: 0, y: 0, z: 0 }]),
      // Cosmetic surf zone — heightMult just under default → no hint.
      zones: [zone({ heightMult: DEFAULT_MIN_HEIGHT_MULT })],
    })
    expect(hints).toEqual([false])
  })

  it('respects a custom minHeightMult override', () => {
    const hints = buildPumpHints({
      spline: spline([{ x: 0, y: 0, z: 0 }]),
      zones: [zone({ heightMult: 1.5 })],
      minHeightMult: 2, // raise the bar — 1.5 no longer qualifies
    })
    expect(hints).toEqual([false])
  })

  it('unions hints across multiple heavy zones', () => {
    const hints = buildPumpHints({
      spline: spline([
        { x: -30, y: 0, z: 0 }, // in zone A only
        { x: 0, y: 0, z: 0 }, // in neither
        { x: 30, y: 0, z: 0 }, // in zone B only
      ]),
      zones: [
        zone({ position: { x: -30, y: 0, z: 0 } }),
        zone({ position: { x: 30, y: 0, z: 0 } }),
      ],
    })
    expect(hints).toEqual([true, false, true])
  })

  it('honours yawed OBBs — yawing a long thin zone moves which spline points flag', () => {
    // Long thin OBB along local-X: half-width 20, half-depth 3.
    // World-axis-aligned (yaw = 0): a point at (15, 0, 0) is inside;
    //   (0, 0, 15) is outside.
    // Yawed 90°: local-X axis now points along world +Z, so the same
    //   relative positions swap — (15, 0, 0) drops outside,
    //   (0, 0, 15) lands inside.
    const longThin: Partial<WaveZone> = {
      halfWidth: 20,
      halfDepth: 3,
      blendRadiusM: 0.5, // tight, so we test the OBB itself
    }
    const unrotated = zone(longThin)
    const hintsUnrotated = buildPumpHints({
      spline: spline([
        { x: 15, y: 0, z: 0 }, // along local-X — inside
        { x: 0, y: 0, z: 15 }, // along local-Z — far outside
      ]),
      zones: [unrotated],
    })
    expect(hintsUnrotated).toEqual([true, false])

    // Now yaw the same box 90° — the long axis aligns with world +Z.
    const yaw = Math.PI / 2
    const yawed = zone({
      ...longThin,
      rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
    })
    const hintsYawed = buildPumpHints({
      spline: spline([
        { x: 15, y: 0, z: 0 },
        { x: 0, y: 0, z: 15 },
      ]),
      zones: [yawed],
    })
    expect(hintsYawed).toEqual([false, true])
  })

  it('hasAnyHints fast-paths on an all-false array', () => {
    expect(hasAnyHints([])).toBe(false)
    expect(hasAnyHints([false, false, false])).toBe(false)
    expect(hasAnyHints([false, true, false])).toBe(true)
  })
})

describe('DIFFICULTY_TUNING — pump fields', () => {
  it('casual disables pumps via an unreachable vy threshold', () => {
    expect(DIFFICULTY_TUNING.casual.pumpVyThreshold).toBe(Number.POSITIVE_INFINITY)
    expect(DIFFICULTY_TUNING.casual.pumpPitchStrength).toBe(0)
  })

  it('hard pumps at lower vy than standard', () => {
    expect(DIFFICULTY_TUNING.hard.pumpVyThreshold).toBeLessThan(
      DIFFICULTY_TUNING.standard.pumpVyThreshold,
    )
    expect(DIFFICULTY_TUNING.hard.pumpPitchStrength).toBeGreaterThan(
      DIFFICULTY_TUNING.standard.pumpPitchStrength,
    )
  })

  it('non-casual thresholds sit inside the player wave-pump observer window (minVy..vyCeiling)', () => {
    // Mirrors `DEFAULT_DETECTOR_TUNING` in wave-pump-observer.ts —
    // keeps the AI's pump firing inside the same vy band the player
    // perceives as a "clean pump".
    const playerMinVy = 1.5
    const playerVyCeiling = 7
    expect(DIFFICULTY_TUNING.standard.pumpVyThreshold).toBeGreaterThanOrEqual(0)
    expect(DIFFICULTY_TUNING.standard.pumpVyThreshold).toBeLessThanOrEqual(playerVyCeiling)
    expect(DIFFICULTY_TUNING.standard.pumpVyThreshold).toBeCloseTo(playerMinVy, 1)
    expect(DIFFICULTY_TUNING.hard.pumpVyThreshold).toBeGreaterThan(0)
    expect(DIFFICULTY_TUNING.hard.pumpVyThreshold).toBeLessThan(playerVyCeiling)
  })
})
