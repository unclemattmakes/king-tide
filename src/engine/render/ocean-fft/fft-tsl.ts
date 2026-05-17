import * as THREE from 'three'
import {
  cos,
  Fn,
  float,
  instanceIndex,
  sin,
  textureLoad,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec4,
} from 'three/tsl'
import { StorageTexture } from 'three/webgpu'

/**
 * A9 — Real radix-2 Cooley-Tukey 2D FFT pipeline for the GPU.
 *
 * Replaces the O(N⁴) direct IDFT in `createGpuOceanDisplacement`
 * with an O(N²·logN) pipeline. The direct DFT is fine at N=32 (1M
 * ops per cascade per frame) but becomes the bottleneck at N≥64
 * (16M+ ops) — the standard solution is to do a real FFT, which
 * cuts the work down to N²·log₂N (24 576 ops for N=64).
 *
 * Architecture:
 *
 *   1. `inputTexture` (RGBA32F) — caller writes the complex
 *      spectrum to be IFFTed: .r = real, .g = imag (.b/.a are
 *      unused in the v1 pipeline; future revisions can pack two
 *      complex spectra per texel for batched multi-channel FFT).
 *
 *   2. Bit-reversal permutation pass: rearranges the input into
 *      the order the iterative butterfly expects. One dispatch
 *      per axis (row pass + column pass). Reads from
 *      `inputTexture`, writes to ping/pong.
 *
 *   3. Butterfly passes: log₂N stages per axis. Each stage's
 *      kernel reads from src (one ping), writes to dst (the
 *      other), with a uniform `stageUniform` telling it which
 *      butterfly block size to process. Each stage swaps the
 *      ping/pong roles.
 *
 *   4. Scaling: multiplies all texels by 1/N² (inverse-FFT
 *      normalization). Lands the result in `outputTexture`.
 *
 * The bit-reversal and butterfly kernels share twiddle math with
 * the CPU reference in `src/engine/sim/water/fft2d-cpu.ts`. Sign
 * convention is IFFT (synthesis): twiddle base angle = +2π / m at
 * each stage so the synthesis matches the existing direct-DFT
 * sign convention (`exp(+i (kx·x + kz·z + ω·t))`).
 *
 * Current scope (v1):
 *   - Single complex channel per texel — produces one real signal
 *     per IFFT. To produce all 8 outputs (height + Dx + Dz + 4
 *     slope partials), the caller runs this pipeline 4 times
 *     after packing pairs of real outputs into one complex IFFT
 *     each (Tessendorf §6 trick).
 *   - N must be a power of two ≥ 4.
 *   - log₂N parity is auto-handled — the scaling pass always
 *     writes to `outputTexture` regardless of which ping/pong
 *     the final butterfly stage wrote to.
 *
 * Not yet implemented (deferred work):
 *   - 2-complex-per-texel batched FFT (would cut the dispatches
 *     in half for the multi-channel FFT-ocean case).
 *   - Integration into `createGpuOceanDisplacement` —
 *     `createGpuOceanFftDisplacement` is the planned wrapper that
 *     runs 4 FFTs through this pipeline and unpacks into the
 *     existing displacement + slope textures.
 */

export type Fft2dOpts = {
  /** Grid size. Must be a power of two, typically 64..256. */
  N: number
}

export type Fft2dHandle = {
  /** RGBA32F storage texture for the input complex spectrum.
   *  Caller writes `(re, im, 0, 0)` per texel. */
  inputTexture: THREE.Texture
  /** RGBA32F storage texture for the IFFT output. Read by the
   *  caller after `dispatch` completes. `(re, im, 0, 0)` per
   *  texel; for a real-signal IFFT the .g (imag) channel is
   *  zero up to FP rounding. */
  outputTexture: THREE.Texture
  /** Grid size (mirror of opts.N). */
  N: number
  /** Run the full FFT pipeline. Fire-and-forget: WebGPU's
   *  dispatch barriers serialize the passes correctly. Returns
   *  the promise from the final dispatch so callers can await
   *  for strict pipelining if needed. */
  dispatch(renderer: THREE.WebGLRenderer): Promise<void>
  dispose(): void
}

