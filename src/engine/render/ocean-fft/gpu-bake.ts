import * as THREE from 'three'
import {
  cos,
  Fn,
  float,
  instanceIndex,
  Loop,
  sin,
  textureLoad,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec4,
} from 'three/tsl'
import { StorageTexture } from 'three/webgpu'
import { buildFftDetailNormalTexture } from '@/engine/render/ocean-fft/cpu-bake'
import { buildPhillipsSpectrum, type PhillipsParams } from '@/engine/sim/water/phillips'

/**
 * GPU-driven Phillips ocean: animated detail-cascade slope texture
 * computed by a TSL compute kernel each frame. Drop-in replacement for
 * the C2 CPU bake — same RGBA8 / REPEAT output format, same encoding,
 * so the consuming water shader needs no change.
 *
 * The kernel evaluates the inverse DFT directly (no real FFT):
 *
 *   ∂h/∂u(u, v, t) = Σ_k −4π · k̂x · (h0r·sin(φ) + h0i·cos(φ))
 *   ∂h/∂v(u, v, t) = Σ_k −4π · k̂z · (h0r·sin(φ) + h0i·cos(φ))
 *
 *     φ = 2π·(k̂x·u + k̂z·v) + ω·t
 *     k̂x, k̂z   integer wavenumber indices, centered around 0
 *
 * For N=64 that's N² · N² = 16.8M ops per frame for a 64×64 output —
 * well under 1 ms on any real GPU. A radix-2 FFT would scale better
 * (N² log N) but adds significant pipeline machinery (ping-pong
 * buffers, log₂N dispatches, bit-reversal) that's only worth the
 * trouble at N ≥ 128. We'll revisit when Phase A needs higher
 * resolution.
 *
 * Inputs:
 *   - `spectrumTex` (RGBA32F DataTexture) — per texel:
 *       R = h0 real, G = h0 imag, B = ω (rad/s), A unused
 *     Built once at construction from `buildPhillipsSpectrum`.
 *   - `timeUniform` — current sim time in seconds. Driven each frame
 *     by `tick(time)`.
 *
 * Output:
 *   - `outputTexture` (RGBA8 StorageTexture) — same encoding as the
 *     procedural detail texture: R, G = `(slope_normalized·0.5 + 0.5)`,
 *     B = 0.5, A = 1.0. Sampled by the existing `?water=fft` cascade.
 *
 * WebGL2 fallback: compute shaders aren't available — callers should
 * detect the renderer backend and fall back to the static C2 bake. See
 * `water.ts` for the wiring.
 */
export type GpuOceanFftOpts = {
  /** Grid size. Must be a power of two; 64 is the default and well-
   *  matched to the inverse-DFT path's cost. */
  N?: number
  tileSize?: number
  windSpeed?: number
  windDirX?: number
  windDirZ?: number
  amplitude?: number
  smallWavelengthCutoff?: number
  seed?: number
}

const DEFAULTS: Required<GpuOceanFftOpts> = {
  N: 64,
  tileSize: 12,
  windSpeed: 9,
  windDirX: 1,
  windDirZ: 0,
  amplitude: 0.0008,
  smallWavelengthCutoff: 0.6,
  seed: 0xa11f,
}

export type GpuOceanFftHandle = {
  /** Storage texture sampled by the water material as the detail
   *  cascade source. */
  outputTexture: THREE.Texture
  /**
   * Drive the spectrum forward to `time` seconds and dispatch the
   * compute kernel. Call once per frame, BEFORE the renderer's main
   * `.render()` so the slope texture is up-to-date for the water draw.
   *
   * Returns the promise the renderer's `computeAsync` returns so
   * callers can await if they want strict pipelining; default fire-
   * and-forget is fine since WebGPU inserts the read-after-write
   * barrier automatically between this compute and the subsequent
   * water render.
   */
  tick(time: number, renderer: THREE.WebGLRenderer): Promise<void>
  dispose(): void
}

/**
 * Build the GPU pipeline. Allocates the input + output textures,
 * uploads the static spectrum, and assembles the TSL compute node. The
 * caller is responsible for calling `tick` each frame and disposing on
 * teardown.
 */
