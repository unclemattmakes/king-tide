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

// ---------------------------------------------------------------------------
// Phase A2 — Full-spectrum GPU IFFT for vertex displacement
// ---------------------------------------------------------------------------
//
// The Phase A1 GPU path drives the BIG-WAVE silhouette by uploading 32
// top-K spectrum modes (converted to Gerstner shape) into the shader as
// a uniform array and summing them analytically per vertex. That works
// but leaves real spectral content on the table: the full Phillips
// grid has ~1000 non-zero modes at N=32, and dropping all but the top
// 32 misses ~5% of the height variance.
//
// `createGpuOceanDisplacement` upgrades that to a per-frame inverse-DFT
// over the FULL spectrum, baked into two RGBA32F storage textures that
// the water vertex shader samples once per vertex:
//
//   displacementTexture (RGBA32F, REPEAT):
//     R = height (m, world-space)
//     G = Dx     (m, Tessendorf-style horizontal displacement)
//     B = Dz     (m)
//     A = J      (Jacobian, dimensionless — A3 foam consumes this)
//
//   slopeTexture (RGBA32F, REPEAT):
//     R = ∂h/∂x  (m / m, dimensionless surface slope)
//     G = ∂h/∂z
//     B = 0      (reserved)
//     A = 0      (reserved)
//
// The vertex shader trades the analytic 32-wave sum for one sample of
// each texture and gets the FULL spectrum back at the cost of two
// `textureSample` calls per vertex. The CPU buoyancy path stays on the
// top-K analytic sum (`sampleSpectrumHeightFromModes`) — agreement
// between the two is bounded by the truncation residual (~5% RMS),
// validated by the buoyancy-vs-render probe in
// `wave-field-determinism.test.ts`.
//
// Why two textures vs one fat RGBA: the natural quartet is height + Dx
// + Dz + Jacobian (per `docs/fft-ocean-plan.md`'s A2 row), but the
// vertex shader also needs ∂h/∂x and ∂h/∂z to build the surface
// normal. A second RG32F-shaped output keeps those alongside without
// pushing the Jacobian out of its planned slot.
//
// Sign convention matches `sampleSpectrumHeightFromModes` (CPU
// sampler) exactly:
//
//   φ = kx·x + kz·z + ω·t
//   height = Σ 2·Re[h0·e^{iφ}] = Σ 2·(h0r·cos(φ) − h0i·sin(φ))
//
// The Tessendorf horizontal displacement (eq. 29):
//
//   D(x, t) = Σ_k −i·k̂(k) · h0(k) · e^{iφ}
//
// Taking the real part, with k̂x = kx/|k|:
//
//   Dx = Σ 2·k̂x·(h0r·sin(φ) + h0i·cos(φ))
//
// (The −i·k̂ factor rotates the per-mode contribution by π/2 in the
// complex plane, so the height's `cos`/`sin` swap roles for Dx.)
//
// Jacobian partials — derive from differentiating Dx, Dz wrt x, z:
//
//   ∂Dx/∂x = Σ 2·(kx²/|k|)·(h0r·cos − h0i·sin)
//   ∂Dz/∂z = Σ 2·(kz²/|k|)·(h0r·cos − h0i·sin)
//   ∂Dx/∂z = Σ 2·(kx·kz/|k|)·(h0r·cos − h0i·sin)   ( = ∂Dz/∂x by symmetry )
//
// All three reduce to "(coefficient) · realPart_per_mode", so they
// share trig with the height accumulator.
//
//   J = (1 + λ·∂Dx/∂x)·(1 + λ·∂Dz/∂z) − λ²·(∂Dx/∂z)²
//
// where λ is the choppiness scale (Tessendorf's λ). J < 0 marks
// surface folding ≡ wave breaking ≡ foam (A3 consumes this).

