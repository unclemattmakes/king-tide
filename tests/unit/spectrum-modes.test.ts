import { describe, expect, it } from 'vitest'
import {
  buildPhillipsSpectrum,
  sampleSpectrumHeight,
} from '@/engine/sim/water/phillips'
import {
  sampleSpectrumHeightFromModes,
  sampleSpectrumSurfaceFromModes,
  selectTopKModes,
} from '@/engine/sim/water/spectrum-modes'

const PRESET = {
  N: 32,
  tileSize: 100,
  windSpeed: 10,
  windDirX: 1,
  windDirZ: 0,
  amplitude: 1,
  smallWavelengthCutoff: 0.5,
  seed: 0x515a,
}

describe('selectTopKModes', () => {
  it('returns exactly K modes when the spectrum has ≥K non-zero entries', () => {
    const s = buildPhillipsSpectrum(PRESET)
    const modes = selectTopKModes(s, { topK: 64 })
    expect(modes.length).toBe(64)
  })

  it('is deterministic for a fixed seed', () => {
    const a = selectTopKModes(buildPhillipsSpectrum(PRESET), { topK: 32 })
    const b = selectTopKModes(buildPhillipsSpectrum(PRESET), { topK: 32 })
    expect(a).toEqual(b)
  })

  it('ranks modes by energy: dropping any kept mode decreases the energy', () => {
    const s = buildPhillipsSpectrum(PRESET)
    const top = selectTopKModes(s, { topK: 16 })
    const kept = top.reduce(
      (sum, m) => sum + (m.aRe * m.aRe + m.aIm * m.aIm) / 4,
      0,
    )
    // The top-16 energy should equal the K-largest |h0|² sums in the
    // full grid. Sanity: kept > the energy if we'd kept ANY non-top
    // 16 instead. Easy proxy: kept > top-17's energy * 16.
    const top17 = selectTopKModes(s, { topK: 17 })
    const lastEnergy =
      ((top17[16]!.aRe * top17[16]!.aRe + top17[16]!.aIm * top17[16]!.aIm) / 4)
    expect(kept).toBeGreaterThan(lastEnergy * 16)
  })

  it('bakes the conjugate-pair factor of 2 into the amplitudes', () => {
    // The h0 values in the spectrum aren't normalized; their magnitude
    // is amplitude · √(Phillips/2). The retained mode's aRe/aIm should
    // be exactly 2× that h0 component.
    const s = buildPhillipsSpectrum(PRESET)
    const modes = selectTopKModes(s, { topK: 1 })
    const m = modes[0]!
    // Find the matching h0 index by reverse-mapping (kx, kz) → (xi, zi)
    // via kStep + center offset.
    const kStep = (2 * Math.PI) / s.tileSize
    const xi = Math.round(m.kx / kStep) + s.N / 2
    const zi = Math.round(m.kz / kStep) + s.N / 2
    const idx = zi * s.N + xi
    expect(m.aRe).toBeCloseTo(2 * s.h0[idx * 2]!, 6)
    expect(m.aIm).toBeCloseTo(2 * s.h0[idx * 2 + 1]!, 6)
  })
})

describe('sampleSpectrumHeightFromModes', () => {
  it('reproduces a known cosine signal from a single-mode list', () => {
    // Hand-craft a top-K=1 mode list and sample.
    const modes = [
      { kx: 0.4, kz: 0, omega: 1.5, aRe: 1.2, aIm: 0 },
    ]
    const x = 2
    const t = 0.7
    const expected = 1.2 * Math.cos(0.4 * x + 1.5 * t)
    expect(sampleSpectrumHeightFromModes(modes, x, 0, t)).toBeCloseTo(expected, 6)
  })

  it('agrees with the full-grid sampler when K=N²', () => {
    // With K=N², we keep every non-zero mode — the top-K sampler
    // should match the full-grid sampler exactly.
    const s = buildPhillipsSpectrum(PRESET)
    const modes = selectTopKModes(s, { topK: s.N * s.N })
    const t = 0.43
    for (let x = -50; x <= 50; x += 17) {
      for (let z = -50; z <= 50; z += 13) {
        const full = sampleSpectrumHeight(s, x, z, t)
        const top = sampleSpectrumHeightFromModes(modes, x, z, t)
        expect(top).toBeCloseTo(full, 4)
      }
    }
  })

  it('captures ≥80% of the height variance with K=N²/4', () => {
    // Statistical check: keeping a quarter of the spectrum should
    // still produce a wave field whose variance is most of the full
    // signal's. Stronger guarantees (≥95%) hold at larger K — this
    // test is a regression-floor, not a tightness claim.
    const s = buildPhillipsSpectrum(PRESET)
    const fullModes = selectTopKModes(s, { topK: s.N * s.N })
    const quartModes = selectTopKModes(s, { topK: Math.floor((s.N * s.N) / 4) })
    let varFull = 0
    let varQuart = 0
    const t = 0.5
    let count = 0
    for (let x = -50; x <= 50; x += 5) {
      for (let z = -50; z <= 50; z += 5) {
        const yf = sampleSpectrumHeightFromModes(fullModes, x, z, t)
        const yq = sampleSpectrumHeightFromModes(quartModes, x, z, t)
        varFull += yf * yf
        varQuart += yq * yq
        count++
      }
    }
    varFull /= count
    varQuart /= count
    expect(varQuart / varFull).toBeGreaterThan(0.8)
  })
})

describe('sampleSpectrumSurfaceFromModes', () => {
  it('returns derivatives consistent with finite differences', () => {
    const s = buildPhillipsSpectrum(PRESET)
    const modes = selectTopKModes(s, { topK: 64 })
    const x = 12.5
    const z = -7
    const t = 0.4
    const surf = sampleSpectrumSurfaceFromModes(modes, x, z, t)
    const eps = 1e-3
    const dydx_fd =
      (sampleSpectrumHeightFromModes(modes, x + eps, z, t) -
        sampleSpectrumHeightFromModes(modes, x - eps, z, t)) /
      (2 * eps)
    const dydz_fd =
      (sampleSpectrumHeightFromModes(modes, x, z + eps, t) -
        sampleSpectrumHeightFromModes(modes, x, z - eps, t)) /
      (2 * eps)
    const dydt_fd =
      (sampleSpectrumHeightFromModes(modes, x, z, t + eps) -
        sampleSpectrumHeightFromModes(modes, x, z, t - eps)) /
      (2 * eps)
    expect(surf.dydx).toBeCloseTo(dydx_fd, 3)
    expect(surf.dydz).toBeCloseTo(dydz_fd, 3)
    expect(surf.vy).toBeCloseTo(dydt_fd, 3)
  })
})
