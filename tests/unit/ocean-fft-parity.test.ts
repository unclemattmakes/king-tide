import { describe, expect, it } from 'vitest'
import { fft2d, ifftshift } from '@/engine/sim/water/fft2d-cpu'
import {
  buildPhillipsSpectrum,
  sampleSpectrumHeight,
} from '@/engine/sim/water/phillips'

/**
 * Cross-validation: the analytic spectrum sampler (Σ_k 2·Re[h0·e^{i(k·x + ωt)}])
 * and the IFFT of the same spectrum must agree at every grid point. This is
 * the foundation the FFT migration rests on — if it holds, we can hand the
 * GPU a full grid via IFFT and still get bit-comparable buoyancy values on
 * the CPU by summing the (thinned) spectrum analytically.
 *
 * Tessendorf eq. 19 / 26:
 *
 *   h(x⃗, t) = Σ_K h̃(K⃗, t) · exp(i K⃗·x⃗)
 *   h̃(K, t) = h0(K)·exp(iωt) + h0*(−K)·exp(−iωt)
 *
 * The 2D IFFT computes exactly the first line at all N² grid points. The
 * analytic sampler walks the same formula at a single (x, z). At grid
 * points `(x_m, z_n) = (m, n)·tileSize/N` they should match to FP32 noise.
 */
describe('Phillips spectrum: IFFT vs analytic sampler', () => {
  it('matches sampleSpectrumHeight at every grid point (t=0)', () => {
    const N = 8
    const tileSize = 32
    const spectrum = buildPhillipsSpectrum({
      N,
      tileSize,
      windSpeed: 12,
      windDirX: 0.7,
      windDirZ: 0.714,
      amplitude: 50,
      smallWavelengthCutoff: 1.0,
      seed: 0xfeed,
    })

    // Build the time-evolved spectrum h̃(K, 0) for the IFFT. At t=0 this
    // collapses to h0(K) + h0*(−K). Walk every (xi, zi) and combine with
    // its conjugate partner.
    const hTilde = new Float32Array(2 * N * N)
    for (let zi = 0; zi < N; zi++) {
      for (let xi = 0; xi < N; xi++) {
        const idx = zi * N + xi
        // Conjugate partner: K' = -K. For centered layout with DC at
        // (N/2, N/2), the partner of (xi, zi) is (N − xi, N − zi),
        // modulo N (so the partner of (N/2, N/2) is itself).
        const xiC = (N - xi) % N
        const ziC = (N - zi) % N
        const idxC = ziC * N + xiC
        const h0r = spectrum.h0[idx * 2]!
        const h0i = spectrum.h0[idx * 2 + 1]!
        const hCr = spectrum.h0[idxC * 2]!
        const hCi = spectrum.h0[idxC * 2 + 1]!
        // h̃ = h0 + conj(h0_conjPartner) = (h0r + hCr) + i·(h0i − hCi).
        hTilde[idx * 2] = h0r + hCr
        hTilde[idx * 2 + 1] = h0i - hCi
      }
    }

    // The IFFT here wants natural-order layout (DC at 0). The spectrum is
    // centered (DC at N/2), so ifftshift first.
    ifftshift(hTilde, N)
    // Inverse 2D FFT with 1/N² scaling baked in (direction = -1).
    fft2d(hTilde, N, -1)
    // The IFFT's 1/N² is right for the DFT convention but the spectrum
    // is laid out in "continuous-Fourier" form (sum-over-k of complex
    // exponentials, no 1/N pre-scaling). So we need to multiply by N²
    // back to recover the analytic sum.
    for (let i = 0; i < hTilde.length; i++) hTilde[i] *= N * N

    // The result's real part is the heightfield. Sample at every grid
    // point with the analytic sum and confirm match.
    const cell = tileSize / N
    for (let zi = 0; zi < N; zi++) {
      for (let xi = 0; xi < N; xi++) {
        const x = xi * cell
        const z = zi * cell
        const expected = sampleSpectrumHeight(spectrum, x, z, 0)
        const actual = hTilde[(zi * N + xi) * 2]!
        expect(actual).toBeCloseTo(expected, 3)
        // Imag part must be ≈ 0 (the heightfield is real).
        expect(Math.abs(hTilde[(zi * N + xi) * 2 + 1]!)).toBeLessThan(1e-3)
      }
    }
  })

  it('matches sampleSpectrumHeight at every grid point (t > 0)', () => {
    const N = 8
    const tileSize = 32
    const t = 0.73
    const spectrum = buildPhillipsSpectrum({
      N,
      tileSize,
      windSpeed: 12,
      windDirX: 1,
      windDirZ: 0,
      amplitude: 50,
      smallWavelengthCutoff: 1.0,
      seed: 0xc0de,
    })

    // Time-evolve: h̃(K, t) = h0(K)·e^{iωt} + h0*(−K)·e^{−iωt}.
    const hTilde = new Float32Array(2 * N * N)
    for (let zi = 0; zi < N; zi++) {
      for (let xi = 0; xi < N; xi++) {
        const idx = zi * N + xi
        const xiC = (N - xi) % N
        const ziC = (N - zi) % N
        const idxC = ziC * N + xiC
        const w = spectrum.omega[idx]!
        const cosWt = Math.cos(w * t)
        const sinWt = Math.sin(w * t)
        const h0r = spectrum.h0[idx * 2]!
        const h0i = spectrum.h0[idx * 2 + 1]!
        const hCr = spectrum.h0[idxC * 2]!
        const hCi = spectrum.h0[idxC * 2 + 1]!
        // (h0r + i·h0i)·(cos + i·sin) = (h0r·cos − h0i·sin) + i·(h0r·sin + h0i·cos)
        const aRe = h0r * cosWt - h0i * sinWt
        const aIm = h0r * sinWt + h0i * cosWt
        // conj(h0_C) · (cos − i·sin) = (hCr − i·hCi)·(cos − i·sin)
        //                            = (hCr·cos − hCi·sin) + i·(−hCr·sin − hCi·cos)
        const bRe = hCr * cosWt - hCi * sinWt
        const bIm = -hCr * sinWt - hCi * cosWt
        hTilde[idx * 2] = aRe + bRe
        hTilde[idx * 2 + 1] = aIm + bIm
      }
    }

    ifftshift(hTilde, N)
    fft2d(hTilde, N, -1)
    for (let i = 0; i < hTilde.length; i++) hTilde[i] *= N * N

    const cell = tileSize / N
    for (let zi = 0; zi < N; zi++) {
      for (let xi = 0; xi < N; xi++) {
        const x = xi * cell
        const z = zi * cell
        const expected = sampleSpectrumHeight(spectrum, x, z, t)
        const actual = hTilde[(zi * N + xi) * 2]!
        expect(actual).toBeCloseTo(expected, 3)
        expect(Math.abs(hTilde[(zi * N + xi) * 2 + 1]!)).toBeLessThan(1e-3)
      }
    }
  })
})
