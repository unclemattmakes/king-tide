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
 *   3. Butterfly passes: log₂N stages per axis. Each stage has
 *      its OWN compiled kernel (the block size m = 2^stage is
 *      baked in at construction). A separate kernel per (axis,
 *      ping/pong direction, stage) avoids the per-dispatch
 *      uniform write that an earlier draft used — sharing a
 *      stage uniform across dispatches is error-prone in
 *      practice because the runtime may coalesce multiple
 *      dispatches' uniform writes onto the same backing buffer.
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
  /** Process TWO complex spectra in parallel per texel — first
   *  in the R/G channels, second in B/A. Halves the dispatch
   *  count for callers that need many concurrent IFFTs (the
   *  FFT-ocean pipeline pairs its 8 quantity spectra into 4
   *  batched FFTs). The bit-reverse + butterfly + scale kernels
   *  cost roughly +30 % per dispatch (a few more reads/writes,
   *  twice the complex math) but the dispatch count drops 2×,
   *  which is the dominant per-frame cost for short FFTs.
   *  Default: false (R/G only, B/A zeroed). */
  batched?: boolean
}

export type Fft2dHandle = {
  /** RGBA32F storage texture for the input complex spectrum.
   *  Caller writes `(re, im, 0, 0)` per texel. In batched mode,
   *  writes `(re0, im0, re1, im1)` — two complex spectra per
   *  texel. */
  inputTexture: THREE.Texture
  /** RGBA32F storage texture for the IFFT output. Read by the
   *  caller after `dispatch` completes. `(re, im, 0, 0)` per
   *  texel (or `(re0, im0, re1, im1)` in batched mode). For a
   *  real-signal IFFT the .g / .a (imag) channels are zero up
   *  to FP rounding. */
  outputTexture: THREE.Texture
  /** Grid size (mirror of opts.N). */
  N: number
  /** Whether this handle was built in batched mode (mirror of
   *  opts.batched). */
  batched: boolean
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
 *
 * Kernel count per FFT2D handle at N=64:
 *   - 2 bit-reverse (row + col)
 *   - 4·log₂N = 24 butterfly (axis × direction × stage)
 *   - 2 scale (one per final-stage destination)
 *   = 28 compiled kernels per handle.
 * All compiled once at construction; per-frame is just submission.
 */
export function createFft2d(opts: Fft2dOpts): Fft2dHandle {
  const N = opts.N
  const batched = opts.batched ?? false
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

  // Bit-reversal permutation kernels. Compiled once at
  // construction — `.compute(N*N)` finalizes the dispatch
  // descriptor so per-frame calls just submit (no rebuild).
  //
  // Two col variants: bit-rev col has to read from whichever
  // ping/pong the row-butterfly pass landed the data in. For
  // log₂N even the data lands in ping (because the alternating
  // sequence brings us back after even-many toggles); for log₂N
  // odd it lands in pong. The dispatch loop picks the right
  // variant based on `logN % 2`.
  const bitReverseRow = buildBitReverseKernel({
    src: inputTexture,
    dst: pingTexture,
    N,
    logN,
    axis: 'row',
    batched,
  }).compute(N * N)
  const bitReverseColFromPing = buildBitReverseKernel({
    src: pingTexture,
    dst: pongTexture,
    N,
    logN,
    axis: 'col',
    batched,
  }).compute(N * N)
  const bitReverseColFromPong = buildBitReverseKernel({
    src: pongTexture,
    dst: pingTexture,
    N,
    logN,
    axis: 'col',
    batched,
  }).compute(N * N)

  // Butterfly kernels — one PER stage per (axis × ping/pong
  // direction). The stage value (1..log₂N) is baked into the
  // kernel as a compile-time constant rather than read from a
  // shared uniform. This used to be a single kernel per axis ×
  // direction (4 total) with `stageUniform.value = s` set
  // between dispatches; that introduced an order-dependency on
  // when three.js uploaded the uniform buffer (multiple
  // dispatches sharing one uniform write into the same backing
  // buffer in queue order — easy to get wrong in practice). The
  // compile-time-constant approach sidesteps the question
  // entirely: each dispatch picks one of the precompiled
  // kernels, no shared state. The cost is 4·log₂N kernels per
  // FFT2D handle (24 at N=64), which is fine at construction
  // time and zero per-frame overhead.
  //
  // Indexed [stage − 1]: `rowPingToPongStages[0]` is stage 1, etc.
  // `.compute(N*N)` returns a `ComputeNode` (TSL); the consumer
  // (`renderer.computeAsync`) takes `any` so we sidestep TSL's
  // narrow generic typing.
  // biome-ignore lint/suspicious/noExplicitAny: TSL ComputeNode typing
  const rowPingToPongStages: any[] = []
  // biome-ignore lint/suspicious/noExplicitAny: TSL ComputeNode typing
  const rowPongToPingStages: any[] = []
  // biome-ignore lint/suspicious/noExplicitAny: TSL ComputeNode typing
  const colPingToPongStages: any[] = []
  // biome-ignore lint/suspicious/noExplicitAny: TSL ComputeNode typing
  const colPongToPingStages: any[] = []
  for (let s = 1; s <= logN; s++) {
    rowPingToPongStages.push(
      buildButterflyKernel({
        src: pingTexture,
        dst: pongTexture,
        N,
        axis: 'row',
        stage: s,
        batched,
      }).compute(N * N),
    )
    rowPongToPingStages.push(
      buildButterflyKernel({
        src: pongTexture,
        dst: pingTexture,
        N,
        axis: 'row',
        stage: s,
        batched,
      }).compute(N * N),
    )
    colPingToPongStages.push(
      buildButterflyKernel({
        src: pingTexture,
        dst: pongTexture,
        N,
        axis: 'col',
        stage: s,
        batched,
      }).compute(N * N),
    )
    colPongToPingStages.push(
      buildButterflyKernel({
        src: pongTexture,
        dst: pingTexture,
        N,
        axis: 'col',
        stage: s,
        batched,
      }).compute(N * N),
    )
  }

  // Final pass: copy the last stage's output to `outputTexture`.
  // Two variants because the final stage's destination depends on
  // log₂N parity.
  //
  // NO normalization (scale = 1). The "standard" IFFT convention
  // divides by N² here (matching the CPU `fft2d` with
  // direction=-1) so the inverse-of-forward round-trips
  // unit-amplitude. But this codebase's direct-DFT convention
  // (Tessendorf-style) computes `Σ_k h0(k)·e^{iφ}` WITHOUT
  // dividing by N² — see `createGpuOceanDisplacement` in
  // `gpu-bake.ts`. To match that convention exactly so the FFT
  // path can drop in as a replacement, we skip the 1/N² scaling
  // here. Consumers that DO want IFFT_std semantics can multiply
  // by 1/N² downstream.
  const scaleFromPing = buildScaleKernel({
    src: pingTexture,
    dst: outputTexture,
    N,
    scale: 1,
    batched,
  }).compute(N * N)
  const scaleFromPong = buildScaleKernel({
    src: pongTexture,
    dst: outputTexture,
    N,
    scale: 1,
    batched,
  }).compute(N * N)

  // Dispatch sequence — parity-agnostic. The data location after
  // each pass is tracked explicitly so the code works for either
  // log₂N parity (N=4, 16, 64, 128, 256, ...).
  //
  //   1. Bit-rev row: input → ping. Data in ping.
  //   2. log₂N row butterflies. After each stage, data toggles
  //      ping ↔ pong. Final location depends on log₂N parity.
  //   3. Bit-rev col: read from wherever data is, write to other.
  //   4. log₂N col butterflies. Same alternation.
  //   5. Scale: copy final ping or pong to outputTexture.

  function dispatch(renderer: THREE.WebGLRenderer): Promise<void> {
    // biome-ignore lint/suspicious/noExplicitAny: WebGPURenderer cast
    const r = renderer as any
    if (typeof r.computeAsync !== 'function') return Promise.resolve()

    // -- Bit-reversal row pass: input → ping --
    r.computeAsync(bitReverseRow)

    // -- Row butterfly stages: alternate ping/pong --
    // Start state: data in ping. Each stage flips the location.
    let dataInPing = true
    for (let s = 1; s <= logN; s++) {
      r.computeAsync(
        dataInPing ? rowPingToPongStages[s - 1] : rowPongToPingStages[s - 1],
      )
      dataInPing = !dataInPing
    }

    // -- Bit-reversal column pass: read from wherever data is. --
    if (dataInPing) {
      // Data in ping → read ping, write pong → data now in pong.
      r.computeAsync(bitReverseColFromPing)
      dataInPing = false
    } else {
      // Data in pong → read pong, write ping → data now in ping.
      r.computeAsync(bitReverseColFromPong)
      dataInPing = true
    }

    // -- Column butterfly stages: alternate. --
    for (let s = 1; s <= logN; s++) {
      r.computeAsync(
        dataInPing ? colPingToPongStages[s - 1] : colPongToPingStages[s - 1],
      )
      dataInPing = !dataInPing
    }

    // -- Scale & copy to output --
    return r.computeAsync(dataInPing ? scaleFromPing : scaleFromPong) as Promise<void>
  }

  function dispose(): void {
    inputTexture.dispose()
    pingTexture.dispose()
    pongTexture.dispose()
    outputTexture.dispose()
  }

  return { inputTexture, outputTexture, N, batched, dispatch, dispose }
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
  /** When true, copy all 4 channels (R/G = first complex, B/A =
   *  second complex). When false, only R/G are carried and B/A
   *  are zeroed at the destination. */
  batched: boolean
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
  const { src, dst, N, logN, axis, batched } = opts
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
    if (batched) {
      textureStore(
        dst,
        uvec2(px, py),
        vec4(sample.r, sample.g, sample.b, sample.a),
      ).toWriteOnly()
    } else {
      textureStore(
        dst,
        uvec2(px, py),
        vec4(sample.r, sample.g, float(0), float(0)),
      ).toWriteOnly()
    }
  })()
}