/**
 * Build the 2D radix-2 IFFT compute pipeline. Allocates two
 * ping-pong storage textures + the input/output bindings, and
 * assembles the bit-reversal, butterfly, and scaling kernels.
 *
 * Cost at N=64: 1 (bitrev row) + 6 (row butterflies) + 1 (bitrev
 * col) + 6 (col butterflies) + 1 (scale) = 15 dispatches per
 * full IFFT. Each dispatch is N²=4 096 threads = trivial.
 */
export function createFft2d(opts: Fft2dOpts): Fft2dHandle {
  const N = opts.N
  if (!Number.isInteger(Math.log2(N)) || N < 4) {
    throw new Error(`createFft2d: N=${N} must be a power of two ≥ 4`)
  }
  const logN = Math.log2(N) | 0

  // Caller-facing complex spectrum input. Lives outside the
  // ping-pong pair so the caller can update its contents without
  // racing the kernel.
  const inputTexture = makeRgba32fStorage(N, 'fft2d:input')

  // Two ping-pong storage textures. Sized N×N RGBA32F.
  const pingTexture = makeRgba32fStorage(N, 'fft2d:ping')
  const pongTexture = makeRgba32fStorage(N, 'fft2d:pong')

  // Caller-facing output texture. Always the final destination
  // regardless of how many stages run (log₂N parity).
  const outputTexture = makeRgba32fStorage(N, 'fft2d:output')

  // Stage uniform — set by the dispatch loop before each
  // butterfly invocation. The kernel reads this to know the
  // block size (m = 2^stage) and half-block size (m/2) for its
  // pair lookup.
  const stageUniform = uniform(1)

  // Bit-reversal permutation kernels. Compiled once at
  // construction — `.compute(N*N)` finalizes the dispatch
  // descriptor so per-frame calls just submit (no rebuild).
  const bitReverseRow = buildBitReverseKernel({
    src: inputTexture,
    dst: pingTexture,
    N,
    logN,
    axis: 'row',
  }).compute(N * N)
  const bitReverseCol = buildBitReverseKernel({
    src: pingTexture,
    dst: pongTexture,
    N,
    logN,
    axis: 'col',
  }).compute(N * N)

  // Butterfly kernels. Two variants per axis (ping→pong and
  // pong→ping) so we can alternate at dispatch time without
  // re-binding textures (TSL bakes texture refs at kernel build).
  const rowPingToPong = buildButterflyKernel({
    src: pingTexture,
    dst: pongTexture,
    N,
    axis: 'row',
    stageUniform,
  }).compute(N * N)
  const rowPongToPing = buildButterflyKernel({
    src: pongTexture,
    dst: pingTexture,
    N,
    axis: 'row',
    stageUniform,
  }).compute(N * N)
  const colPingToPong = buildButterflyKernel({
    src: pingTexture,
    dst: pongTexture,
    N,
    axis: 'col',
    stageUniform,
  }).compute(N * N)
  const colPongToPing = buildButterflyKernel({
    src: pongTexture,
    dst: pingTexture,
    N,
    axis: 'col',
    stageUniform,
  }).compute(N * N)

  // Scaling kernel: multiplies the final ping-pong contents by
  // 1/N² and writes to `outputTexture`. Two variants because
  // the final stage's destination depends on log₂N parity.
  const scaleFromPing = buildScaleKernel({
    src: pingTexture,
    dst: outputTexture,
    N,
    scale: 1 / (N * N),
  }).compute(N * N)
  const scaleFromPong = buildScaleKernel({
    src: pongTexture,
    dst: outputTexture,
    N,
    scale: 1 / (N * N),
  }).compute(N * N)

  // Precompute dispatch sequence parity. Bit-rev row writes to
  // ping (src=input → ping). Bit-rev col reads ping, writes
  // pong. After bit-rev: data is in pong.
  //
  // Row butterflies: stage 1 reads pong, writes ping. Stage 2
  // reads ping, writes pong. Alternating. After logN row
  // stages, parity depends on logN.
  //
  // Bit-rev col will read from whatever the last row stage
  // wrote to. To keep this simple, after the row butterflies we
  // do bit-rev col reading from the last row stage's
  // destination and writing to the OTHER texture, which becomes
  // stage 1's src for the column pass.
  //
  // The full alternation pattern is built in dispatch() at
  // runtime.

  // log₂N parity: dispatch sequence below assumes log₂N is even
  // so the row + column passes each land back in `ping` after
  // alternating. v1 only supports N ∈ {4, 16, 64, 256, ...}.
  if (logN % 2 !== 0) {
    throw new Error(
      `createFft2d: log₂N=${logN} is odd — v1 only supports log₂N even ` +
        `(N ∈ {4, 16, 64, 256, ...}). Fix the parity by extending dispatch().`,
    )
  }

  function dispatch(renderer: THREE.WebGLRenderer): Promise<void> {
    // biome-ignore lint/suspicious/noExplicitAny: WebGPURenderer cast
    const r = renderer as any
    if (typeof r.computeAsync !== 'function') return Promise.resolve()

    // -- Bit-reversal row pass: input → ping --
    r.computeAsync(bitReverseRow)

    // -- Row butterfly stages: alternate ping/pong --
    // Start state: data in ping. Stage 1: ping → pong. Stage 2:
    // pong → ping. ... After logN (even) stages, data lands in
    // pong (the last destination).
    let dataInPing = true
    for (let s = 1; s <= logN; s++) {
      stageUniform.value = s
      r.computeAsync(dataInPing ? rowPingToPong : rowPongToPing)
      dataInPing = !dataInPing
    }
    // logN even ⇒ dataInPing is true again (alternated logN times
    // from initial true). So the last row stage wrote to ping, not
    // pong — actually, double-check. dataInPing starts true.
    // After stage 1 it's false. After stage 2 true. After logN
    // (even) stages it's true again. But the LAST stage's dst was
    // determined BEFORE the toggle. Stage logN, dataInPing was
    // false before (since (logN-1) iterations toggled it from
    // true → false → true → ...; for logN even, after logN-1 = odd
    // iterations, dataInPing is false). So the last stage's
    // kernel was rowPongToPing → data in ping. After post-toggle,
    // dataInPing is true. Correct.

    // -- Bit-reversal column pass: ping → pong --
    r.computeAsync(bitReverseCol)

    // -- Column butterfly stages: alternate pong/ping starting
    //    from pong (where bit-rev col deposited the data). --
    let dataInPong = true
    for (let s = 1; s <= logN; s++) {
      stageUniform.value = s
      r.computeAsync(dataInPong ? colPongToPing : colPingToPong)
      dataInPong = !dataInPong
    }
    // logN even ⇒ same logic; final stage wrote back to pong.

    // -- Scale & copy to output --
    return r.computeAsync(dataInPong ? scaleFromPong : scaleFromPing) as Promise<void>
  }

  function dispose(): void {
    inputTexture.dispose()
    pingTexture.dispose()
    pongTexture.dispose()
    outputTexture.dispose()
  }

  return { inputTexture, outputTexture, N, dispatch, dispose }
}

