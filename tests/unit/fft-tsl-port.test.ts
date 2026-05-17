import { describe, expect, it } from 'vitest'
import { fft2d } from '@/engine/sim/water/fft2d-cpu'
import { buildPhillipsSpectrum } from '@/engine/sim/water/phillips'

/**
 * A9 debug oracle — pure-JS port of the GPU radix-2 FFT pipeline in
 * `src/engine/render/ocean-fft/fft-tsl.ts`, mirroring its indexing
 * EXACTLY (bit-reverse + butterfly stages with per-thread "lower
 * half / upper half" branch). The point is to validate the algorithm
 * separately from TSL → WebGPU translation: if the JS port matches
 * the existing `fft2d-cpu` reference, the GPU bug is in TSL/runtime
 * (e.g. shared stageUniform race). If it doesn't, the algorithm
 * itself has a bug.
 */

// Bit-reverse the low `logN` bits of `idx`.
function bitReverse(idx: number, logN: number): number {
  let rev = 0
  for (let b = 0; b < logN; b++) {
    const bit = (idx >> b) & 1
    rev |= bit << (logN - 1 - b)
  }
  return rev
}

type Complex2D = Float32Array // length 2*N*N, interleaved re/im

/** Batched buffer: length 4*N*N, interleaved (re0, im0, re1, im1). */
type Batched2D = Float32Array

function makeBuf(N: number): Complex2D {
  return new Float32Array(2 * N * N)
}

function makeBatchedBuf(N: number): Batched2D {
  return new Float32Array(4 * N * N)
}

function copyBuf(src: Complex2D, dst: Complex2D): void {
  dst.set(src)
}

/**
 * Bit-reversal permutation pass — mirrors `buildBitReverseKernel`.
 * dst[px, py] = src[bitrev(px), py]  (axis='row')
 * dst[px, py] = src[px, bitrev(py)]  (axis='col')
 */
function bitReversePass(
  src: Complex2D,
  dst: Complex2D,
  N: number,
  logN: number,
  axis: 'row' | 'col',
): void {
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const srcPx = axis === 'row' ? bitReverse(px, logN) : px
      const srcPy = axis === 'row' ? py : bitReverse(py, logN)
      const srcIdx = (srcPy * N + srcPx) * 2
      const dstIdx = (py * N + px) * 2
      dst[dstIdx] = src[srcIdx]!
      dst[dstIdx + 1] = src[srcIdx + 1]!
    }
  }
}

/**
 * One butterfly stage along `axis` — mirrors `buildButterflyKernel`.
 * Per-output-thread (px, py):
 *
 *   idxAxis = axis === 'row' ? px : py
 *   otherAxis = axis === 'row' ? py : px
 *   m = 1 << stage, halfm = m >> 1
 *   blockStart = (idxAxis / m) * m
 *   posInBlock = idxAxis % m
 *   isLowerHalf = posInBlock < halfm
 *   j = isLowerHalf ? posInBlock : posInBlock - halfm
 *   selfAxis = blockStart + (isLowerHalf ? j : j + halfm)
 *   partnerAxis = blockStart + (isLowerHalf ? j + halfm : j)
 *   W = e^{+i·2π·j/m}  (IFFT sign)
 *   tEff = W · (isLowerHalf ? partner : self)
 *   u    = (isLowerHalf ? self : partner)
 *   out = isLowerHalf ? u + tEff : u - tEff
 */