type ButterflyKernelOpts = {
  src: THREE.Texture
  dst: THREE.Texture
  N: number
  axis: 'row' | 'col'
  /** Stage index, 1..log₂N. Baked into the kernel as a
   *  compile-time constant — one kernel per stage value. */
  stage: number
  /** When true, process two complex spectra per texel — first in
   *  R/G, second in B/A. The butterfly math runs twice (once per
   *  pair) in the same kernel body so two IFFTs share the
   *  dispatch overhead. */
  batched: boolean
}

/**
 * One butterfly stage of the iterative radix-2 Cooley-Tukey
 * FFT, applied along `axis`. The `stage` (1..log₂N) is baked
 * into the kernel — m = 2^stage and halfm = m/2 are JS-time
 * constants, so the WGSL output has no shift/mod against a
 * runtime uniform.
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
  const { src, dst, N, axis, stage, batched } = opts
  // JS-time constants — bake straight into the kernel.
  const mJS = 1 << stage
  const halfmJS = mJS >> 1
  return Fn(() => {
    const px = instanceIndex.mod(N)
    const py = instanceIndex.div(N)

    const idxAxis = axis === 'row' ? px : py
    const otherAxis = axis === 'row' ? py : px

    // m, halfm baked as constants — no uniform dependency.
    const m = uint(mJS)
    const halfm = uint(halfmJS)

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

    // Channel-A complex math (R = real, G = imag):
    //   t = W * partner    (W = wr + i·wi, partner = pr + i·pi)
    //   tr = wr·pr − wi·pi
    //   ti = wr·pi + wi·pr
    const trA = wr.mul(partnerSample.r).sub(wi.mul(partnerSample.g))
    const tiA = wr.mul(partnerSample.g).add(wi.mul(partnerSample.r))
    const urA = isLowerHalf.select(selfSample.r, partnerSample.r)
    const uiA = isLowerHalf.select(selfSample.g, partnerSample.g)
    const trAUpper = wr.mul(selfSample.r).sub(wi.mul(selfSample.g))
    const tiAUpper = wr.mul(selfSample.g).add(wi.mul(selfSample.r))
    const tEffRA = isLowerHalf.select(trA, trAUpper)
    const tEffIA = isLowerHalf.select(tiA, tiAUpper)
    // Output: lower half = u + W·t, upper half = u − W·t
    const outRA = isLowerHalf.select(urA.add(tEffRA), urA.sub(tEffRA))
    const outIA = isLowerHalf.select(uiA.add(tEffIA), uiA.sub(tEffIA))

    if (batched) {
      // Channel-B complex math (B = real, A = imag). Same shape
      // as channel A, just on the .b / .a swizzles. Two complex
      // butterflies per dispatch — the texture fetches and
      // twiddle math are shared (already loaded selfSample /
      // partnerSample, wr / wi).
      const trB = wr.mul(partnerSample.b).sub(wi.mul(partnerSample.a))
      const tiB = wr.mul(partnerSample.a).add(wi.mul(partnerSample.b))
      const urB = isLowerHalf.select(selfSample.b, partnerSample.b)
      const uiB = isLowerHalf.select(selfSample.a, partnerSample.a)
      const trBUpper = wr.mul(selfSample.b).sub(wi.mul(selfSample.a))
      const tiBUpper = wr.mul(selfSample.a).add(wi.mul(selfSample.b))
      const tEffRB = isLowerHalf.select(trB, trBUpper)
      const tEffIB = isLowerHalf.select(tiB, tiBUpper)
      const outRB = isLowerHalf.select(urB.add(tEffRB), urB.sub(tEffRB))
      const outIB = isLowerHalf.select(uiB.add(tEffIB), uiB.sub(tEffIB))
      textureStore(dst, uvec2(px, py), vec4(outRA, outIA, outRB, outIB)).toWriteOnly()
    } else {
      textureStore(
        dst,
        uvec2(px, py),
        vec4(outRA, outIA, float(0), float(0)),
      ).toWriteOnly()
    }
  })()
}

type ScaleKernelOpts = {
  src: THREE.Texture
  dst: THREE.Texture
  N: number
  scale: number
  batched: boolean
}

/**
 * Final scaling pass — multiplies every texel by `scale` and
 * copies to `dst`. For an IFFT the scale is 1/N². Decoupled
 * from the butterfly kernels so we can land the output in a
 * stable texture regardless of which ping-pong the final stage
 * wrote to.
 *
 * In batched mode, both complex pairs (R/G and B/A) are scaled.
 */
function buildScaleKernel(opts: ScaleKernelOpts) {
  const { src, dst, N, scale, batched } = opts
  // `scale` is a kernel-time constant (1 for the Tessendorf
  // convention, or 1/N² for a textbook IFFT). Bake it via
  // `float()` rather than a uniform so there's no runtime
  // binding to manage.
  const scaleNode = float(scale)
  return Fn(() => {
    const px = instanceIndex.mod(N)
    const py = instanceIndex.div(N)
    // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle
    const sample = textureLoad(src, uvec2(px, py), 0) as any
    if (batched) {
      textureStore(
        dst,
        uvec2(px, py),
        vec4(
          sample.r.mul(scaleNode),
          sample.g.mul(scaleNode),
          sample.b.mul(scaleNode),
          sample.a.mul(scaleNode),
        ),
      ).toWriteOnly()
    } else {
      textureStore(
        dst,
        uvec2(px, py),
        vec4(sample.r.mul(scaleNode), sample.g.mul(scaleNode), float(0), float(0)),
      ).toWriteOnly()
    }
  })()
}
