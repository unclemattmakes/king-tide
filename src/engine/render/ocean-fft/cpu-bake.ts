import * as THREE from 'three'
import { fft2d, ifftshift } from '@/engine/sim/water/fft2d-cpu'
import { buildPhillipsSpectrum } from '@/engine/sim/water/phillips'

/**
 * One-shot CPU bake of a Phillips spectrum into a tileable slope
 * texture. Drop-in replacement for the procedural sub-Gerstner detail
 * cascade (`buildWaveDetailNormalTexture` in water.ts) — same RGBA8
 * encoding, same wrap mode, same anisotropy. The shader code consuming
 * the texture stays untouched; the only change at the call site is
 * which builder runs.
 *
 * What this replaces: the procedural builder synthesizes a heightfield
 * from 22 hand-picked directional sines. Beautiful for prototyping but
 * statistically arbitrary — the spectral content is whatever the
 * authoring loop happens to land on. The Phillips replacement draws
 * from the same physics-grounded spectrum the future GPU IFFT will
 * use, so cascade A/B cascade reads stay tonally consistent when
 * Phase A swaps the big-wave path over.
 *
 * Performance: N=256 takes ~30 ms on a modern laptop (one IFFT2D plus
 * central-difference slopes). Called once per session from
 * `getWaveDetailNormalTexture`; the result is cached.
 *
 * What lives where: this module is in `src/engine/render/` because it
 * outputs a THREE.DataTexture. The pure-math pieces (Phillips spectrum
 * + IFFT) live in `src/engine/sim/water/` so the future CPU buoyancy
 * sampler can share them under the Three-free sim rule.
 */
export type FftDetailBakeOpts = {
  /** Grid resolution. Must be a power of two. */
  N?: number
  /** Physical tile size in meters — this is the world-space size one
   *  full repeat of the texture represents. The shader's cascade A/B
   *  sample the SAME texture at runtime tile sizes (11 m / 2 m), so
   *  this value sets the spectrum's wavelength budget but the visible
   *  scale is controlled by the cascade tile constants in water.ts. */
  tileSize?: number
  /** Wind speed at the surface, m/s. Drives the spectrum's peak
   *  wavelength via L = V²/g. */
  windSpeed?: number
  /** Wind direction unit vector (xz). */
  windDirX?: number
  windDirZ?: number
  /** Overall amplitude scale on the Phillips factor. Tuned so the
   *  encoded slopes peak near ±0.5 after normalization, matching the
   *  procedural builder's output range. */
  amplitude?: number
  /** Damps modes shorter than this wavelength (meters) to fight
   *  aliasing on the 1/k⁴ tail. */
  smallWavelengthCutoff?: number
  /** PRNG seed for the Gaussian h0 draws. */
  seed?: number
}

const DEFAULTS: Required<FftDetailBakeOpts> = {
  N: 256,
  tileSize: 12,
  windSpeed: 9,
  windDirX: 1,
  windDirZ: 0,
  amplitude: 0.0008,
  smallWavelengthCutoff: 0.6,
  seed: 0xa11f,
}

/**
 * Builds the slope texture. Output format is identical to the
 * procedural builder so `water.ts` can swap it in without any shader
 * change:
 *
 *   - RGBA8 (R, G = encoded slopes; B padded; A = 255)
 *   - REPEAT wrapping (toroidal central differences keep tile seams
 *     invisible)
 *   - Mipmaps + 4× anisotropy
 *
 * Decoding at sample time: `slope_normalized = sample.rg * 2 − 1`.
 */