function butterflyPass(
  src: Complex2D,
  dst: Complex2D,
  N: number,
  axis: 'row' | 'col',
  stage: number,
): void {
  const m = 1 << stage
  const halfm = m >> 1
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const idxAxis = axis === 'row' ? px : py
      const otherAxis = axis === 'row' ? py : px
      const blockStart = Math.floor(idxAxis / m) * m
      const posInBlock = idxAxis % m
      const isLowerHalf = posInBlock < halfm
      const j = isLowerHalf ? posInBlock : posInBlock - halfm
      const selfAxis = isLowerHalf ? blockStart + j : blockStart + j + halfm
      const partnerAxis = isLowerHalf
        ? blockStart + j + halfm
        : blockStart + j
      const angle = (2 * Math.PI * j) / m
      const wr = Math.cos(angle)
      const wi = Math.sin(angle)
      const selfPx = axis === 'row' ? selfAxis : otherAxis
      const selfPy = axis === 'row' ? otherAxis : selfAxis
      const partnerPx = axis === 'row' ? partnerAxis : otherAxis
      const partnerPy = axis === 'row' ? otherAxis : partnerAxis
      const sIdx = (selfPy * N + selfPx) * 2
      const pIdx = (partnerPy * N + partnerPx) * 2
      const sR = src[sIdx]!
      const sI = src[sIdx + 1]!
      const pR = src[pIdx]!
      const pI = src[pIdx + 1]!
      let tR: number
      let tI: number
      let uR: number
      let uI: number
      if (isLowerHalf) {
        // t = W * partner, u = self
        tR = wr * pR - wi * pI
        tI = wr * pI + wi * pR
        uR = sR
        uI = sI
      } else {
        // t = W * self, u = partner
        tR = wr * sR - wi * sI
        tI = wr * sI + wi * sR
        uR = pR
        uI = pI
      }
      const outR = isLowerHalf ? uR + tR : uR - tR
      const outI = isLowerHalf ? uI + tI : uI - tI
      const dIdx = (py * N + px) * 2
      dst[dIdx] = outR
      dst[dIdx + 1] = outI
    }
  }
}

/**
 * Full 2D IFFT mimicking the GPU dispatch sequence in `Fft2dHandle.dispatch`.
 * Parity-agnostic — tracks the data location explicitly so the same code
 * handles both log₂N even (N=4, 16, 64, 256, ...) and log₂N odd (N=8, 32,
 * 128, ...).
 *
 *   1. bitReversePass row: input → ping
 *   2. log2N row butterflies, alternating ping/pong, stage = 1..log2N
 *   3. bitReversePass col: read from wherever data is, write to other.
 *   4. log2N col butterflies, alternating, stage = 1..log2N
 *   5. Final destination = "outputTexture" content. No 1/N² scaling.
 */
function gpuPortFft2d(input: Complex2D, N: number): Complex2D {
  const logN = Math.log2(N) | 0
  const ping = makeBuf(N)
  const pong = makeBuf(N)

  // 1) bit-reverse row: input → ping
  bitReversePass(input, ping, N, logN, 'row')
  let dataInPing = true

  // 2) row butterflies — alternate ping/pong each stage.
  for (let s = 1; s <= logN; s++) {
    if (dataInPing) butterflyPass(ping, pong, N, 'row', s)
    else butterflyPass(pong, ping, N, 'row', s)
    dataInPing = !dataInPing
  }

  // 3) bit-reverse col — read from current location, write to other.
  if (dataInPing) {
    bitReversePass(ping, pong, N, logN, 'col')
    dataInPing = false
  } else {
    bitReversePass(pong, ping, N, logN, 'col')
    dataInPing = true
  }

  // 4) col butterflies — alternate.
  for (let s = 1; s <= logN; s++) {
    if (dataInPing) butterflyPass(ping, pong, N, 'col', s)
    else butterflyPass(pong, ping, N, 'col', s)
    dataInPing = !dataInPing
  }

  // 5) Final output (no 1/N² scaling — matches fft-tsl's scale=1).
  return dataInPing ? ping : pong
}

// Maximum absolute difference between two complex bufs.
function maxDelta(a: Complex2D, b: Complex2D): number {
  let m = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!)
    if (d > m) m = d
  }
  return m
}

/**
 * Batched 2D IFFT JS port — same algorithm as `gpuPortFft2d`,
 * extended to run two complex IFFTs in parallel per texel.
 * R/G holds the first complex spectrum, B/A holds the second.
 * Mirrors the runtime kernels' (batched=true) behavior so we
 * can verify the batched math against the unbatched reference.
 */
function gpuPortFft2dBatched(input: Batched2D, N: number): Batched2D {
  // Split into two unbatched bufs, run each, recombine. The
  // batched kernel processes them independently so this reference
  // SHOULD match the runtime exactly.
  const inA = makeBuf(N)
  const inB = makeBuf(N)
  for (let i = 0; i < N * N; i++) {
    inA[i * 2] = input[i * 4]!
    inA[i * 2 + 1] = input[i * 4 + 1]!
    inB[i * 2] = input[i * 4 + 2]!
    inB[i * 2 + 1] = input[i * 4 + 3]!
  }
  const outA = gpuPortFft2d(inA, N)
  const outB = gpuPortFft2d(inB, N)
  const out = makeBatchedBuf(N)
  for (let i = 0; i < N * N; i++) {
    out[i * 4] = outA[i * 2]!
    out[i * 4 + 1] = outA[i * 2 + 1]!
    out[i * 4 + 2] = outB[i * 2]!
    out[i * 4 + 3] = outB[i * 2 + 1]!
  }
  return out
}