export type GpuOceanDisplacementOpts = {
  /** Phillips spectrum parameters. Pass `field.spectrumParams` so the
   *  GPU IFFT and the CPU top-K analytic sampler read the SAME h0
   *  array — that's what bounds the buoyancy-vs-render delta. */
  phillipsParams: PhillipsParams
  /** Tessendorf choppiness λ. 0 = pure heightfield (no horizontal
   *  displacement). 1.0 = full Tessendorf choppy waves. 0.5 is a
   *  middle ground that adds visible pinching without making the
   *  buoyancy-vs-render gap grow too large. */
  choppiness?: number
  /** Visual scale applied to height, Dx, Dz, and the height slopes
   *  at kernel-write time. Jacobian is unaffected (it's a
   *  dimensionless partial-derivative product). Defaults to 1.0
   *  since `defaultSpectrumParams.amplitude` is calibrated for
   *  RMS ~0.5 m at the full-grid sum. Exposed as a tuning knob for
   *  the A5 debug menu (sea-state intensity slider) and for
   *  per-track overrides that want a different visible amplitude
   *  without touching the underlying spectrum. */
  renderScale?: number
}

export type GpuOceanDisplacementHandle = {
  /** RGBA32F storage texture: (height, Dx, Dz, Jacobian). Sampled by
   *  the water vertex shader at `worldXZ / tileSize` (REPEAT
   *  wrap). */
  displacementTexture: THREE.Texture
  /** RGBA32F storage texture: (∂h/∂x, ∂h/∂z, _, _). Drives the
   *  surface normal that the fragment lighting reads. */
  slopeTexture: THREE.Texture
  /** Tile size in meters — the world-space extent of one full
   *  texture repeat. Pre-multiplied so callers can compute the
   *  sampling UV as `worldXZ / tileSize`. */
  tileSize: number
  /** Current choppiness scale (echoes the constructor opt). Stored
   *  so a future debug-menu slider can mutate it via the uniform
   *  without rebuilding the kernel. */
  choppiness: number
  /** Visual-only render scale on (height, Dx, Dz, slope). See the
   *  opt's doc for why this exists. */
  renderScale: number
  /** Drive the spectrum forward to `time` seconds and dispatch the
   *  compute kernel. Same fire-and-forget semantics as
   *  `GpuOceanFftHandle.tick`. */
  tick(time: number, renderer: THREE.WebGLRenderer): Promise<void>
  dispose(): void
}

/**
 * Build the A2 GPU displacement pipeline. Allocates the spectrum +
 * output textures, assembles the TSL compute kernel, and returns a
 * handle the water material can sample from.
 *
 * Cost at the default N=32 (matching `defaultSpectrumParams`):
 *   - 32² output texels × 32² inner modes = 1.0M mode-evaluations per
 *     frame. Roughly 3× the analytic-vertex-sum cost of the existing
 *     A1b path; still <0.2 ms on any real GPU.
 *
 * If `phillipsParams.N` is bumped to 64 the cost scales to N⁴ = 16.8M
 * — same envelope as the detail-cascade kernel, so still well under
 * 1 ms.
 */
