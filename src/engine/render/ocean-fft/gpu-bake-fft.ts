import * as THREE from 'three'
import {
  cos,
  Fn,
  float,
  instanceIndex,
  select,
  sin,
  textureLoad,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec4,
} from 'three/tsl'
import { StorageTexture } from 'three/webgpu'
import { createFft2d, type Fft2dHandle } from '@/engine/render/ocean-fft/fft-tsl'
import type {
  GpuOceanDisplacementHandle,
  GpuOceanDisplacementOpts,
} from '@/engine/render/ocean-fft/gpu-bake'
import {
  buildPhillipsSpectrum,
  type PhillipsParams,
  type SpectrumGrid,
} from '@/engine/sim/water/phillips'

/**
 * A9 — Real radix-2 FFT IDFT path for the FFT-ocean displacement
 * kernel. Drop-in replacement for `createGpuOceanDisplacement` (the
 * direct-DFT path); same handle shape, so swapping is a one-line
 * change in `water.ts`.
 *
 * **STATUS — WIP, visual-parity bug open**: the pipeline runs
 * cleanly (no console errors, no GPU validation warnings, kernel
 * builds succeed) but at the time of this commit the output
 * waveform amplitude is visibly smaller than the direct-DFT path
 * at the same Phillips parameters. Expected output is identical
 * waves; observed output reads as lower-amplitude waves of
 * roughly the same character. The math walked through below
 * looks correct; the bug is likely either (a) a missing factor
 * somewhere in the spectrum-build modulation, (b) a sign/index
 * mistake in the bit-reverse or butterfly kernels of the
 * underlying `createFft2d` primitive, or (c) a Phillips-spectrum
 * scaling difference between N=32 (direct DFT default) and N=64
 * (FFT-path minimum, log₂N-even constraint) that wasn't
 * compensated for.
 *
 * Wire and verify by:
 *
 *   1. `?fftbake=ddft` (default) vs `?fftbake=fft` on the same
 *      camera position — waves should look IDENTICAL when the bug
 *      is fixed.
 *   2. Reduce N from 64 → 4 in the FFT path and compare against
 *      direct DFT at N=4 (need to relax the log₂N-even constraint
 *      first for direct comparison at N=8, 32).
 *   3. Read-back the FFT output texture via WebGPU buffer copy
 *      and compare to the CPU reference in
 *      `src/engine/sim/water/fft2d-cpu.ts` element-by-element.
 *
 * Architecture:
 *
 *   1. Spectrum-build compute kernel (1 dispatch): reads h0 from
 *      the Phillips DataTexture, applies the time-evolution
 *      `exp(i·ω·t)`, and writes 8 quantity-specific modulated
 *      spectra. With `batched: true` on the underlying FFT2D,
 *      the 8 quantities are PACKED into 4 input textures (R/G =
 *      first quantity's complex, B/A = second). The ifftshift to
 *      natural-order layout happens here (read h0 at centered
 *      index `(px + N/2) mod N` while iterating natural output
 *      texels `px`).
 *
 *   2. 4 independent batched 2D IFFTs (via `createFft2d`): each
 *      runs IFFT on the R/G pair AND the B/A pair in the same
 *      kernel body, halving the dispatch count. Each is N²·log₂N
 *      work — for N=128 that's ~115k mode-ops per IFFT × 4 =
 *      460k ops per cascade, vs the direct DFT's N⁴ = 268M ops
 *      (580× speedup on the spectral work). Dispatch overhead is
 *      the new bottleneck: 17 dispatches per IFFT (N=128) × 4 =
 *      68 dispatches per cascade per frame; at ~10 μs each that's
 *      ~0.7 ms of submission cost.
 *
 *   3. Unpack compute kernel (1 dispatch): reads the 4 batched
 *      IFFT output textures, takes the real part of each
 *      complex pair (the imaginary parts are zero up to FP
 *      rounding because the inputs sum to a real signal in
 *      spatial domain), applies the conjugate-pair ×2 factor
 *      where appropriate, computes the Jacobian, and writes
 *      `displacementTexture` (height, λ·Dx, λ·Dz, J) and
 *      `slopeTexture` (∂h/∂x, ∂h/∂z, _, _) — same layout the
 *      direct-DFT path produces, so the vertex shader is
 *      indifferent to which path filled them.
 *
 *      The 8-to-4 pairing:
 *        FFT 0:  R/G = height,  B/A = Dx
 *        FFT 1:  R/G = Dz,      B/A = dydx
 *        FFT 2:  R/G = dydz,    B/A = dxx
 *        FFT 3:  R/G = dxz,     B/A = dzz
 *
 * Math:
 *
 *   Each of the 8 output quantities can be expressed as
 *   `α · Re[IFFT(F)(u, v)]` for some pre-modulated spectrum `F(k)`:
 *
 *     height: α=2, F=H
 *     Dx:     α=2, F=−i·k̂x·H
 *     Dz:     α=2, F=−i·k̂z·H
 *     dydx:   α=4π/tileSize, F=i·kx_int·H
 *     dydz:   α=4π/tileSize, F=i·kz_int·H
 *     dxx:    α=4π/tileSize, F=(kx²/|k|)·H
 *     dxz:    α=4π/tileSize, F=(kx·kz/|k|)·H
 *     dzz:    α=4π/tileSize, F=(kz²/|k|)·H
 *
 *   Where `H(k, t) = h0(k)·e^{i·ω(k)·t}` is the time-evolved
 *   spectrum. The 4π/tileSize prefactor on the slopes/partials
 *   carries (2π/tileSize) for the wavenumber→rad/m conversion
 *   plus the conjugate-pair ×2.
 */