describe('GPU FFT algorithm (JS port) vs CPU FFT reference', () => {
  it('matches fft2d(buf, N, -1) × N² on a random input (N=4)', () => {
    const N = 4
    const input = makeBuf(N)
    // Random complex input.
    for (let i = 0; i < input.length; i++) {
      input[i] = Math.sin(i * 0.7) * 0.5 + Math.cos(i * 1.3) * 0.3
    }

    // GPU port (unnormalized IFFT — scale=1).
    const gpuOut = gpuPortFft2d(input, N)

    // CPU reference: fft2d with direction=-1 divides by N. So
    // multiplying by N² recovers the unnormalized IFFT.
    const cpuOut = new Float32Array(input)
    fft2d(cpuOut, N, -1)
    for (let i = 0; i < cpuOut.length; i++) cpuOut[i] = cpuOut[i]! * N * N

    // eslint-disable-next-line no-console
    console.log('GPU port [0..7]:', Array.from(gpuOut.slice(0, 8)))
    // eslint-disable-next-line no-console
    console.log('CPU ref  [0..7]:', Array.from(cpuOut.slice(0, 8)))
    expect(maxDelta(gpuOut, cpuOut)).toBeLessThan(1e-4)
  })

  it('matches fft2d(buf, N, -1) × N² on a random input (N=16, log₂N even)', () => {
    const N = 16
    const input = makeBuf(N)
    for (let i = 0; i < input.length; i++) {
      input[i] = Math.sin(i * 0.7) * 0.5 + Math.cos(i * 1.3) * 0.3
    }
    const gpuOut = gpuPortFft2d(input, N)
    const cpuOut = new Float32Array(input)
    fft2d(cpuOut, N, -1)
    for (let i = 0; i < cpuOut.length; i++) cpuOut[i] = cpuOut[i]! * N * N
    expect(maxDelta(gpuOut, cpuOut)).toBeLessThan(1e-2)
  })

  it('matches fft2d(buf, N, -1) × N² on a random input (N=8, log₂N odd)', () => {
    // log₂N odd exercises the parity-agnostic dispatch — bit-rev
    // col reads from pong (not ping), and the final stage lands
    // the data on the opposite buffer from the even case.
    const N = 8
    const input = makeBuf(N)
    for (let i = 0; i < input.length; i++) {
      input[i] = Math.sin(i * 0.9) * 0.4 + Math.cos(i * 1.1) * 0.2
    }
    const gpuOut = gpuPortFft2d(input, N)
    const cpuOut = new Float32Array(input)
    fft2d(cpuOut, N, -1)
    for (let i = 0; i < cpuOut.length; i++) cpuOut[i] = cpuOut[i]! * N * N
    expect(maxDelta(gpuOut, cpuOut)).toBeLessThan(1e-3)
  })

  it('matches fft2d(buf, N, -1) × N² on a random input (N=128, log₂N=7 odd)', () => {
    // N=128 is the planned production size for cascade 0. Same
    // parity branch as N=8 but at full grid resolution.
    const N = 128
    const input = makeBuf(N)
    for (let i = 0; i < input.length; i++) {
      input[i] = Math.sin(i * 0.5) * 0.3 + Math.cos(i * 1.7) * 0.25
    }
    const gpuOut = gpuPortFft2d(input, N)
    const cpuOut = new Float32Array(input)
    fft2d(cpuOut, N, -1)
    for (let i = 0; i < cpuOut.length; i++) cpuOut[i] = cpuOut[i]! * N * N
    // Larger N → more accumulated FP error; loosen tolerance a tad.
    // FP32 noise floor at this size is around 1e-4 relative.
    const maxRef = Math.max(...Array.from(cpuOut, Math.abs))
    expect(maxDelta(gpuOut, cpuOut) / maxRef).toBeLessThan(1e-3)
  })

  it('inverse of a single non-DC bin produces a pure sinusoid (N=4)', () => {
    const N = 4
    const input = makeBuf(N)
    // Spike at (kx=1, kz=0).
    const xi = 1
    const zi = 0
    input[(zi * N + xi) * 2] = 1
    const out = gpuPortFft2d(input, N)
    // Expected: e^{+i·2π·(xi·n_x + zi·n_z)/N}, no normalization.
    for (let n_z = 0; n_z < N; n_z++) {
      for (let n_x = 0; n_x < N; n_x++) {
        const expectedR = Math.cos((2 * Math.PI * (xi * n_x + zi * n_z)) / N)
        const expectedI = Math.sin((2 * Math.PI * (xi * n_x + zi * n_z)) / N)
        const idx = (n_z * N + n_x) * 2
        expect(out[idx]!).toBeCloseTo(expectedR, 4)
        expect(out[idx + 1]!).toBeCloseTo(expectedI, 4)
      }
    }
  })

  it('constant DC produces flat DC × N²', () => {
    const N = 4
    const input = makeBuf(N)
    // DC = 1, everything else 0.
    input[0] = 1
    const out = gpuPortFft2d(input, N)
    // Expected: each output = 1 (sum of e^{i·0} for k=0 only).
    for (let i = 0; i < N * N; i++) {
      expect(out[2 * i]!).toBeCloseTo(1, 4)
      expect(out[2 * i + 1]!).toBeCloseTo(0, 4)
    }
  })
})