// ---------------------------------------------------------------------------
// Internal builders
// ---------------------------------------------------------------------------

function makeRgba32fStorage(N: number, name: string): THREE.Texture {
  const tex = new StorageTexture(N, N)
  tex.name = name
  tex.format = THREE.RGBAFormat
  tex.type = THREE.FloatType
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = false
  return tex
}

type BitReverseKernelOpts = {
  src: THREE.Texture
  dst: THREE.Texture
  N: number
  logN: number
  axis: 'row' | 'col'
}

/**
 * Bit-reversal permutation kernel for one axis. Reads from src,
 * writes to dst, with the bit-reversed coord substituted along
 * `axis`. The other axis is identity (a pure copy along that
 * dimension).
 *
 * The bit-reversal walks the `logN` low bits of the index.
 * Standard textbook formulation, unrolled in JS at kernel-build
 * time so the WGSL output is straight-line code (no loops).
 */
function buildBitReverseKernel(opts: BitReverseKernelOpts) {
  const { src, dst, N, logN, axis } = opts
  return Fn(() => {
    const px = instanceIndex.mod(N)
    const py = instanceIndex.div(N)

    // Compute bit-reversed index of either px (row pass) or py
    // (col pass). Other axis passes through unchanged.
    // Build the reversed value bit-by-bit.
    const idx = axis === 'row' ? px : py
    // biome-ignore lint/suspicious/noExplicitAny: TSL uint reduction
    let rev: any = uint(0)
    for (let b = 0; b < logN; b++) {
      // Take the b-th bit of idx and place it at position
      // (logN-1-b) in the reversed value. Mask + shift.
      const bit = idx.shiftRight(uint(b)).bitAnd(uint(1))
      const placed = bit.shiftLeft(uint(logN - 1 - b))
      rev = rev.bitOr(placed)
    }
    const revIdx = rev
    const srcPx = axis === 'row' ? revIdx : px
    const srcPy = axis === 'row' ? py : revIdx
    // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle
    const sample = textureLoad(src, uvec2(srcPx, srcPy), 0) as any
    textureStore(dst, uvec2(px, py), vec4(sample.r, sample.g, float(0), float(0))).toWriteOnly()
  })()
}