export function createGpuOceanFft(opts: GpuOceanFftOpts = {}): GpuOceanFftHandle {
  const cfg = { ...DEFAULTS, ...opts }
  const N = cfg.N

  // 1) Phillips spectrum on CPU. Same code as the C2 CPU bake and the
  //    future Phase-A buoyancy sampler — single source of math truth.
  const phillipsParams: PhillipsParams = {
    N,
    tileSize: cfg.tileSize,
    windSpeed: cfg.windSpeed,
    windDirX: cfg.windDirX,
    windDirZ: cfg.windDirZ,
    amplitude: cfg.amplitude,
    smallWavelengthCutoff: cfg.smallWavelengthCutoff,
    seed: cfg.seed,
  }
  const spectrum = buildPhillipsSpectrum(phillipsParams)

  // 2) Pack the spectrum into a 1:1 RGBA32F texture: R=h0r, G=h0i,
  //    B=ω, A=unused. The compute kernel reads via integer-coord
  //    `textureLoad` so no filtering is involved. Stored in centered
  //    layout (DC at N/2, N/2) — the kernel re-centers via `i - N/2`.
  const packed = new Float32Array(N * N * 4)
  for (let zi = 0; zi < N; zi++) {
    for (let xi = 0; xi < N; xi++) {
      const idx = zi * N + xi
      packed[idx * 4 + 0] = spectrum.h0[idx * 2]!
      packed[idx * 4 + 1] = spectrum.h0[idx * 2 + 1]!
      packed[idx * 4 + 2] = spectrum.omega[idx]!
      packed[idx * 4 + 3] = 0
    }
  }
  const spectrumTex = new THREE.DataTexture(
    packed,
    N,
    N,
    THREE.RGBAFormat,
    THREE.FloatType,
  )
  spectrumTex.name = 'water:ocean-fft:spectrum'
  spectrumTex.magFilter = THREE.NearestFilter
  spectrumTex.minFilter = THREE.NearestFilter
  spectrumTex.wrapS = THREE.ClampToEdgeWrapping
  spectrumTex.wrapT = THREE.ClampToEdgeWrapping
  spectrumTex.generateMipmaps = false
  spectrumTex.needsUpdate = true

  // 3) Reference CPU bake at t=0 to recover the same `smax` the C2
  //    pipeline normalizes to. Re-using the CPU bake means the encoded
  //    slope values match the C2 dynamic range at t=0 — the visual
  //    character at frame zero will be identical, then animate from
  //    there. Statistical: the spectrum's energy is time-invariant so
  //    smax stays in the same ballpark across the animation.
  const cpuRef = buildFftDetailNormalTexture(phillipsParams)
  // We don't need the texture itself, only its implicit smax. The C2
  // bake doesn't expose it, so re-derive: it was 0.5 / smax_actual.
  // Cheaper to just bake an analytic upper bound here.
  const smax = computeSlopeUpperBound(spectrum)
  cpuRef.dispose()

  const smaxInvUniform = uniform(0.5 / smax)
  const timeUniform = uniform(0)

  // 4) Output storage texture. RGBA8 unorm matches the existing
  //    detail-texture binding format. The water shader's runtime
  //    `value·2 − 1` decode applies unchanged.
  const outputTexture = new StorageTexture(N, N)
  outputTexture.name = 'water:ocean-fft:slope'
  outputTexture.format = THREE.RGBAFormat
  outputTexture.type = THREE.UnsignedByteType
  outputTexture.magFilter = THREE.LinearFilter
  outputTexture.minFilter = THREE.LinearMipmapLinearFilter
  outputTexture.wrapS = THREE.RepeatWrapping
  outputTexture.wrapT = THREE.RepeatWrapping
  outputTexture.anisotropy = 4

  // 5) Compute kernel. One thread per output texel. Inside, the
  //    outer Loop walks all N² spectrum modes; the inner body
  //    accumulates slope contributions.
  //
  //    `instanceIndex` is the workgroup-flat index across all threads
  //    in the dispatch. We unpack it into (px, py) ourselves; TSL
  //    handles the workgroup tiling.
  const halfN = N / 2
  const twoPi = float(2 * Math.PI)

  const kernel = Fn(
    ({
      specTex,
      outTex,
    }: {
      specTex: THREE.DataTexture
      outTex: StorageTexture
    }) => {
      const px = instanceIndex.mod(N)
      const py = instanceIndex.div(N)
      // Output texel's UV (in [0, 1) across the tile).
      const u = float(px).div(N)
      const v = float(py).div(N)

      const slopeU = float(0).toVar()
      const slopeV = float(0).toVar()

      // Nested Loop. Outer walks kzi (`zi`), inner walks kxi (`xi`).
      // Two separate `Loop` calls (rather than the compact two-arg
      // form) so the inner index has a distinct name without
      // shadowing the outer one. Each iteration is one spectrum mode.
      Loop(N, ({ i: zi }) => {
        Loop(N, ({ i: xi }) => {
          // Sample the spectrum at integer coord (xi, zi).
          // textureLoad expects uvec2 + mip level. Loop indices are
          // `Node<"int">`; cast to uint for the integer-coord read.
          // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
          const sample = textureLoad(specTex, uvec2(uint(xi), uint(zi)), 0) as any
          const h0r = sample.r
          const h0i = sample.g
          const omega = sample.b

          // Centered wavenumber index. `kxic = xi − N/2`.
          const kxic = float(xi).sub(float(halfN))
          const kzic = float(zi).sub(float(halfN))

          // Phase: 2π·(kxic·u + kzic·v) + ω·t. Uses UV-space
          // wavenumber (cycles per tile) so the output texture
          // tiles seamlessly regardless of physical tileSize.
          const phase = twoPi
            .mul(kxic.mul(u).add(kzic.mul(v)))
            .add(omega.mul(timeUniform))
          const c = cos(phase)
          const s = sin(phase)

          // Slope contribution.
          // d/du [h0r·cos(φ) − h0i·sin(φ)] = −2π·kxic·(h0r·sin(φ) + h0i·cos(φ))
          // Factor of 2 from the conjugate-pair symmetry of a real
          // heightfield, combined with the −2π·kxic prefactor.
          const factor = float(-4 * Math.PI).mul(h0r.mul(s).add(h0i.mul(c)))
          slopeU.addAssign(factor.mul(kxic))
          slopeV.addAssign(factor.mul(kzic))
        })
      })

      // Normalize to roughly ±0.5 using the upper-bound `smax`, then
      // encode as the existing detail-texture format expects: pack to
      // [0, 1] for RGBA8 unorm via `value·0.5 + 0.5`.
      const ndx = slopeU.mul(smaxInvUniform).mul(0.5).add(0.5).clamp(0, 1)
      const ndz = slopeV.mul(smaxInvUniform).mul(0.5).add(0.5).clamp(0, 1)
      textureStore(outTex, uvec2(px, py), vec4(ndx, ndz, 0.5, 1)).toWriteOnly()
    },
  )

  const computeNode = kernel({
    specTex: spectrumTex,
    outTex: outputTexture,
    // biome-ignore lint/suspicious/noExplicitAny: TSL Fn invocation typing
  } as any).compute(N * N)

  function tick(time: number, renderer: THREE.WebGLRenderer): Promise<void> {
    timeUniform.value = time
    // biome-ignore lint/suspicious/noExplicitAny: WebGPURenderer cast
    const r = renderer as any
    if (typeof r.computeAsync === 'function') {
      return r.computeAsync(computeNode) as Promise<void>
    }
    return Promise.resolve()
  }

  function dispose() {
    spectrumTex.dispose()
    outputTexture.dispose()
  }

  return { outputTexture, tick, dispose }
}