/**
 * End-to-end parity check: full FFT pipeline (spectrum-build → IFFT
 * → unpack) for the HEIGHT field, run on a real Phillips spectrum,
 * compared to the direct-DFT analytic sum at every grid point.
 *
 * This is the most direct test of whether the FFT-path math is
 * correct end-to-end. If it passes, the visible amplitude bug
 * in `?fftbake=fft` must be in TSL/runtime (not the algorithm).
 */
describe('FFT pipeline end-to-end parity vs direct DFT', () => {
  it('FFT-path height matches direct-DFT height at every grid point (N=16, t=0)', () => {
    const N = 16
    const tileSize = 32
    const t = 0
    const spectrum = buildPhillipsSpectrum({
      N,
      tileSize,
      windSpeed: 9,
      windDirX: 1,
      windDirZ: 0,
      amplitude: 0.0008,
      smallWavelengthCutoff: 0.6,
      seed: 0xa11f,
    })

    // --- FFT path replication --------------------------------------
    // Spectrum-build kernel: ifftshift + time-evolve into the FFT
    // input layout. h0 lives in centered layout (DC at N/2); we
    // write to natural-order (DC at index 0).
    const fftInput = makeBuf(N)
    const halfN = N / 2
    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        // ifftshift read: (px + halfN) mod N
        const hx = (px + halfN) % N
        const hy = (py + halfN) % N
        const hIdx = hy * N + hx
        const h0r = spectrum.h0[hIdx * 2]!
        const h0i = spectrum.h0[hIdx * 2 + 1]!
        const omega = spectrum.omega[hIdx]!
        // H = h0 · e^{iωt}
        const ct = Math.cos(omega * t)
        const st = Math.sin(omega * t)
        const Hr = h0r * ct - h0i * st
        const Hi = h0r * st + h0i * ct
        const idx = py * N + px
        fftInput[idx * 2] = Hr
        fftInput[idx * 2 + 1] = Hi
      }
    }

    // 2D IFFT via the GPU-port (no normalization, scale=1).
    const fftOut = gpuPortFft2d(fftInput, N)

    // Unpack: height = 2 · Re[output[n_x, n_z]].
    const heightFft = new Float32Array(N * N)
    for (let n_z = 0; n_z < N; n_z++) {
      for (let n_x = 0; n_x < N; n_x++) {
        heightFft[n_z * N + n_x] = 2 * fftOut[(n_z * N + n_x) * 2]!
      }
    }

    // --- Direct DFT path replication -----------------------------
    // height = Σ_kxic 2·Re[h0·e^{iφ}] where φ = 2π(kxic·u+kzic·v)+ωt
    // and u = n_x / N. Read h0 from CENTERED layout (xi=0..N, kxic=xi-N/2).
    const heightDirect = new Float32Array(N * N)
    for (let n_z = 0; n_z < N; n_z++) {
      for (let n_x = 0; n_x < N; n_x++) {
        const u = n_x / N
        const v = n_z / N
        let h = 0
        for (let zi = 0; zi < N; zi++) {
          for (let xi = 0; xi < N; xi++) {
            const kxic = xi - halfN
            const kzic = zi - halfN
            const idx = zi * N + xi
            const h0r = spectrum.h0[idx * 2]!
            const h0i = spectrum.h0[idx * 2 + 1]!
            const omega = spectrum.omega[idx]!
            const phase = 2 * Math.PI * (kxic * u + kzic * v) + omega * t
            const realPart = h0r * Math.cos(phase) - h0i * Math.sin(phase)
            h += 2 * realPart
          }
        }
        heightDirect[n_z * N + n_x] = h
      }
    }

    // --- Compare -------------------------------------------------
    let maxAbsDelta = 0
    let maxAbsHeight = 0
    for (let i = 0; i < heightFft.length; i++) {
      const d = Math.abs(heightFft[i]! - heightDirect[i]!)
      if (d > maxAbsDelta) maxAbsDelta = d
      const m = Math.abs(heightDirect[i]!)
      if (m > maxAbsHeight) maxAbsHeight = m
    }
    // eslint-disable-next-line no-console
    console.log(
      `FFT vs direct DFT height: maxAbsDelta=${maxAbsDelta.toExponential(3)} maxAbsHeight=${maxAbsHeight.toExponential(3)} relErr=${(maxAbsDelta / Math.max(maxAbsHeight, 1e-12)).toExponential(3)}`,
    )
    // Relative error should be FP32 noise.
    expect(maxAbsDelta / Math.max(maxAbsHeight, 1e-12)).toBeLessThan(1e-4)
  })

  it('FFT-path height matches direct-DFT height at t > 0 (N=16, t=2.3)', () => {
    const N = 16
    const tileSize = 32
    const t = 2.3
    const spectrum = buildPhillipsSpectrum({
      N,
      tileSize,
      windSpeed: 9,
      windDirX: 0.7,
      windDirZ: 0.714,
      amplitude: 0.0008,
      smallWavelengthCutoff: 0.6,
      seed: 0xa11f,
    })

    const halfN = N / 2
    const fftInput = makeBuf(N)
    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const hx = (px + halfN) % N
        const hy = (py + halfN) % N
        const hIdx = hy * N + hx
        const h0r = spectrum.h0[hIdx * 2]!
        const h0i = spectrum.h0[hIdx * 2 + 1]!
        const omega = spectrum.omega[hIdx]!
        const ct = Math.cos(omega * t)
        const st = Math.sin(omega * t)
        fftInput[(py * N + px) * 2] = h0r * ct - h0i * st
        fftInput[(py * N + px) * 2 + 1] = h0r * st + h0i * ct
      }
    }

    const fftOut = gpuPortFft2d(fftInput, N)
    const heightFft = new Float32Array(N * N)
    for (let i = 0; i < N * N; i++) heightFft[i] = 2 * fftOut[i * 2]!

    const heightDirect = new Float32Array(N * N)
    for (let n_z = 0; n_z < N; n_z++) {
      for (let n_x = 0; n_x < N; n_x++) {
        const u = n_x / N
        const v = n_z / N
        let h = 0
        for (let zi = 0; zi < N; zi++) {
          for (let xi = 0; xi < N; xi++) {
            const kxic = xi - halfN
            const kzic = zi - halfN
            const idx = zi * N + xi
            const h0r = spectrum.h0[idx * 2]!
            const h0i = spectrum.h0[idx * 2 + 1]!
            const omega = spectrum.omega[idx]!
            const phase = 2 * Math.PI * (kxic * u + kzic * v) + omega * t
            const realPart = h0r * Math.cos(phase) - h0i * Math.sin(phase)
            h += 2 * realPart
          }
        }
        heightDirect[n_z * N + n_x] = h
      }
    }

    let maxAbsDelta = 0
    let maxAbsHeight = 0
    for (let i = 0; i < heightFft.length; i++) {
      const d = Math.abs(heightFft[i]! - heightDirect[i]!)
      if (d > maxAbsDelta) maxAbsDelta = d
      const m = Math.abs(heightDirect[i]!)
      if (m > maxAbsHeight) maxAbsHeight = m
    }
    // eslint-disable-next-line no-console
    console.log(
      `t=2.3 FFT vs direct DFT: maxAbsDelta=${maxAbsDelta.toExponential(3)} maxAbsHeight=${maxAbsHeight.toExponential(3)} relErr=${(maxAbsDelta / Math.max(maxAbsHeight, 1e-12)).toExponential(3)}`,
    )
    expect(maxAbsDelta / Math.max(maxAbsHeight, 1e-12)).toBeLessThan(1e-4)
  })
})