type ButterflyKernelOpts = {
  src: THREE.Texture
  dst: THREE.Texture
  N: number
  axis: 'row' | 'col'
  // biome-ignore lint/suspicious/noExplicitAny: TSL uniform node
  stageUniform: any
}

/**
 * One butterfly stage of the iterative radix-2 Cooley-Tukey
 * FFT, applied along `axis`. The `stageUniform` (1..log₂N)
 * tells the kernel which block size m = 2^stage to process.
 *
 * IFFT sign convention (matches CPU `fft1d(buf, N, -1)`):
 *   twiddle base angle = +2π / m  per stage
 *
 * For each output thread at position (px, py) on axis `axis`
 * the kernel computes:
 *
 *   - blockIdx = idx_axis / m
 *   - posInBlock = idx_axis % m
 *   - halfm = m / 2
 *   - If posInBlock < halfm: output = src[idx] + twiddle ·
 *     src[idx + halfm]  (the "u + W·t" half of the butterfly)
 *   - Else:                  output = src[idx − halfm] − twiddle ·
 *     src[idx]            (the "u − W·t" half)
 *
 * `idx_axis` and the partner offset all happen on the chosen
 * axis; the other coordinate is identity.
 */
function buildButterflyKernel(opts: ButterflyKernelOpts) {
  const { src, dst, N, axis, stageUniform } = opts
  return Fn(() => {
    const px = instanceIndex.mod(N)
    const py = instanceIndex.div(N)

    const idxAxis = axis === 'row' ? px : py
    const otherAxis = axis === 'row' ? py : px

    // m = 2^stage. Compute via shift-left so we can use it as a
    // uint divisor / modulus.
    const m = uint(1).shiftLeft(uint(stageUniform))
    const halfm = m.shiftRight(uint(1))

    // Position within the current block, and the partner index
    // (the other half of the butterfly).
    const blockStart = idxAxis.div(m).mul(m)
    const posInBlock = idxAxis.mod(m)
    // biome-ignore lint/suspicious/noExplicitAny: TSL bool node
    const isLowerHalf: any = posInBlock.lessThan(halfm)

    // Effective "twiddle index" j is the position within the
    // lower half: for a thread in lower half it's posInBlock,
    // for upper half it's posInBlock - halfm. Both halves use
    // the same j → twiddle.
    const j = isLowerHalf.select(posInBlock, posInBlock.sub(halfm))
    // Partner: lower-half thread's partner is at +halfm; upper-
    // half thread's partner is at −halfm (relative to itself).
    const partnerAxis = isLowerHalf.select(
      blockStart.add(j).add(halfm),
      blockStart.add(j),
    )
    const selfAxis = isLowerHalf.select(
      blockStart.add(j),
      blockStart.add(j).add(halfm),
    )

    // Twiddle factor: W_m^j = exp(+i · 2π · j / m). IFFT sign.
    const angle = float(2 * Math.PI).mul(float(j)).div(float(m))
    const wr = cos(angle)
    const wi = sin(angle)

    // Sample src at both "self" and "partner" positions on the
    // active axis (the other axis stays at `otherAxis`).
    const selfPx = axis === 'row' ? selfAxis : otherAxis
    const selfPy = axis === 'row' ? otherAxis : selfAxis
    const partnerPx = axis === 'row' ? partnerAxis : otherAxis
    const partnerPy = axis === 'row' ? otherAxis : partnerAxis

    // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle
    const selfSample = textureLoad(src, uvec2(uint(selfPx), uint(selfPy)), 0) as any
    // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle
    const partnerSample = textureLoad(
      src,
      uvec2(uint(partnerPx), uint(partnerPy)),
      0,
    ) as any

    // Complex math:
    //   t = W * partner    (W = wr + i·wi, partner = pr + i·pi)
    //   tr = wr·pr − wi·pi
    //   ti = wr·pi + wi·pr
    const tr = wr.mul(partnerSample.r).sub(wi.mul(partnerSample.g))
    const ti = wr.mul(partnerSample.g).add(wi.mul(partnerSample.r))

    // u: the LOWER-half element's value. For lower-half threads
    // self IS u; for upper-half threads partner is u.
    const ur = isLowerHalf.select(selfSample.r, partnerSample.r)
    const ui = isLowerHalf.select(selfSample.g, partnerSample.g)
    // For lower-half threads, twiddle multiplies partner; for
    // upper-half threads, twiddle multiplies self. We already
    // computed tr/ti using `partnerSample` — for the upper-half
    // case we need the twiddle * selfSample instead. Recompute.
    const trUpper = wr.mul(selfSample.r).sub(wi.mul(selfSample.g))
    const tiUpper = wr.mul(selfSample.g).add(wi.mul(selfSample.r))
    const tEffR = isLowerHalf.select(tr, trUpper)
    const tEffI = isLowerHalf.select(ti, tiUpper)

    // Output: lower half = u + W·t,  upper half = u − W·t
    const outR = isLowerHalf.select(ur.add(tEffR), ur.sub(tEffR))
    const outI = isLowerHalf.select(ui.add(tEffI), ui.sub(tEffI))

    textureStore(dst, uvec2(px, py), vec4(outR, outI, float(0), float(0))).toWriteOnly()
  })()
}

type ScaleKernelOpts = {
  src: THREE.Texture
  dst: THREE.Texture
  N: number
  scale: number
}

/**
 * Final scaling pass — multiplies every texel by `scale` and
 * copies to `dst`. For an IFFT the scale is 1/N². Decoupled
 * from the butterfly kernels so we can land the output in a
 * stable texture regardless of which ping-pong the final stage
 * wrote to.
 */
function buildScaleKernel(opts: ScaleKernelOpts) {
  const { src, dst, N, scale } = opts
  const scaleUniform = uniform(scale)
  return Fn(() => {
    const px = instanceIndex.mod(N)
    const py = instanceIndex.div(N)
    // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle
    const sample = textureLoad(src, uvec2(px, py), 0) as any
    textureStore(
      dst,
      uvec2(px, py),
      vec4(sample.r.mul(scaleUniform), sample.g.mul(scaleUniform), float(0), float(0)),
    ).toWriteOnly()
  })()
}