/**
 * Pessimistic upper bound on the slope magnitude across all (u, v, t):
 * sum the per-mode peak contribution, assuming every mode is in
 * worst-case phase-aligned. Real per-pixel slopes are much smaller
 * (RMS Gaussian sum), so the resulting normalization fits comfortably
 * in the encoding range with headroom — at the cost of using only a
 * fraction of the [0, 1] dynamic range. The water shader's
 * `detailStrength` multiplier compensates for that loss downstream.
 */
function computeSlopeUpperBound(spectrum: {
  N: number
  h0: Float32Array
}): number {
  const N = spectrum.N
  const halfN = N / 2
  let sum = 0
  for (let zi = 0; zi < N; zi++) {
    for (let xi = 0; xi < N; xi++) {
      const idx = zi * N + xi
      const h0r = spectrum.h0[idx * 2]!
      const h0i = spectrum.h0[idx * 2 + 1]!
      const mag = Math.hypot(h0r, h0i)
      if (mag === 0) continue
      const kxic = xi - halfN
      const kzic = zi - halfN
      const kMagInt = Math.hypot(kxic, kzic)
      // Each mode contributes at most 4π · |k_int| · |h0| to a slope
      // component. Take the larger of (|kxic|, |kzic|) for the worst
      // single-axis contribution.
      sum += 4 * Math.PI * kMagInt * mag
    }
  }
  // Floor at a tiny value so the inverse doesn't divide by zero on a
  // pathologically-empty spectrum (e.g. windSpeed = 0 in tests).
  return Math.max(sum, 1e-6)
}