export function createGpuOceanDisplacement(
  opts: GpuOceanDisplacementOpts,
): GpuOceanDisplacementHandle {
  const phillipsParams = opts.phillipsParams
  const N = phillipsParams.N
  const tileSize = phillipsParams.tileSize
  const choppiness = opts.choppiness ?? 0.5
  const renderScale = opts.renderScale ?? 1

  // 1) Phillips spectrum on CPU — same call as `createSpectrumWaveField`
  //    uses. Both consumers read the same params so they get the same
  //    h0 array (mulberry32 PRNG seeded identically).
  const spectrum = buildPhillipsSpectrum(phillipsParams)

  // 2) Pack h0 + ω into the spectrum DataTexture (RGBA32F). Same
  //    layout as the detail-cascade kernel uses.
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
  spectrumTex.name = 'water:ocean-displacement:spectrum'
  spectrumTex.magFilter = THREE.NearestFilter
  spectrumTex.minFilter = THREE.NearestFilter
  spectrumTex.wrapS = THREE.ClampToEdgeWrapping
  spectrumTex.wrapT = THREE.ClampToEdgeWrapping
  spectrumTex.generateMipmaps = false
  spectrumTex.needsUpdate = true

  // 3) Output textures: RGBA32F storage. REPEAT wrapping is what makes
  //    `texture(displacementTex, worldXZ / tileSize)` tile seamlessly
  //    across the visible mesh. LinearFilter requires the WebGPU
  //    `float32-filterable` feature; on browsers without it the
  //    texture binding will fall back to UnfilterableFloat / nearest,
  //    which produces visible blocks at high mesh resolution but does
  //    NOT crash. We can move to manual bilinear in the shader if
  //    needed once a no-feature-flag browser shows up in telemetry.
  const displacementTexture = new StorageTexture(N, N)
  displacementTexture.name = 'water:ocean-displacement:rgba'
  displacementTexture.format = THREE.RGBAFormat
  displacementTexture.type = THREE.FloatType
  displacementTexture.magFilter = THREE.LinearFilter
  displacementTexture.minFilter = THREE.LinearFilter
  displacementTexture.wrapS = THREE.RepeatWrapping
  displacementTexture.wrapT = THREE.RepeatWrapping
  displacementTexture.generateMipmaps = false

  const slopeTexture = new StorageTexture(N, N)
  slopeTexture.name = 'water:ocean-displacement:slope'
  slopeTexture.format = THREE.RGBAFormat
  slopeTexture.type = THREE.FloatType
  slopeTexture.magFilter = THREE.LinearFilter
  slopeTexture.minFilter = THREE.LinearFilter
  slopeTexture.wrapS = THREE.RepeatWrapping
  slopeTexture.wrapT = THREE.RepeatWrapping
  slopeTexture.generateMipmaps = false

  // 4) Uniforms.
  const timeUniform = uniform(0)
  const choppinessUniform = uniform(choppiness)
  const renderScaleUniform = uniform(renderScale)
  // Physical-units conversion factor for slopes / partials: the
  // accumulators use UV-space wavenumbers (cycles per tile, integer),
  // so we multiply through by (2π / tileSize) at the end to get rad/m.
  // The slope formula picks up an extra 2 from the conjugate-pair
  // symmetry, so the constant out front is (4π / tileSize).
  const physicalScaleUniform = uniform((4 * Math.PI) / tileSize)

  const halfN = N / 2
  const twoPi = float(2 * Math.PI)

  // 5) Compute kernel. Same per-thread / per-texel structure as the
  //    detail kernel; each iteration accumulates more quantities into
  //    parallel vars.
  const kernel = Fn(
    ({
      specTex,
      dispTex,
      slpTex,
    }: {
      specTex: THREE.DataTexture
      dispTex: StorageTexture
      slpTex: StorageTexture
    }) => {
      const px = instanceIndex.mod(N)
      const py = instanceIndex.div(N)
      const u = float(px).div(N)
      const v = float(py).div(N)

      // 7 accumulators: height, Dx, Dz (displacement triple),
      // dydx, dydz (height slopes for normal), and Dxx, Dxz, Dzz for
      // the Jacobian (with Dxz = Dzx). Naming maps to the per-mode
      // derivations above the function definition.
      const height = float(0).toVar()
      const dx = float(0).toVar()
      const dz = float(0).toVar()
      const dydx = float(0).toVar()
      const dydz = float(0).toVar()
      const dxxRaw = float(0).toVar()
      const dxzRaw = float(0).toVar()
      const dzzRaw = float(0).toVar()

      Loop(N, ({ i: zi }) => {
        Loop(N, ({ i: xi }) => {
          // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
          const sample = textureLoad(specTex, uvec2(uint(xi), uint(zi)), 0) as any
          const h0r = sample.r
          const h0i = sample.g
          const omega = sample.b

          const kxic = float(xi).sub(float(halfN))
          const kzic = float(zi).sub(float(halfN))
          // |k_int| in UV-cycle units. The 1e-6 floor protects the
          // DC bin (kxic = kzic = 0) where h0 should be zero anyway
          // — Phillips factor zeroes it — but a safety margin keeps
          // the division well-defined.
          const kMag2 = kxic.mul(kxic).add(kzic.mul(kzic))
          const kMag = kMag2.sqrt().max(float(1e-6))
          const invKMag = float(1).div(kMag)
          const khatX = kxic.mul(invKMag)
          const khatZ = kzic.mul(invKMag)

          const phase = twoPi
            .mul(kxic.mul(u).add(kzic.mul(v)))
            .add(omega.mul(timeUniform))
          const c = cos(phase)
          const s = sin(phase)

          // Per-mode complex amplitude components:
          //   realPart = h0r·cos(φ) − h0i·sin(φ)
          //   imagPart = h0r·sin(φ) + h0i·cos(φ)
          const realPart = h0r.mul(c).sub(h0i.mul(s))
          const imagPart = h0r.mul(s).add(h0i.mul(c))

          // Height — factor of 2 for the conjugate-pair symmetry of a
          // real heightfield. Matches `sampleSpectrumHeightFromModes`
          // bit-for-bit (the CPU sampler bakes the same factor of 2
          // into `aRe`/`aIm`).
          const twoReal = realPart.mul(float(2))
          const twoImag = imagPart.mul(float(2))
          height.addAssign(twoReal)

          // Tessendorf horizontal displacement.
          //   Dx = Σ 2·k̂x·imagPart   (k̂ in UV-space cycles is
          //                          unitless — same as physical k̂)
          dx.addAssign(khatX.mul(twoImag))
          dz.addAssign(khatZ.mul(twoImag))

          // Height slopes — for the surface normal. UV-space slopes;
          // the (4π / tileSize) prefactor at the end converts to
          // physical units. dh/du = −2π·kxic·(h0r·sin + h0i·cos);
          // pull out the −2 here and the 2π/tileSize outside.
          dydx.addAssign(kxic.mul(imagPart).negate())
          dydz.addAssign(kzic.mul(imagPart).negate())

          // Jacobian partials. ∂Dx/∂x = Σ 2·(kx²/|k|)·realPart, etc.
          // Same trick: accumulate the (kxic²/|kMagInt|)·realPart
          // sums in UV-cycle units, multiply by (4π/tileSize) at
          // the end. ∂Dx/∂z = ∂Dz/∂x by symmetry so we keep one.
          const kxxOverK = kxic.mul(khatX) // = kxic² / |k_int|
          const kzzOverK = kzic.mul(khatZ)
          const kxzOverK = kxic.mul(khatZ) // = kxic·kzic / |k_int|
          dxxRaw.addAssign(kxxOverK.mul(realPart))
          dzzRaw.addAssign(kzzOverK.mul(realPart))
          dxzRaw.addAssign(kxzOverK.mul(realPart))
        })
      })

      // Convert UV-cycle slopes / partials into physical units. The
      // (4π / tileSize) carries the (2π / tileSize) wavenumber
      // conversion and the factor of 2 from the conjugate-pair sum.
      const slopeDx = dydx.mul(physicalScaleUniform)
      const slopeDz = dydz.mul(physicalScaleUniform)
      const dxx = dxxRaw.mul(physicalScaleUniform)
      const dzz = dzzRaw.mul(physicalScaleUniform)
      const dxz = dxzRaw.mul(physicalScaleUniform)

      // Jacobian: (1 + λ·Dxx)·(1 + λ·Dzz) − λ²·Dxz²
      //   < 0  ⇒ surface folds ⇒ foam (A3 reads this).
      //   > 0, near 1 ⇒ calm surface.
      const lambda = choppinessUniform
      const jacobian = float(1)
        .add(lambda.mul(dxx))
        .mul(float(1).add(lambda.mul(dzz)))
        .sub(lambda.mul(lambda).mul(dxz).mul(dxz))

      // Apply choppiness to the horizontal displacement at write
      // time so the vertex shader reads the FINAL displacement
      // without needing to know λ. Matches the convention used by
      // the Jacobian: both treat λ·D as the effective displacement.
      // `renderScaleUniform` is the visual divisor applied here
      // (and to height + slopes); the Jacobian is left at raw
      // (dimensionless) scale since it's a pure folding signal.
      const dxScaled = dx.mul(lambda).mul(renderScaleUniform)
      const dzScaled = dz.mul(lambda).mul(renderScaleUniform)
      const heightScaled = height.mul(renderScaleUniform)
      const slopeDxScaled = slopeDx.mul(renderScaleUniform)
      const slopeDzScaled = slopeDz.mul(renderScaleUniform)

      textureStore(
        dispTex,
        uvec2(px, py),
        vec4(heightScaled, dxScaled, dzScaled, jacobian),
      ).toWriteOnly()
      textureStore(
        slpTex,
        uvec2(px, py),
        vec4(slopeDxScaled, slopeDzScaled, float(0), float(0)),
      ).toWriteOnly()
    },
  )

  const computeNode = kernel({
    specTex: spectrumTex,
    dispTex: displacementTexture,
    slpTex: slopeTexture,
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
    displacementTexture.dispose()
    slopeTexture.dispose()
  }

  return {
    displacementTexture,
    slopeTexture,
    tileSize,
    choppiness,
    renderScale,
    tick,
    dispose,
  }
}
