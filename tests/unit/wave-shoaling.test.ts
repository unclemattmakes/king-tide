import { describe, expect, it } from 'vitest'
import type { ShoreField } from '../../src/engine/sim/water/shore-field'
import {
  createWaveField,
  DEFAULT_SWELL_TUNING_SCALE,
  defaultWaves,
  SHOAL_BREAK_GAMMA,
  SHOAL_FADE_DEPTH,
  SHOAL_GAIN_MAX,
  SHOAL_GREEN_REF_DEPTH,
  SHOAL_HEFF_MIN,
  SHORE_SWELL_DRIVE_MAX,
  SHORE_SWELL_DRIVE_MIN,
  SWELL_WAVELENGTH_MIN,
  sampleHeight,
  sampleSurface,
  setShoreField,
  shoalAttenuation,
  shoalEffectiveSwell,
  shoalSurfFactor,
  shoreSwellDrive,
} from '../../src/engine/sim/water/wave-field'

/**
 * Shoaling v2 (P3.1, water-next-research §7.3): Green's-law amplification
 * capped by depth-limited breaking, swell-driven shore breakers, and the
 * legacy-blend contract. The factor multiplies BUOYANCY as well as the
 * drawn surface, so these tests pin the safety properties (seabed guard,
 * bounded gain, exact legacy at blend 0) rather than just the look.
 */

/** Uniform-depth shore field covering x,z ∈ [0, 100): every sample reports
 *  the given depth, with shoreline 30 m away along −X. */
function flatShore(depth: number): ShoreField {
  const res = 8
  const n = res * res
  return {
    resolution: res,
    minX: 0,
    minZ: 0,
    sizeX: 100,
    sizeZ: 100,
    dist: new Float32Array(n).fill(30),
    nrmX: new Float32Array(n).fill(1),
    nrmZ: new Float32Array(n).fill(0),
    depth: new Float32Array(n).fill(depth),
  }
}

function surfField(depth: number, surf = 1) {
  const f = createWaveField(defaultWaves())
  // The live game applies the boot tuning scales (swells ×3.2); unit
  // fields carry raw amps, so scale here to test at shipped magnitudes.
  for (const w of f.waves) {
    if (w.wavelength >= SWELL_WAVELENGTH_MIN) w.amplitude *= DEFAULT_SWELL_TUNING_SCALE
  }
  f.shoalSurfStrength = surf
  setShoreField(f, flatShore(depth))
  return f
}

describe('shoalSurfFactor', () => {
  it('is 0 on dry land and 1 in open water', () => {
    expect(shoalSurfFactor(0, 1)).toBe(0)
    expect(shoalSurfFactor(-2, 1)).toBe(0)
    expect(shoalSurfFactor(SHOAL_GREEN_REF_DEPTH, 1)).toBe(1)
    expect(shoalSurfFactor(50, 1)).toBe(1)
  })

  it("amplifies as the swell feels the bottom, capped at SHOAL_GAIN_MAX (Green's law)", () => {
    const hEff = 0.5 // small swell — break cap stays out of the way
    let prev = 1
    for (const d of [13, 11, 9, 7.5, 6.5]) {
      const f = shoalSurfFactor(d, hEff)
      expect(f).toBeGreaterThanOrEqual(prev - 1e-12)
      expect(f).toBeLessThanOrEqual(SHOAL_GAIN_MAX + 1e-12)
      prev = f
    }
    // Green's law exactly in the open gain regime…
    expect(shoalSurfFactor(8, hEff)).toBeCloseTo((SHOAL_GREEN_REF_DEPTH / 8) ** 0.25, 12)
    // …and the clamp binds once (REF/d)^¼ would exceed GAIN_MAX
    // (d ≤ REF/GAIN_MAX⁴ ≈ 4.9 m at the shipped constants).
    expect(shoalSurfFactor(4, hEff)).toBeCloseTo(SHOAL_GAIN_MAX, 12)
  })

  it('breaks depth-limited: amplitude·factor ≤ γ·depth (the seabed guard)', () => {
    for (const hEff of [0.5, 1.5, 2.72, 4]) {
      for (const d of [0.25, 0.5, 1, 2, 4, 8]) {
        const f = shoalSurfFactor(d, hEff)
        // The local wave height H_eff·f can never exceed the breaking
        // height γ·d — so a trough −H_eff·f stays above the seabed −d.
        expect(hEff * f).toBeLessThanOrEqual(SHOAL_BREAK_GAMMA * d + 1e-9)
      }
    }
  })

  it('big sets break farther out: larger H_eff → smaller factor at the same depth', () => {
    const d = 2
    expect(shoalSurfFactor(d, 4)).toBeLessThan(shoalSurfFactor(d, 2))
    expect(shoalSurfFactor(d, 2)).toBeLessThan(shoalSurfFactor(d, 1))
  })
})

