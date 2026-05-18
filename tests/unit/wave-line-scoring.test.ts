/**
 * Wave-line shimmer — pure scoring + sample-fan layout.
 *
 * Covers:
 *  - `scorePumpability` saturates / floors correctly and tolerates
 *    non-finite or zero-ceiling inputs.
 *  - `buildSampleFan` lays the fan in front of the player heading,
 *    every sample sits between minRange and maxRange, and the fan
 *    width never exceeds the expected half-angle.
 *  - `buildSampleFan` is allocation-free across ticks (mutates the
 *    supplied buffer in place).
 *  - Degenerate forward input (zero length) keeps the buffer shape
 *    stable rather than NaN-ing the world coords.
 *  - The settings setter round-trips through localStorage with the
 *    rest of `playerSettings`.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLAYER_SETTINGS,
  loadPlayerSettings,
  playerSettings,
  savePlayerSettings,
  setWaveLineIntensity,
} from '../../src/engine/player-settings'
import {
  buildSampleFan,
  DEFAULT_FAN_CONFIG,
  type FanConfig,
  makeFanBuffer,
  scorePumpability,
} from '../../src/engine/render/wave-line-scoring'

describe('scorePumpability', () => {
  it('returns 0 for non-positive vy', () => {
    expect(scorePumpability(0)).toBe(0)
    expect(scorePumpability(-1)).toBe(0)
    expect(scorePumpability(-100)).toBe(0)
  })

  it('saturates at 1 once vy >= ceiling', () => {
    expect(scorePumpability(6, 6)).toBe(1)
    expect(scorePumpability(7, 6)).toBe(1)
    expect(scorePumpability(99, 6)).toBe(1)
  })

  it('is linear between 0 and the ceiling', () => {
    expect(scorePumpability(3, 6)).toBeCloseTo(0.5, 6)
    expect(scorePumpability(1.5, 6)).toBeCloseTo(0.25, 6)
  })

  it('uses the default ceiling when omitted', () => {
    expect(scorePumpability(3)).toBeCloseTo(0.5, 6)
    expect(scorePumpability(6)).toBe(1)
  })

  it('tolerates non-finite or pathological inputs', () => {
    // Non-finite vy falls back to 0 — the wave field shouldn't ever
    // produce these, but we don't want a numerical edge case to spike
    // the HUD pip to a fake "lock" reading.
    expect(scorePumpability(Number.NaN)).toBe(0)
    expect(scorePumpability(Number.POSITIVE_INFINITY, 6)).toBe(0)
    expect(scorePumpability(1, 0)).toBe(0)
    expect(scorePumpability(1, -1)).toBe(0)
  })
})

describe('makeFanBuffer', () => {
  it('allocates one slot per along × across product', () => {
    const cfg: FanConfig = { ...DEFAULT_FAN_CONFIG, samplesAlong: 4, samplesAcross: 3 }
    const buf = makeFanBuffer(cfg)
    expect(buf.length).toBe(12)
    expect(buf[0]!.index).toBe(0)
    expect(buf[11]!.index).toBe(11)
  })

  it('clamps zero / negative counts to at least one slot', () => {
    const cfg: FanConfig = { ...DEFAULT_FAN_CONFIG, samplesAlong: 0, samplesAcross: 0 }
    expect(makeFanBuffer(cfg)).toHaveLength(1)
  })
})

describe('buildSampleFan', () => {
  const ORIGIN = { x: 10, z: -5 }

  it('places samples within the forward fan, between min and max range', () => {
    const cfg: FanConfig = {
      minRange: 8,
      maxRange: 24,
      samplesAlong: 5,
      fanHalfAngleRad: 0.25,
      samplesAcross: 3,
    }
    const buf = makeFanBuffer(cfg)
    // Heading +Z so the fan lays out along positive Z relative to origin.
    buildSampleFan(buf, ORIGIN, 0, 1, cfg)
    expect(buf).toHaveLength(15)
    for (const s of buf) {
      const dx = s.x - ORIGIN.x
      const dz = s.z - ORIGIN.z
      const dist = Math.hypot(dx, dz)
      // Allow a tiny epsilon for trig at the extremes.
      expect(dist).toBeGreaterThanOrEqual(cfg.minRange - 1e-6)
      expect(dist).toBeLessThanOrEqual(cfg.maxRange + 1e-6)
      // All samples should be in front of the player along +Z heading.
      expect(dz).toBeGreaterThan(0)
      // Lateral offset stays within range × sin(halfAngle).
      const maxLateral = dist * Math.sin(cfg.fanHalfAngleRad) + 1e-6
      expect(Math.abs(dx)).toBeLessThanOrEqual(maxLateral)
    }
  })

  it('returns the SAME buffer it was given (allocation-free)', () => {
    const buf = makeFanBuffer(DEFAULT_FAN_CONFIG)
    const out = buildSampleFan(buf, ORIGIN, 1, 0)
    expect(out).toBe(buf)
  })

  it('rotates the fan to match an arbitrary unit heading', () => {
    // Heading 45° between +X and +Z. The center ray should sit on the
    // bisector at distance = maxRange from origin.
    const cfg: FanConfig = {
      minRange: 10,
      maxRange: 10,
      samplesAlong: 1,
      fanHalfAngleRad: 0.1,
      samplesAcross: 1,
    }
    const buf = makeFanBuffer(cfg)
    const a = Math.SQRT1_2
    buildSampleFan(buf, ORIGIN, a, a, cfg)
    expect(buf[0]!.x).toBeCloseTo(ORIGIN.x + 10 * a, 6)
    expect(buf[0]!.z).toBeCloseTo(ORIGIN.z + 10 * a, 6)
  })

  it('does not require unit-length forward input (defensively normalizes)', () => {
    const cfg: FanConfig = {
      minRange: 10,
      maxRange: 10,
      samplesAlong: 1,
      fanHalfAngleRad: 0.1,
      samplesAcross: 1,
    }
    const buf = makeFanBuffer(cfg)
    buildSampleFan(buf, ORIGIN, 0, 5, cfg) // length 5
    expect(buf[0]!.x).toBeCloseTo(ORIGIN.x, 6)
    expect(buf[0]!.z).toBeCloseTo(ORIGIN.z + 10, 6)
  })

  it('keeps the buffer shape on a degenerate (zero) heading', () => {
    const cfg: FanConfig = { ...DEFAULT_FAN_CONFIG }
    const buf = makeFanBuffer(cfg)
    buildSampleFan(buf, ORIGIN, 0, 0, cfg)
    for (const s of buf) {
      expect(Number.isFinite(s.x)).toBe(true)
      expect(Number.isFinite(s.z)).toBe(true)
      expect(s.x).toBe(ORIGIN.x)
      expect(s.z).toBe(ORIGIN.z)
    }
  })

  it('uses a single sample at the min range when along=1', () => {
    const cfg: FanConfig = {
      minRange: 7,
      maxRange: 30,
      samplesAlong: 1,
      fanHalfAngleRad: 0.2,
      samplesAcross: 3,
    }
    const buf = makeFanBuffer(cfg)
    buildSampleFan(buf, { x: 0, z: 0 }, 0, 1, cfg)
    for (const s of buf) {
      expect(Math.hypot(s.x, s.z)).toBeCloseTo(7, 6)
    }
  })
})

describe('waveLineIntensity persistence', () => {
  it('round-trips through localStorage', () => {
    const localStorage = (globalThis as { localStorage?: Storage }).localStorage
    if (!localStorage) {
      // jsdom missing — vitest shipped node env. Skip.
      return
    }
    localStorage.clear()

    // Default starts at the frozen default.
    expect(playerSettings.waveLineIntensity).toBe(DEFAULT_PLAYER_SETTINGS.waveLineIntensity)

    setWaveLineIntensity('subtle')
    expect(playerSettings.waveLineIntensity).toBe('subtle')

    // Reset back to defaults in memory; reload should re-apply 'subtle'.
    playerSettings.waveLineIntensity = DEFAULT_PLAYER_SETTINGS.waveLineIntensity
    loadPlayerSettings()
    expect(playerSettings.waveLineIntensity).toBe('subtle')

    // Sanity: setting 'off' persists.
    setWaveLineIntensity('off')
    playerSettings.waveLineIntensity = 'full'
    loadPlayerSettings()
    expect(playerSettings.waveLineIntensity).toBe('off')

    // Restore defaults for downstream tests.
    setWaveLineIntensity('full')
    savePlayerSettings()
  })

  it('rejects unknown intensity strings on load', () => {
    const localStorage = (globalThis as { localStorage?: Storage }).localStorage
    if (!localStorage) return
    localStorage.setItem(
      'hoverbike.playerSettings.v1',
      JSON.stringify({ waveLineIntensity: 'rainbow' }),
    )
    playerSettings.waveLineIntensity = 'full'
    loadPlayerSettings()
    expect(playerSettings.waveLineIntensity).toBe('full')
    localStorage.clear()
    setWaveLineIntensity('full')
  })
})