export function createGpuOceanFftDisplacement(
  opts: GpuOceanDisplacementOpts,
): GpuOceanDisplacementHandle {
  const phillipsParams = opts.phillipsParams
  const N = phillipsParams.N
  const tileSize = phillipsParams.tileSize
  const choppiness = opts.choppiness ?? 0.7
  const renderScale = opts.renderScale ?? 1

  if (!Number.isInteger(Math.log2(N)) || N < 4) {
    throw new Error(`createGpuOceanFftDisplacement: N=${N} must be a power of two ≥ 4`)
  }

  // 1) Phillips spectrum on CPU. Same call as the direct-DFT
  //    factory uses; both consumers read the same h0 array
  //    (mulberry32 PRNG seeded identically).
  const spectrum = buildPhillipsSpectrum(phillipsParams)

  // 2) Pack h0 + ω into a DataTexture (RGBA32F). Same layout as
  //    the direct-DFT spectrumTex so we can share the upload
  //    path with `uploadSpectrum`.
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
  spectrumTex.name = 'water:ocean-fft-displacement:spectrum'
  spectrumTex.magFilter = THREE.NearestFilter
  spectrumTex.minFilter = THREE.NearestFilter
  spectrumTex.wrapS = THREE.ClampToEdgeWrapping
  spectrumTex.wrapT = THREE.ClampToEdgeWrapping
  spectrumTex.generateMipmaps = false
  spectrumTex.needsUpdate = true

  // 3) Caller-facing output textures (same shape as direct DFT).
  const displacementTexture = new StorageTexture(N, N)
  displacementTexture.name = 'water:ocean-fft-displacement:rgba'
  displacementTexture.format = THREE.RGBAFormat
  displacementTexture.type = THREE.FloatType
  displacementTexture.magFilter = THREE.LinearFilter
  displacementTexture.minFilter = THREE.LinearFilter
  displacementTexture.wrapS = THREE.RepeatWrapping
  displacementTexture.wrapT = THREE.RepeatWrapping
  displacementTexture.generateMipmaps = false

  const slopeTexture = new StorageTexture(N, N)
  slopeTexture.name = 'water:ocean-fft-displacement:slope'
  slopeTexture.format = THREE.RGBAFormat
  slopeTexture.type = THREE.FloatType
  slopeTexture.magFilter = THREE.LinearFilter
  slopeTexture.minFilter = THREE.LinearFilter
  slopeTexture.wrapS = THREE.RepeatWrapping
  slopeTexture.wrapT = THREE.RepeatWrapping
  slopeTexture.generateMipmaps = false

  // 4) Four batched FFT2D handles — each runs an IFFT on the
  //    R/G complex pair AND the B/A complex pair in the same
  //    kernel body. The 8 output quantities are packed into 4
  //    pairs (see the header comment for the pairing).
  //
  //    Each FFT is log₂N × 2 axes × 2 ping/pong directions =
  //    4·log₂N butterfly kernels + 3 bit-reverse + 2 scale.
  //    For N=128 (log₂N=7) that's 28 + 5 = 33 compiled kernels
  //    per handle, and 17 dispatches per IFFT invocation (1
  //    bitrev row + 7 row butterflies + 1 bitrev col + 7 col
  //    butterflies + 1 scale).
  const heightDxFft = createFft2d({ N, batched: true })
  const dzDydxFft = createFft2d({ N, batched: true })
  const dydzDxxFft = createFft2d({ N, batched: true })
  const dxzDzzFft = createFft2d({ N, batched: true })
  const fftHandles: Fft2dHandle[] = [heightDxFft, dzDydxFft, dydzDxxFft, dxzDzzFft]

  // 5) Uniforms.
  const timeUniform = uniform(0)
  const choppinessUniform = uniform(choppiness)
  const renderScaleUniform = uniform(renderScale)
  const physicalScaleUniform = uniform((4 * Math.PI) / tileSize)

  const halfN = N / 2

  // 6) Spectrum-build kernel — 1 dispatch writes 4 batched FFT
  //    input textures (each carries 2 quantity spectra packed
  //    into R/G + B/A channels).
  //
  // Per output texel (px, py), read h0 at centered index `(px+N/2)
  // mod N` (ifftshift), apply time-evolution, and write 8
  // quantity-specific modulated spectra packed 2-per-texture.
  // The kernel implicitly does the ifftshift by reading from the
  // shifted h0 index; the signed wavenumber `kxic` used in the
  // modulation matches the direct-DFT's centered convention.
  const spectrumBuildKernel = Fn(() => {
    const px = instanceIndex.mod(N)
    const py = instanceIndex.div(N)

    // ifftshift: natural-order output (px, py) ↔ centered-order h0
    // at `(px + N/2) mod N`. uint mod uint cycles cleanly.
    const hx = uint(px.add(uint(halfN)).mod(uint(N)))
    const hy = uint(py.add(uint(halfN)).mod(uint(N)))
    // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
    const h0Sample = textureLoad(spectrumTex, uvec2(hx, hy), 0) as any
    const h0r = h0Sample.r
    const h0i = h0Sample.g
    const omega = h0Sample.b

    // Time-evolve: H = h0 · e^{i·ω·t}
    //   Hr = h0r·cos(ωt) − h0i·sin(ωt)
    //   Hi = h0r·sin(ωt) + h0i·cos(ωt)
    const phase = omega.mul(timeUniform)
    const ct = cos(phase)
    const st = sin(phase)
    const Hr = h0r.mul(ct).sub(h0i.mul(st))
    const Hi = h0r.mul(st).add(h0i.mul(ct))

    // Signed wavenumbers — natural index k_nat ∈ [0, N) maps to
    // centered wavenumber kxic where:
    //   k_nat < N/2 → kxic = k_nat (positive)
    //   k_nat ≥ N/2 → kxic = k_nat − N (negative)
    // This matches the direct DFT's `kxic = xi - N/2` where xi is
    // the centered index, since we read h0 from `(px + N/2) mod N`.
    const pxF = float(px)
    const pyF = float(py)
    // `select(...)` widens to Node<vec3> in TS — cast through any
    // so downstream float math (mul, sub, etc.) doesn't get
    // poisoned by the vec3 typing.
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const kxic: any = select(px.lessThan(uint(halfN)), pxF, pxF.sub(float(N)))
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const kzic: any = select(py.lessThan(uint(halfN)), pyF, pyF.sub(float(N)))

    // |k_int| with floor (protect DC bin).
    const kMag2 = kxic.mul(kxic).add(kzic.mul(kzic))
    const kMag = kMag2.sqrt().max(float(1e-6))
    const invKMag = float(1).div(kMag)
    const khatX = kxic.mul(invKMag)
    const khatZ = kzic.mul(invKMag)
    const kxxOverK = kxic.mul(khatX) // = kxic² / |k|
    const kzzOverK = kzic.mul(khatZ)
    const kxzOverK = kxic.mul(khatZ)

    // Per-quantity complex spectra (each a (re, im) pair):
    //   F_height = H                                       → (Hr, Hi)
    //   F_Dx     = −i·k̂x·H = k̂x·Hi − i·k̂x·Hr             → (k̂x·Hi, −k̂x·Hr)
    //   F_Dz     similarly                                 → (k̂z·Hi, −k̂z·Hr)
    //   F_dydx   = i·kxic·H = −kxic·Hi + i·kxic·Hr        → (−kxic·Hi, kxic·Hr)
    //   F_dydz   similarly                                 → (−kzic·Hi, kzic·Hr)
    //   F_dxx    = (kxic²/|k|)·H                          → ((kxic²/|k|)·Hr, (kxic²/|k|)·Hi)
    //   F_dxz    = (kxic·kzic/|k|)·H                      → ((kxic·kzic/|k|)·Hr, (kxic·kzic/|k|)·Hi)
    //   F_dzz    = (kzic²/|k|)·H                          → ((kzic²/|k|)·Hr, (kzic²/|k|)·Hi)
    //
    // Packed 2-per-texel (R/G = first quantity, B/A = second):
    //   FFT 0:  R/G = height,  B/A = Dx
    //   FFT 1:  R/G = Dz,      B/A = dydx
    //   FFT 2:  R/G = dydz,    B/A = dxx
    //   FFT 3:  R/G = dxz,     B/A = dzz
    textureStore(
      heightDxFft.inputTexture,
      uvec2(px, py),
      vec4(Hr, Hi, khatX.mul(Hi), khatX.mul(Hr).negate()),
    ).toWriteOnly()
    textureStore(
      dzDydxFft.inputTexture,
      uvec2(px, py),
      vec4(khatZ.mul(Hi), khatZ.mul(Hr).negate(), kxic.mul(Hi).negate(), kxic.mul(Hr)),
    ).toWriteOnly()
    textureStore(
      dydzDxxFft.inputTexture,
      uvec2(px, py),
      vec4(kzic.mul(Hi).negate(), kzic.mul(Hr), kxxOverK.mul(Hr), kxxOverK.mul(Hi)),
    ).toWriteOnly()
    textureStore(
      dxzDzzFft.inputTexture,
      uvec2(px, py),
      vec4(kxzOverK.mul(Hr), kxzOverK.mul(Hi), kzzOverK.mul(Hr), kzzOverK.mul(Hi)),
    ).toWriteOnly()
  })

  // biome-ignore lint/suspicious/noExplicitAny: TSL Fn().compute typing
  const spectrumBuildNode = (spectrumBuildKernel as any)().compute(N * N)

  // 7) Unpack kernel — 1 dispatch reads 4 batched FFT outputs
  //    (each carrying two quantities' IFFTs in R/G + B/A), writes
  //    displacement + slope textures in the direct-DFT layout.
  const unpackKernel = Fn(() => {
    const px = instanceIndex.mod(N)
    const py = instanceIndex.div(N)

    // Each batched FFT output's R is the real part of the R/G
    // IFFT, and B is the real part of the B/A IFFT. The imaginary
    // parts (.g, .a) are ≈0 because the inputs encode a real
    // signal up to FP error, so we ignore them.
    // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle
    const out0: any = textureLoad(heightDxFft.outputTexture, uvec2(px, py), 0) as any
    // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle
    const out1: any = textureLoad(dzDydxFft.outputTexture, uvec2(px, py), 0) as any
    // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle
    const out2: any = textureLoad(dydzDxxFft.outputTexture, uvec2(px, py), 0) as any
    // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle
    const out3: any = textureLoad(dxzDzzFft.outputTexture, uvec2(px, py), 0) as any
    // Real parts (the imag parts are zero up to FP rounding).
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const heightOut: any = out0.r
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const dxOut: any = out0.b
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const dzOut: any = out1.r
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const dydxRaw: any = out1.b
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const dydzRaw: any = out2.r
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const dxxRaw: any = out2.b
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const dxzRaw: any = out3.r
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const dzzRaw: any = out3.b

    // Conjugate-pair ×2 factor (height, Dx, Dz).
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const height: any = heightOut.mul(float(2))
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const dx: any = dxOut.mul(float(2))
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const dz: any = dzOut.mul(float(2))

    // Slopes/partials: ×(4π/tileSize) = ×(2π/tileSize) · ×2.
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const slopeDx: any = dydxRaw.mul(physicalScaleUniform)
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const slopeDz: any = dydzRaw.mul(physicalScaleUniform)
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const dxx: any = dxxRaw.mul(physicalScaleUniform)
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const dxz: any = dxzRaw.mul(physicalScaleUniform)
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const dzz: any = dzzRaw.mul(physicalScaleUniform)

    // Jacobian: (1 + λ·Dxx)·(1 + λ·Dzz) − λ²·Dxz²
    const lambda = choppinessUniform
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar chain
    const jacobian: any = float(1)
      .add(lambda.mul(dxx))
      .mul(float(1).add(lambda.mul(dzz)))
      .sub(lambda.mul(lambda).mul(dxz).mul(dxz))

    // Choppiness and renderScale applied to write outputs — same
    // convention as direct DFT: vertex shader reads pre-scaled
    // values, Jacobian stays raw.
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const dxScaled: any = dx.mul(lambda).mul(renderScaleUniform)
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const dzScaled: any = dz.mul(lambda).mul(renderScaleUniform)
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const heightScaled: any = height.mul(renderScaleUniform)
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const slopeDxScaled: any = slopeDx.mul(renderScaleUniform)
    // biome-ignore lint/suspicious/noExplicitAny: TSL scalar
    const slopeDzScaled: any = slopeDz.mul(renderScaleUniform)

    textureStore(
      displacementTexture,
      uvec2(px, py),
      vec4(heightScaled, dxScaled, dzScaled, jacobian),
    ).toWriteOnly()
    textureStore(
      slopeTexture,
      uvec2(px, py),
      vec4(slopeDxScaled, slopeDzScaled, float(0), float(0)),
    ).toWriteOnly()
  })

  // biome-ignore lint/suspicious/noExplicitAny: TSL Fn().compute typing
  const unpackNode = (unpackKernel as any)().compute(N * N)

  function tick(time: number, renderer: THREE.WebGLRenderer): Promise<void> {
    timeUniform.value = time
    // biome-ignore lint/suspicious/noExplicitAny: WebGPURenderer cast
    const r = renderer as any
    if (typeof r.computeAsync !== 'function') return Promise.resolve()

    // 1) Build the 8 modulated spectra from h0 + time, packed
    //    into 4 batched FFT input textures.
    r.computeAsync(spectrumBuildNode)
    // 2) Run all 4 batched IFFTs (each does 2 quantities in
    //    parallel via R/G + B/A channels).
    for (const fft of fftHandles) {
      fft.dispatch(renderer)
    }
    // 3) Unpack — last dispatch in the chain; return its promise.
    return r.computeAsync(unpackNode) as Promise<void>
  }

  function dispose(): void {
    spectrumTex.dispose()
    displacementTexture.dispose()
    slopeTexture.dispose()
    for (const fft of fftHandles) fft.dispose()
  }

  function setChoppiness(v: number): void {
    choppinessUniform.value = v
  }
  function setRenderScale(v: number): void {
    renderScaleUniform.value = v
  }
  function uploadSpectrum(grid: SpectrumGrid): void {
    if (grid.N !== N) {
      // eslint-disable-next-line no-console
      console.warn(
        `[gpu-bake-fft] uploadSpectrum N mismatch: handle=${N} grid=${grid.N}; ignoring`,
      )
      return
    }
    const data = spectrumTex.image.data as Float32Array
    for (let zi = 0; zi < N; zi++) {
      for (let xi = 0; xi < N; xi++) {
        const idx = zi * N + xi
        data[idx * 4 + 0] = grid.h0[idx * 2]!
        data[idx * 4 + 1] = grid.h0[idx * 2 + 1]!
        data[idx * 4 + 2] = grid.omega[idx]!
        data[idx * 4 + 3] = 0
      }
    }
    spectrumTex.needsUpdate = true
  }

  return {
    displacementTexture,
    slopeTexture,
    tileSize,
    N,
    setChoppiness,
    setRenderScale,
    uploadSpectrum,
    tick,
    dispose,
  }
}

// Silence the unused-import warning if PhillipsParams isn't referenced
// directly — keep the import so we can extend the API without churn.
// biome-ignore lint/correctness/noUnusedVariables: see comment above
type _ReExport = PhillipsParams
