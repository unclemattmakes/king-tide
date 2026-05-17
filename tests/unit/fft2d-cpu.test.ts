import { describe, expect, it } from 'vitest'
import { fft2d, fftshift, ifftshift } from '@/engine/sim/water/fft2d-cpu'

/** Helper: make a 2·N·N interleaved-complex Float32Array from a real
 *  N×N grid of values, imag part zeroed. */
function realToComplex(real: number[][]): Float32Array {
  const N = real.length
  const out = new Float32Array(2 * N * N)
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      out[(z * N + x) * 2] = real[z]![x]!
    }
  }
  return out
}

/** Max absolute difference between two interleaved-complex buffers. */
function maxDelta(a: Float32Array, b: Float32Array): number {
  let m = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!)
    if (d > m) m = d
  }
  return m
}

describe('fft2d', () => {
  it('round-trips: forward then inverse recovers the input', () => {
    const N = 8
    const original = new Float32Array(2 * N * N)
    // Fill with deterministic pseudo-random values (real + imag).
    for (let i = 0; i < original.length; i++) {
      original[i] = Math.sin(i * 0.7) * 0.5 + Math.cos(i * 1.3) * 0.3
    }
    const work = new Float32Array(original)
    fft2d(work, N, 1)
    fft2d(work, N, -1)
    expect(maxDelta(work, original)).toBeLessThan(1e-5)
  })

  it('forward FFT of a constant signal puts all energy at DC', () => {
    const N = 8
    const buf = new Float32Array(2 * N * N)
    // Set all real parts to 1, imag to 0.
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        buf[(z * N + x) * 2] = 1
      }
    }
    fft2d(buf, N, 1)
    // DC bin (0, 0) should hold N² (real), everything else ≈ 0.
    expect(buf[0]).toBeCloseTo(N * N, 4)
    expect(buf[1]).toBeCloseTo(0, 4)
    for (let i = 1; i < N * N; i++) {
      expect(Math.abs(buf[2 * i]!)).toBeLessThan(1e-4)
      expect(Math.abs(buf[2 * i + 1]!)).toBeLessThan(1e-4)
    }
  })

  it('inverse FFT of a single non-DC bin produces a pure 2D sinusoid', () => {
    const N = 8
    const buf = new Float32Array(2 * N * N)
    // Put unit amplitude at frequency (kx=1, kz=2). N² scaling so
    // inverse output reads as amplitude 1.
    const xi = 1
    const zi = 2
    const idx = zi * N + xi
    buf[idx * 2] = N * N
    fft2d(buf, N, -1)
    // The inverse FFT should yield h(x, z) = cos(2π·(xi·x + zi·z) / N).
    // Sample at every grid point and confirm.
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = (z * N + x) * 2
        const expected = Math.cos((2 * Math.PI * (xi * x + zi * z)) / N)
        expect(buf[i]!).toBeCloseTo(expected, 4)
        expect(buf[i + 1]!).toBeCloseTo(
          Math.sin((2 * Math.PI * (xi * x + zi * z)) / N),
          4,
        )
      }
    }
  })

  it('matches a naive O(N⁴) DFT reference (small grid)', () => {
    const N = 4
    const real = [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
      [13, 14, 15, 16],
    ]
    const fftBuf = realToComplex(real)
    fft2d(fftBuf, N, 1)
    // Naive DFT: F[u,v] = ΣΣ x[m,n] · e^{-i2π(um/N + vn/N)}.
    for (let v = 0; v < N; v++) {
      for (let u = 0; u < N; u++) {
        let re = 0
        let im = 0
        for (let n = 0; n < N; n++) {
          for (let m = 0; m < N; m++) {
            const angle = (-2 * Math.PI * (u * m + v * n)) / N
            re += real[n]![m]! * Math.cos(angle)
            im += real[n]![m]! * Math.sin(angle)
          }
        }
        const idx = (v * N + u) * 2
        expect(fftBuf[idx]!).toBeCloseTo(re, 3)
        expect(fftBuf[idx + 1]!).toBeCloseTo(im, 3)
      }
    }
  })
})

describe('fftshift / ifftshift', () => {
  it('is its own inverse on an even-sized grid', () => {
    const N = 8
    const buf = new Float32Array(2 * N * N)
    for (let i = 0; i < buf.length; i++) buf[i] = i * 0.3 - 1
    const original = new Float32Array(buf)
    fftshift(buf, N)
    fftshift(buf, N)
    expect(maxDelta(buf, original)).toBe(0)
  })

  it('moves the corner to the center on a delta function', () => {
    const N = 8
    const buf = new Float32Array(2 * N * N)
    // Put a unit spike at corner (0, 0).
    buf[0] = 1
    fftshift(buf, N)
    // After fftshift, the spike should be at (N/2, N/2).
    const centerIdx = (N / 2) * N + N / 2
    expect(buf[centerIdx * 2]).toBe(1)
    // And the corner should be 0.
    expect(buf[0]).toBe(0)
  })

  it('ifftshift undoes fftshift', () => {
    const N = 8
    const buf = new Float32Array(2 * N * N)
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 7) % 11
    const original = new Float32Array(buf)
    fftshift(buf, N)
    ifftshift(buf, N)
    expect(maxDelta(buf, original)).toBe(0)
  })
})
