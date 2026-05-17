import { describe, expect, it } from 'vitest'
import {
  createSpectrumWaveField,
  defaultSpectrumParams,
  sampleHeight,
  sampleSurface,
} from '@/engine/sim/water/wave-field'

/**
 * End-to-end checks for the spectrum-mode wave field. The
 * `spectrum-to-gerstner` parity test already proves the shader's
 * converted-Gerstner sum equals the analytic spectrum sum; this file
 * exercises the public `sampleHeight` / `sampleSurface` surface that
 * the rest of the sim (hover, replay, multiplayer) goes through.
 */
describe('createSpectrumWaveField', () => {
  it('is deterministic for a fixed PhillipsParams', () => {
    const a = createSpectrumWaveField(defaultSpectrumParams())
    const b = createSpectrumWaveField(defaultSpectrumParams())
    expect(a.spectrum).toEqual(b.spectrum)
  })

  it("tags the field with kind: 'spectrum'", () => {
    const f = createSpectrumWaveField(defaultSpectrumParams())
    expect(f.kind).toBe('spectrum')
  })

  it('honours opts.baseY (sea level offset)', () => {
    const f = createSpectrumWaveField(defaultSpectrumParams(), { baseY: 12.5 })
    // baseY shifts the mean — at any single (x, z), the height oscillates
    // around it. Averaging over a grid of probes pulls toward baseY.
    let sum = 0
    let n = 0
    for (let x = -40; x <= 40; x += 10) {
      for (let z = -40; z <= 40; z += 10) {
        sum += sampleHeight(f, x, z)
        n++
      }
    }
    const mean = sum / n
    expect(mean).toBeGreaterThan(10)
    expect(mean).toBeLessThan(15)
  })

  it('respects opts.topK (smaller K → less variance retained)', () => {
    const fBig = createSpectrumWaveField(defaultSpectrumParams(), { topK: 64 })
    const fSmall = createSpectrumWaveField(defaultSpectrumParams(), { topK: 4 })
    const variance = (
      field: ReturnType<typeof createSpectrumWaveField>,
    ): number => {
      let s = 0
      let n = 0
      for (let x = -30; x <= 30; x += 5) {
        for (let z = -30; z <= 30; z += 5) {
          const y = sampleHeight(field, x, z)
          s += y * y
          n++
        }
      }
      return s / n
    }
    expect(variance(fSmall)).toBeLessThan(variance(fBig))
  })
})

describe('sampleHeight / sampleSurface with spectrum field', () => {
  it('returns finite values at a wide range of (x, z, t)', () => {
    const f = createSpectrumWaveField(defaultSpectrumParams())
    for (let t = 0; t < 5; t += 0.7) {
      f.time = t
      for (let x = -100; x <= 100; x += 30) {
        for (let z = -100; z <= 100; z += 30) {
          const y = sampleHeight(f, x, z)
          const s = sampleSurface(f, x, z)
          expect(Number.isFinite(y)).toBe(true)
          expect(Number.isFinite(s.y)).toBe(true)
          expect(Number.isFinite(s.nx)).toBe(true)
          expect(Number.isFinite(s.ny)).toBe(true)
          expect(Number.isFinite(s.nz)).toBe(true)
          expect(Number.isFinite(s.vy)).toBe(true)
          // Normal must be unit length.
          const nlen = Math.hypot(s.nx, s.ny, s.nz)
          expect(nlen).toBeCloseTo(1, 5)
        }
      }
    }
  })

  it('agrees between sampleHeight and sampleSurface.y', () => {
    const f = createSpectrumWaveField(defaultSpectrumParams())
    f.time = 1.7
    for (let x = -50; x <= 50; x += 17) {
      for (let z = -50; z <= 50; z += 13) {
        const y = sampleHeight(f, x, z)
        const s = sampleSurface(f, x, z)
        expect(s.y).toBeCloseTo(y, 6)
      }
    }
  })

  it('surface normal matches finite-difference gradient (no wake)', () => {
    const f = createSpectrumWaveField(defaultSpectrumParams())
    f.time = 0.9
    const eps = 1e-3
    const x = 7
    const z = -3
    const s = sampleSurface(f, x, z)
    const dydx_fd =
      (sampleHeight(f, x + eps, z) - sampleHeight(f, x - eps, z)) / (2 * eps)
    const dydz_fd =
      (sampleHeight(f, x, z + eps) - sampleHeight(f, x, z - eps)) / (2 * eps)
    // The normal is (−∂y/∂x, 1, −∂y/∂z) normalized. Recover the raw
    // partials via `−nx/ny`, `−nz/ny` — the normalization scales both
    // numerator and denominator equally so the ratio is exact.
    const dydx_normal = -s.nx / s.ny
    const dydz_normal = -s.nz / s.ny
    expect(dydx_normal).toBeCloseTo(dydx_fd, 3)
    expect(dydz_normal).toBeCloseTo(dydz_fd, 3)
  })
})
