import { describe, expect, it } from 'vitest'
import {
  createWaveField,
  defaultWaves,
  sampleHeight,
  sampleSurface,
  setWaveZones,
  waveSetFactor,
  waveSetFactorRate,
} from '../../src/engine/sim/water/wave-field'

/**
 * Wave-set envelope (P2.1, water-next-research §7.2): the per-track "sets"
 * rhythm — ambient amplitude breathing as 1 + depth·sin(2π·t/periodS + φ).
 * These tests pin the three contracts that make it safe:
 *
 *  1. PURITY — the factor is a function of (field params, t) only, so the
 *     envelope can never desync a replay or accumulate drift (it's never
 *     integrated, always evaluated).
 *  2. EQUIVALENCE ORACLE — an enveloped field samples identically to a
 *     plain field whose amplitudes were hand-scaled by the same factor.
 *     This is what guarantees the envelope composes with every other
 *     amplitude writer (Beaufort / lap-weather / menu) instead of
 *     compounding with them.
 *  3. vy EXACTNESS — ∂y/∂t includes the envelope's own rate term, checked
 *     against a central finite difference of sampleHeight.
 */

function enveloped(periodS: number, depth: number, phase = 0) {
  const f = createWaveField(defaultWaves())
  f.swellSetPeriodS = periodS
  f.swellSetDepth = depth
  f.swellSetPhase = phase
  return f
}

describe('waveSetFactor', () => {
  it('is 1 when disabled (zero period or zero depth)', () => {
    expect(waveSetFactor(enveloped(0, 0.5), 12)).toBe(1)
    expect(waveSetFactor(enveloped(60, 0), 12)).toBe(1)
  })

  it('is periodic with the authored period and bounded by ±depth', () => {
    const f = enveloped(45, 0.35, 1.1)
    for (const t of [0, 3.7, 11, 29.5]) {
      expect(waveSetFactor(f, t)).toBeCloseTo(waveSetFactor(f, t + 45), 10)
      expect(waveSetFactor(f, t)).toBeGreaterThanOrEqual(1 - 0.35 - 1e-9)
      expect(waveSetFactor(f, t)).toBeLessThanOrEqual(1 + 0.35 + 1e-9)
    }
  })

  it('rate matches the analytic derivative of the factor', () => {
    const f = enveloped(30, 0.3, 0.4)
    const t = 7.3
    const dt = 1e-5
    const numeric = (waveSetFactor(f, t + dt) - waveSetFactor(f, t - dt)) / (2 * dt)
    expect(waveSetFactorRate(f, t)).toBeCloseTo(numeric, 6)
  })
})

describe('envelope ≡ hand-scaled amplitudes (the composition oracle)', () => {
  it('sampleHeight matches a field with amplitudes pre-scaled by the factor', () => {
    const period = 40
    const depth = 0.3
    const phase = 0.9
    for (const t of [2.2, 13.6, 31.0]) {
      const envField = enveloped(period, depth, phase)
      envField.time = t
      const factor = waveSetFactor(envField, t)
      const scaledField = createWaveField(
        defaultWaves().map((w) => ({ ...w, amplitude: w.amplitude * factor })),
      )
      scaledField.time = t
      for (const [x, z] of [
        [0, 0],
        [17.3, -42.0],
        [-88.8, 5.5],
      ] as const) {
        expect(sampleHeight(envField, x, z)).toBeCloseTo(sampleHeight(scaledField, x, z), 10)
      }
    }
  })

  it('holds with steepness on (envelope feeds the Gerstner inverse map)', () => {
    const t = 9.4
    const envField = enveloped(60, 0.25)
    envField.steepness = 0.44
    envField.time = t
    const factor = waveSetFactor(envField, t)
    const scaledField = createWaveField(
      defaultWaves().map((w) => ({ ...w, amplitude: w.amplitude * factor })),
    )
    scaledField.steepness = 0.44
    scaledField.time = t
    // NOTE: effectiveSteepness clamps on Σ q·A·k, which differs between the
    // two fields once amplitudes differ — at the default bank + 0.25 depth
    // neither side clamps (sum ≈ 0.14–0.22 ≪ 0.85), so Q applies equally.
    for (const [x, z] of [
      [12.3, -7.9],
      [-31.0, 24.5],
    ] as const) {
      expect(sampleHeight(envField, x, z)).toBeCloseTo(sampleHeight(scaledField, x, z), 6)
    }
  })

  it('composes with zone heightMult multiplicatively', () => {
    const t = 5.5
    const zone = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      halfWidth: 200,
      halfHeight: 30,
      halfDepth: 200,
      heightMult: 1.5,
      freqMult: 1,
      blendRadiusM: 20,
    }
    const envField = enveloped(40, 0.3)
    envField.time = t
    setWaveZones(envField, [zone])
    const factor = waveSetFactor(envField, t)
    const scaledField = createWaveField(
      defaultWaves().map((w) => ({ ...w, amplitude: w.amplitude * factor })),
    )
    scaledField.time = t
    setWaveZones(scaledField, [zone])
    expect(sampleHeight(envField, 10, 20)).toBeCloseTo(sampleHeight(scaledField, 10, 20), 10)
  })
})

describe('sampleSurface vy with the envelope', () => {
  it('matches a central finite difference of sampleHeight', () => {
    const f = enveloped(30, 0.35, 0.7)
    const t = 11.8
    const dt = 1e-4
    for (const [x, z] of [
      [4.0, -9.0],
      [-25.0, 60.0],
    ] as const) {
      f.time = t
      const vy = sampleSurface(f, x, z).vy
      f.time = t + dt
      const yPlus = sampleHeight(f, x, z)
      f.time = t - dt
      const yMinus = sampleHeight(f, x, z)
      f.time = t
      const numeric = (yPlus - yMinus) / (2 * dt)
      expect(vy).toBeCloseTo(numeric, 3)
    }
  })
})