describe('shoalAttenuation (blend + plumbing)', () => {
  it('strength 0 reproduces the legacy quadratic kill-switch exactly', () => {
    // toBeCloseTo(…, 6): the stub depth round-trips a Float32Array, so the
    // comparison is float32-exact, not double-exact.
    for (const d of [0.3, 1, 2, 2.9]) {
      const f = surfField(d, 0)
      const raw = Math.min(1, d / SHOAL_FADE_DEPTH)
      expect(shoalAttenuation(f, 50, 50)).toBeCloseTo(raw * raw, 6)
    }
    // Legacy is exactly 1 from FADE_DEPTH out.
    expect(shoalAttenuation(surfField(3.5, 0), 50, 50)).toBe(1)
  })

  it('strength 1 keeps surf alive where legacy had flattened it', () => {
    const d = 1.2
    const legacy = shoalAttenuation(surfField(d, 0), 50, 50)
    const surf = shoalAttenuation(surfField(d, 1), 50, 50)
    expect(legacy).toBeCloseTo((d / 3) ** 2, 6) // ≈ 0.16
    expect(surf).toBeGreaterThan(legacy * 1.5) // breakers, not calm
  })

  it('returns 1 with no shore field installed (open water) at any strength', () => {
    const f = createWaveField(defaultWaves())
    f.shoalSurfStrength = 1
    expect(shoalAttenuation(f, 0, 0)).toBe(1)
  })

  it('the combined trough stays within the bounded-breach guarantee', () => {
    // The break cap bounds the AMBIENT trough by γ·d; the shore breaker
    // adds its own SHORE_DEPTH_CAP·d budget on top, so when every trough
    // aligns the combined surface can underdip the seabed by a bounded
    // fraction of the (already-shallow) depth — measured centimetres at
    // the swash line. That dip hides under the beach geometry and
    // buoyancy reads max(terrain, wave), so the bike never feels it; what
    // must NEVER return is the v1 metre-scale unattenuated trough. Pin
    // the bound at 10 % of depth + 5 cm.
    for (const d of [0.4, 0.8, 1.5, 2.5]) {
      const f = surfField(d, 1)
      let minY = Infinity
      for (let i = 0; i < 400; i++) {
        f.time = i * 0.05
        const y = sampleHeight(f, 50, 50)
        if (y < minY) minY = y
      }
      expect(minY).toBeGreaterThan(-d - (0.1 * d + 0.05))
    }
  })

  it('hEff floors so a becalmed sea cannot blow the cap up', () => {
    const f = createWaveField(defaultWaves())
    for (const w of f.waves) w.amplitude = 0
    expect(shoalEffectiveSwell(f)).toBe(SHOAL_HEFF_MIN)
  })
})

describe('shoreSwellDrive', () => {
  it('is ≈1 for the shipped default sea and clamps at both ends', () => {
    const f = surfField(3, 1)
    expect(shoreSwellDrive(f)).toBeCloseTo(1, 1)
    // Becalmed: clamps at the floor, surf band stays present.
    const calm = createWaveField(defaultWaves())
    calm.shoalSurfStrength = 1
    for (const w of calm.waves) w.amplitude *= 0.01
    expect(shoreSwellDrive(calm)).toBeCloseTo(SHORE_SWELL_DRIVE_MIN, 6)
    // Storm: clamps at the ceiling.
    const storm = surfField(3, 1)
    for (const w of storm.waves) w.amplitude *= 3
    expect(shoreSwellDrive(storm)).toBeCloseTo(SHORE_SWELL_DRIVE_MAX, 6)
  })

  it('is exactly 1 at strength 0 (legacy shore wave untouched)', () => {
    const storm = surfField(3, 0)
    for (const w of storm.waves) w.amplitude *= 3
    expect(shoreSwellDrive(storm)).toBe(1)
  })
})

describe('breaker-forward asymmetry', () => {
  it('sampleSurface.vy matches a finite difference of sampleHeight through the surf band', () => {
    // The asymmetric waveform's ∂y/∂t must stay exact (hover damping reads
    // it). Sets OFF so the drive is time-constant (its slow envelope rate
    // is a documented omission).
    const f = surfField(2.0, 1)
    const x = 50
    const z = 50
    for (const t of [0.7, 3.3, 9.1]) {
      f.time = t
      const vy = sampleSurface(f, x, z).vy
      const dt = 1e-4
      f.time = t + dt
      const yPlus = sampleHeight(f, x, z)
      f.time = t - dt
      const yMinus = sampleHeight(f, x, z)
      expect(vy).toBeCloseTo((yPlus - yMinus) / (2 * dt), 4)
    }
  })

  it('the breaker leans SHOREWARD in the surf regime and is a pure sine at strength 0', () => {
    // Measure the spatial face-slope split via the analytic dydx (the
    // shore normal in the stub is +X, shore toward −X, crests marching
    // shoreward). On the wave's FRONT (shoreward) face, walking +x climbs
    // toward the crest → dydx > 0 there; the BACK face has dydx < 0.
    // Forward lean ⇒ the front face is steeper: max(dydx) > max(−dydx).
    // (A time sweep at a fixed point scans the whole traveling profile.)
    const faceSlopeSplit = (surf: number) => {
      const f = surfField(2.0, surf)
      // Kill the ambient so only the shore wave remains.
      for (const w of f.waves) w.amplitude = 0
      let maxFront = 0
      let maxBack = 0
      for (let i = 0; i < 600; i++) {
        f.time = i * 0.01
        const s = sampleSurface(f, 50, 50)
        // WaveSample carries the unit normal; recover ∂y/∂x = −nx/ny.
        const dydx = -s.nx / s.ny
        if (dydx > maxFront) maxFront = dydx
        if (-dydx > maxBack) maxBack = -dydx
      }
      return maxFront / Math.max(maxBack, 1e-9)
    }
    expect(Math.abs(faceSlopeSplit(0) - 1)).toBeLessThan(0.02)
    // Shoreward lean: the front face is markedly steeper.
    expect(faceSlopeSplit(1)).toBeGreaterThan(1.15)
  })
})
