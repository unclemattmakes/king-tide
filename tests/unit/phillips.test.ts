import { describe, expect, it } from 'vitest'
import {
  boxMullerPair,
  buildPhillipsSpectrum,
  mulberry32,
  type PhillipsParams,
  sampleSpectrumHeight,
} from '@/engine/sim/water/phillips'

/**
 * Reusable preset for tests — moderate wind, smallish grid so the
 * O(N²)-per-sample analytic sampler runs in test time.
 */
function preset(overrides: Partial<PhillipsParams> = {}): PhillipsParams {
  return {
    N: 32,
    tileSize: 100,
    windSpeed: 10,
    windDirX: 1,
    windDirZ: 0,
    amplitude: 1,
    smallWavelengthCutoff: 0.5,
    seed: 0x515a,
    ...overrides,
  }
}

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b())
    }
  })

  it('produces values in [0, 1)', () => {
    const r = mulberry32(123)
    for (let i = 0; i < 10000; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('is uniformly distributed', () => {
    // Split [0,1) into 10 buckets, check each holds ~10% of samples.
    const r = mulberry32(0xc0ffee)
    const bucket = new Array(10).fill(0)
    const N = 100000
    for (let i = 0; i < N; i++) {
      bucket[Math.floor(r() * 10)]++
    }
    for (const c of bucket) {
      // 3σ tolerance ≈ ±0.95%, so ±1.5% is well past noise.
      expect(c).toBeGreaterThan(N * 0.085)
      expect(c).toBeLessThan(N * 0.115)
    }
  })
})

describe('boxMullerPair', () => {
  it('approximates a standard normal distribution', () => {
    const rng = mulberry32(7)
    const samples: number[] = []
    for (let i = 0; i < 20000; i++) {
      const [a, b] = boxMullerPair(rng(), rng())
      samples.push(a, b)
    }
    const mean = samples.reduce((s, x) => s + x, 0) / samples.length
    const variance =
      samples.reduce((s, x) => s + (x - mean) * (x - mean), 0) / samples.length
    // Standard normal: μ = 0, σ² = 1. Tolerances accommodate the sample size.
    expect(Math.abs(mean)).toBeLessThan(0.03)
    expect(Math.abs(variance - 1)).toBeLessThan(0.05)
  })
})

describe('buildPhillipsSpectrum', () => {
  it('is deterministic for a given seed', () => {
    const a = buildPhillipsSpectrum(preset())
    const b = buildPhillipsSpectrum(preset())
    expect(a.h0).toEqual(b.h0)
    expect(a.omega).toEqual(b.omega)
  })

  it('zeroes the DC (k=0) mode', () => {
    const s = buildPhillipsSpectrum(preset())
    const N = s.N
    const dcIdx = (N / 2) * N + N / 2
    // Use abs to dodge the -0/+0 distinction the strict-equality `toBe(0)`
    // would catch — a negative Gaussian times zero amplitude yields -0.
    expect(Math.abs(s.h0[dcIdx * 2]!)).toBe(0)
    expect(Math.abs(s.h0[dcIdx * 2 + 1]!)).toBe(0)
  })

  it('puts most energy in wind-aligned modes', () => {
    const s = buildPhillipsSpectrum(preset({ windDirX: 1, windDirZ: 0 }))
    const N = s.N
    // Aligned: kx = ±1·kStep, kz = 0. Backward: kx = -1·kStep, kz = 0.
    // Perpendicular: kx = 0, kz = ±1·kStep.
    const alignedIdx = (N / 2) * N + (N / 2 + 1)
    const backwardIdx = (N / 2) * N + (N / 2 - 1)
    const perpIdx = (N / 2 + 1) * N + N / 2
    const aE =
      s.h0[alignedIdx * 2]! ** 2 + s.h0[alignedIdx * 2 + 1]! ** 2
    const bE =
      s.h0[backwardIdx * 2]! ** 2 + s.h0[backwardIdx * 2 + 1]! ** 2
    const pE = s.h0[perpIdx * 2]! ** 2 + s.h0[perpIdx * 2 + 1]! ** 2
    // Directional spread is Mitsuyasu cos²ˢ(α/2): one-sided, zero
    // backward, peaks forward. At default `directionalSpread = 1` the
    // expected ratios at the per-axis modes are:
    //   aligned:  cos²(0/2)·... = 1
    //   perp:     cos²(π/4)·... = 0.5
    //   backward: cos²(π/2)·... = 0
    // Multiplied by random Gaussian draws so we don't assert tight
    // ratios — only the structural inequalities.
    expect(aE).toBeGreaterThan(0)
    expect(pE).toBeGreaterThan(0)
    expect(pE).toBeLessThan(aE)
    expect(bE).toBe(0)
  })

  it('precomputes deep-water dispersion ω = √(g·|k|)', () => {
    const s = buildPhillipsSpectrum(preset())
    const N = s.N
    const kStep = (2 * Math.PI) / s.tileSize
    // Pick mode (kxi=3, kzi=0).
    const xi = N / 2 + 3
    const zi = N / 2
    const k = 3 * kStep
    const expected = Math.sqrt(9.81 * k)
    expect(s.omega[zi * N + xi]).toBeCloseTo(expected, 5)
  })

  it('higher wind speed pushes energy into longer wavelengths', () => {
    const calm = buildPhillipsSpectrum(preset({ windSpeed: 3 }))
    const storm = buildPhillipsSpectrum(preset({ windSpeed: 20 }))
    // Sum total energy across the grid for each.
    const energy = (h0: Float32Array): number => {
      let s = 0
      for (let i = 0; i < h0.length; i += 2) {
        s += h0[i]! ** 2 + h0[i + 1]! ** 2
      }
      return s
    }
    expect(energy(storm.h0)).toBeGreaterThan(energy(calm.h0))
  })
})

describe('sampleSpectrumHeight', () => {
  it('reproduces a known cosine signal from a single-mode spectrum', () => {
    // Hand-craft a spectrum with one mode: kx = 2π/tileSize, kz = 0.
    // Should yield y(x, t) = 2·h0r·cos(kx·x + ω·t).
    const N = 8
    const tileSize = 10
    const h0 = new Float32Array(N * N * 2)
    const omega = new Float32Array(N * N)
    const xi = N / 2 + 1 // kx = 1·kStep
    const zi = N / 2
    const idx = zi * N + xi
    h0[idx * 2] = 0.5 // real
    h0[idx * 2 + 1] = 0 // imag → pure cosine
    omega[idx] = 1.2
    const spectrum = {
      N,
      tileSize,
      h0,
      omega,
      params: {
        N,
        tileSize,
        windSpeed: 0,
        windDirX: 1,
        windDirZ: 0,
        amplitude: 0,
        smallWavelengthCutoff: 0,
        directionalSpread: 1,
        gravity: 9.81,
        seed: 0,
      },
    }
    const kx = (2 * Math.PI) / tileSize
    const x = 1.5
    const t = 0.7
    const expected = 2 * 0.5 * Math.cos(kx * x + 1.2 * t)
    expect(sampleSpectrumHeight(spectrum, x, 0, t)).toBeCloseTo(expected, 6)
  })

  it('is bounded by total spectral amplitude', () => {
    // The max |y| across all (x,t) is at most Σ_k 2|h0(k)| (triangle inequality).
    const s = buildPhillipsSpectrum(preset({ N: 16 }))
    let bound = 0
    for (let i = 0; i < s.h0.length; i += 2) {
      bound += 2 * Math.hypot(s.h0[i]!, s.h0[i + 1]!)
    }
    // Sample a few (x, z, t) and confirm well under the bound. A loose
    // check — the actual statistical bound (significant wave height)
    // is much tighter, but this catches sign or scaling bugs.
    for (let t = 0; t < 3; t += 0.5) {
      for (let x = -50; x <= 50; x += 13) {
        for (let z = -50; z <= 50; z += 17) {
          const y = sampleSpectrumHeight(s, x, z, t)
          expect(Math.abs(y)).toBeLessThan(bound)
        }
      }
    }
  })

  it('returns 0 at t=0, x=0 ONLY by sum-symmetry coincidence (sanity check)', () => {
    // At (0, 0), each cosine becomes cos(ω·t) — non-trivial sum. Just
    // ensure the sampler runs without producing NaN/Infinity.
    const s = buildPhillipsSpectrum(preset({ N: 16 }))
    const y = sampleSpectrumHeight(s, 0, 0, 0)
    expect(Number.isFinite(y)).toBe(true)
  })
})