export function buildFftDetailNormalTexture(
  opts: FftDetailBakeOpts = {},
): THREE.DataTexture {
  const cfg = { ...DEFAULTS, ...opts }
  const N = cfg.N

  // 1) Phillips spectrum on an N×N centered grid.
  const spectrum = buildPhillipsSpectrum({
    N,
    tileSize: cfg.tileSize,
    windSpeed: cfg.windSpeed,
    windDirX: cfg.windDirX,
    windDirZ: cfg.windDirZ,
    amplitude: cfg.amplitude,
    smallWavelengthCutoff: cfg.smallWavelengthCutoff,
    seed: cfg.seed,
  })

  // 2) Combine h0 with its conjugate-symmetric partner at t = 0 to get
  //    the heightfield's spectrum (real-valued in real space). This is
  //    Tessendorf eq. 26 specialized to t = 0:
  //
  //      h̃(K, 0) = h0(K) + conj(h0(−K))
  //
  //    The −K partner of (xi, zi) in centered layout is ((N−xi) mod N,
  //    (N−zi) mod N).
  const hTilde = new Float32Array(2 * N * N)
  for (let zi = 0; zi < N; zi++) {
    for (let xi = 0; xi < N; xi++) {
      const idx = zi * N + xi
      const xiC = (N - xi) % N
      const ziC = (N - zi) % N
      const idxC = ziC * N + xiC
      hTilde[idx * 2] = spectrum.h0[idx * 2]! + spectrum.h0[idxC * 2]!
      hTilde[idx * 2 + 1] = spectrum.h0[idx * 2 + 1]! - spectrum.h0[idxC * 2 + 1]!
    }
  }

  // 3) IFFT to real space. `ifftshift` converts the centered layout
  //    (DC at N/2) to the natural layout the FFT expects (DC at 0).
  //    The 1/N² scaling baked into `fft2d` direction=-1 is the DFT
  //    convention; we multiply back by N² to recover the continuous-
  //    Fourier amplitude sum the analytic sampler computes.
  ifftshift(hTilde, N)
  fft2d(hTilde, N, -1)
  for (let i = 0; i < hTilde.length; i++) hTilde[i] = hTilde[i]! * N * N

  // 4) Extract the real heightfield. The imaginary part should be ~0
  //    by construction of the conjugate-symmetric spectrum.
  const heights = new Float32Array(N * N)
  for (let i = 0; i < N * N; i++) heights[i] = hTilde[i * 2]!

  // 5) Toroidal central-difference slopes (per UV unit, not per
  //    world meter — water.ts divides by tile size at sample time).
  //    Wrap-around indexing means the slope at the tile edge uses the
  //    opposite edge as its neighbour, which is exactly what REPEAT
  //    sampling expects. No seam.
  const slopes = new Float32Array(N * N * 2)
  let smax = 0
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const left = heights[y * N + ((x - 1 + N) % N)]!
      const right = heights[y * N + ((x + 1) % N)]!
      const up = heights[((y - 1 + N) % N) * N + x]!
      const down = heights[((y + 1) % N) * N + x]!
      // (right − left)/2 is ∂h/∂(u·N); multiply by N for ∂h/∂u.
      const dhdu = (right - left) * 0.5 * N
      const dhdv = (down - up) * 0.5 * N
      slopes[(y * N + x) * 2 + 0] = dhdu
      slopes[(y * N + x) * 2 + 1] = dhdv
      const am = Math.max(Math.abs(dhdu), Math.abs(dhdv))
      if (am > smax) smax = am
    }
  }

  // 6) Pack into RGBA8 with the same `±0.5` headroom convention the
  //    procedural builder uses. Peak slope goes to ±0.5 in the encoded
  //    range so runtime scaling (detailStrength · scale/tileSize) has
  //    consistent meaning across builders.
  const inorm = smax > 0 ? 0.5 / smax : 0
  const data = new Uint8Array(N * N * 4)
  for (let i = 0; i < N * N; i++) {
    const ndx = slopes[i * 2 + 0]! * inorm
    const ndz = slopes[i * 2 + 1]! * inorm
    data[i * 4 + 0] = clampByte((ndx * 0.5 + 0.5) * 255)
    data[i * 4 + 1] = clampByte((ndz * 0.5 + 0.5) * 255)
    data[i * 4 + 2] = 128
    data[i * 4 + 3] = 255
  }

  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.name = 'water:detailNormal:fft'
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}
