import * as THREE from 'three'
import {
  abs,
  cameraFar,
  cameraNear,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  Fn,
  float,
  fract,
  fwidth,
  If,
  max,
  min,
  mix,
  normalize,
  perspectiveDepthToViewZ,
  positionLocal,
  positionView,
  positionWorld,
  pow,
  reflector,
  screenUV,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
} from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { buildFftDetailNormalTexture } from '@/engine/render/ocean-fft/cpu-bake'
import { createFft2d, type Fft2dHandle } from '@/engine/render/ocean-fft/fft-tsl'
import { createFoamFeedback } from '@/engine/render/ocean-fft/foam-feedback'
import { createGpuOceanDisplacement, createGpuOceanFft } from '@/engine/render/ocean-fft/gpu-bake'
import { createGpuOceanFftDisplacement } from '@/engine/render/ocean-fft/gpu-bake-fft'
import { TERRAIN_HEIGHTMAP_RESOLUTION } from '@/engine/render/terrain-heightmap'
import { buildPhillipsSpectrum, type PhillipsParams } from '@/engine/sim/water/phillips'
import { selectTopKModes } from '@/engine/sim/water/spectrum-modes'
import { spectrumModesToGerstnerShape } from '@/engine/sim/water/spectrum-to-gerstner'
import {
  WAKE_BASE_WIDTH,
  WAKE_DISP_AMP,
  WAKE_EDGE_BELL_HALFWIDTH,
  WAKE_HALF_ANGLE_TAN,
  WAKE_LONG_DECAY,
  WAKE_LONG_RAMP,
  WAKE_SPEED_HIGH,
  WAKE_SPEED_LOW,
  WAKE_TRANS_AMP,
  WAKE_TRANS_K,
  WAKE_TRANS_OMEGA,
  type WaveFieldState,
} from '@/engine/sim/water/wave-field'

/**
 * Per-frame data describing how a bike pushes/marks the water.
 * - x, z: world position of the hull on the XZ plane
 * - vx, vz: horizontal velocity (used for wake direction + length)
 * - weight: 0..1, fades the effect when the bike is airborne / far above
 *   the surface. Inactive bikes (weight ~ 0) are parked at distance ∞ in
 *   the shader so their Gaussian dimple + wake contribute nothing.
 */
export type BikeImpact = {
  x: number
  z: number
  vx: number
  vz: number
  weight: number
}

export type WaterMesh = {
  mesh: THREE.Mesh
  /**
   * Updates the time uniform from the field clock and pushes per-bike
   * impact data into the shader's uniform array. Pass `originXZ` (the
   * camera's XZ position) to lock the mesh to the camera so vertex
   * density tracks the visible region. Pass an empty / omitted impacts
   * array (e.g. in editor mode) to leave the surface clean.
   */
  tick(impacts?: readonly BikeImpact[], originXZ?: { x: number; z: number }): void
  /**
   * Updates the water shader's sun-direction uniform from a world-space
   * sun position (typically the directional light's position). The
   * vector is normalized internally; pass either a position or already-
   * normalized direction. Used by the day-night cycle in `main.ts` to
   * keep the water's sun-glow + scatter blend in sync with the moving
   * directional light.
   */
  setSunDirection(x: number, y: number, z: number): void
  /**
   * Updates the horizon-haze color used for the aerial-perspective fade
   * at long view distances. The sky module calls this each tick with the
   * current palette horizon color so distant water naturally picks up
   * sunset / dawn warmth, twilight blue, etc. — keeps the horizon line
   * in tonal harmony with the sky behind it instead of reading as a
   * fixed teal-grey haze. RGB values are linear, in [0, 1].
   */
  setHorizonColor(r: number, g: number, b: number): void
  /** Install the track's terrain heightmap. The shader uses it to attenuate
   *  wave displacement in shallow water (so crests stop clipping through
   *  the seabed and shoreline geometry) and to drive depth-driven surf
   *  foam at the waterline. Call once per track load after the GLB /
   *  procedural terrain is in place. The water shader's behaviour is
   *  unchanged for tracks where no heightmap is installed (e.g. editor
   *  mode) — wave amplitude stays at full strength everywhere. */
  setTerrainHeightmap(heightmap: import('./terrain-heightmap').TerrainHeightmap): void
  /** Live-tunable knobs for the water debug menu. All setters apply
   *  immediately — no material rebuild, no reload. */
  debug: {
    /** Defaults captured at construction so the menu's RESET button can
     *  restore them without hard-coding values that may drift. */
    readonly defaults: WaterDebugDefaults
    /** Global Gerstner steepness multiplier (Q). 0 = round bumps,
     *  ~0.7 = SoT default, >1.3 risks crests folding. */
    setSteepness(s: number): void
    /** Multiplier on the two long-period swell amplitudes (waves 0–1).
     *  Mutates `field.waves[i].amplitude` so CPU buoyancy follows. */
    setSwellScale(s: number): void
    /** Multiplier on the four wind-chop amplitudes (waves 2–5).
     *  Mutates `field.waves[i].amplitude` so CPU buoyancy follows. */
    setChopScale(s: number): void
    /** Multiplier on `dt` passed to `advanceWaveField` from the main
     *  loop. The main loop reads `getTimeScale()` each step. */
    setTimeScale(s: number): void
    /** Fresnel cap on the planar reflection (0..1). 0 disables the
     *  reflection entirely; 0.85 is the v2 default. */
    setReflectionStrength(s: number): void
    /** Multiplier on the sun-backlight glow on tall crests. */
    setSunGlow(s: number): void
    /** Material base roughness (away from sparkle patches). */
    setRoughBase(s: number): void
    /** Material roughness inside sparkle patches (lower = brighter
     *  pin-point glints). */
    setRoughSparkle(s: number): void
    /** Strength of the sub-Gerstner detail-normal cascades. 0 = bypass
     *  detail (analytic-Gerstner only); 1 = the default cascade
     *  contribution that stands in for SoT-style FFT chop. */
    setDetailStrength(s: number): void
    /** Tessendorf choppiness λ — controls horizontal displacement and
     *  Jacobian-foam threshold on the A2 GPU IFFT path. No-op outside
     *  the FFT path (`?water=fft` + spectrum field). */
    setChoppiness(s: number): void
    /** Visual sea-state intensity (renderScale on the displacement
     *  kernel). 1 = built-in spectrum tune; raise for stormier, lower
     *  for glassy calm. No-op outside the FFT path. */
    setSeaStateIntensity(s: number): void
    /** Wind speed in m/s — drives the Phillips spectrum's dominant
     *  wavelength `L = V²/g`. Mutating it rebuilds the spectrum
     *  (~1 ms for N=32) and reuploads the h0 array to the GPU; the
     *  CPU buoyancy sampler's top-K modes update in lockstep. No-op
     *  outside the FFT path. */
    setWindSpeed(s: number): void
    /** A8 foam-feedback persistence (0..1, intuitive). 0 = foam
     *  fades almost instantly (per-frame decay 0.7 = ~9 ms
     *  half-life), 1 = foam barely fades (decay 0.99 = ~7 s
     *  half-life). The slider maps linearly to `decay = lerp(0.7,
     *  0.99, value)` then forwards to `foamFeedbackHandle.setDecay`.
     *  No-op when the foam-feedback handle is absent (non-FFT or
     *  `?foamfb=0`). */
    setFoamPersistence(s: number): void
    /** Wind direction as an angle in degrees, CCW from world +X
     *  (the same convention `Math.atan2(dirZ, dirX)` returns).
     *  Internally converted to (cos, sin) before being plumbed
     *  through `applySpectrumParams` → `buildPhillipsSpectrum`. The
     *  Mitsuyasu directional spread is computed in terms of the
     *  angle between each mode and the wind, so the spectrum reads
     *  through the new direction in lockstep with the wind-speed
     *  rebuild. Only affects the primary wind-sea cascade — the
     *  chop + long-swell cascades have their own hard-coded wind
     *  directions to preserve the cross-cascade angle separation
     *  the A7 tune relies on. No-op outside the FFT path. */
    setWindDirection(deg: number): void
    /** Phillips small-wavelength cutoff in meters. Modes with
     *  wavelength below this are zeroed by the spectrum builder —
     *  raising this prunes high-frequency chop (smoother surface,
     *  faster compute since more h0 entries are zero); lowering it
     *  pulls in finer chop at the cost of more aliasing-prone modes
     *  in the spectrum tail. Tuned per visual taste. Same orchestrated
     *  rebuild path as the wind-speed/direction setters. No-op
     *  outside the FFT path. */
    setWindCutoff(m: number): void
    /** Render the wave geometry as wireframe. Useful for tuning wave /
     *  wake amplitudes against the actual displacement. */
    setWireframe(on: boolean): void
    /** Time-scale getter for the main loop. */
    getTimeScale(): number
  }
  dispose(): void
}

export type WaterDebugDefaults = {
  steepness: number
  swellScale: number
  chopScale: number
  timeScale: number
  reflectionStrength: number
  sunGlow: number
  roughBase: number
  roughSparkle: number
  detailStrength: number
  /** Tessendorf choppiness λ on the A2 GPU displacement kernel. Only
   *  consumed by the FFT path (`?water=fft` + spectrum field); the
   *  setter no-ops on the analytic Gerstner path. 0 = pure
   *  heightfield, 0.5 = the mid-Tessendorf default, >1 starts to fold. */
  choppiness: number
  /** Visual scale on (height, Dx, Dz, slope) from the A2 GPU
   *  displacement kernel. FFT-path only. 1 = built-in spectrum tune;
   *  scrub higher for stormier seas, lower for calmer. Lets per-track
   *  sea state be dialed in without rebuilding the spectrum. */
  seaStateIntensity: number
  /** Phillips spectrum wind speed (m/s). FFT-path only. Drives the
   *  dominant wavelength `L = V²/g`; mutation rebuilds the spectrum
   *  + reuploads h0 to GPU + refreshes the CPU sampler's top-K. */
  windSpeed: number
  /** Wind direction (deg CCW from world +X). FFT-path only. Rebuilds
   *  the wind-sea cascade's spectrum on change; the chop + long-swell
   *  cascades keep their hard-coded directions so cascade angle
   *  separation is preserved. */
  windDirection: number
  /** Phillips small-wavelength cutoff (m). FFT-path only. Modes with
   *  wavelength below this are pruned from the spectrum tail. Lower =
   *  finer chop (more aliasing risk); higher = smoother surface. */
  windCutoff: number
  /** A8 foam-feedback persistence (0..1, intuitive). 0 = fast fade,
   *  1 = long trails. Maps to per-frame decay via `lerp(0.7, 0.99,
   *  value)`. FFT path only; no-op when the foam-feedback handle is
   *  absent. */
  foamPersistence: number
  wireframe: boolean
}

/** Maximum bikes the shader supports per frame. Today's race is player +
 * 4 AI = 5 bikes; if that grows, bump this. Each slot adds an unrolled
 * vertex-stage Gaussian dimple plus a fragment-stage early-out check. */
const MAX_BIKES = 5
/** Cull radius for fragment-stage bike effects: outside this distance from
 * a bike's XZ position, the ring + wake foam are guaranteed ≈ 0, so we
 * skip the per-bike math via an `If` early-out. Squared comparison avoids
 * a sqrt. Tune up if longer wakes are added. */
const BIKE_INFLUENCE_R = 35.0
const BIKE_INFLUENCE_R_SQ = BIKE_INFLUENCE_R * BIKE_INFLUENCE_R
/** Hull dimple radius (Gaussian σ) — controls how wide the depression is. */
const BIKE_DIMPLE_R = 1.6
/** Peak depth of the hull dimple, meters. */
const BIKE_DIMPLE_DEPTH = 0.32
/** Squared cull radius for the vertex-stage dimple. exp(-r²/R²) is below
 * 1e-7 outside ~6σ, so we can skip the exp entirely past this distance. */
const BIKE_DIMPLE_CULL_R_SQ = BIKE_DIMPLE_R * 6 * (BIKE_DIMPLE_R * 6)
/** Cull radius for vertex-stage wake displacement. The wake's exponential
 * decay (exp(-behind · LONG_DECAY)) reaches ~20% of peak by 40m, so the
 * residual is below visual noise. Tighter than the foam radius because the
 * vertex stage runs over the full water mesh — most vertices need to early-
 * out cheaply or headless WebGL2 (SwiftShader) tanks to ~3 fps. */
const WAKE_DISP_CULL_R = 40.0
const WAKE_DISP_CULL_R_SQ = WAKE_DISP_CULL_R * WAKE_DISP_CULL_R

const INACTIVE_FAR = 1e6

// ---------------------------------------------------------------------------
// Procedural sub-Gerstner detail normal map.
//
// SoT and Atlas (GDC 2019) reach sub-meter wave detail via FFT cascades. We
// stand in for that with a single tileable wave-like normal map sampled at
// two world-XZ scales + scroll directions in the fragment. The slopes from
// these two cascades add to the analytic Gerstner gradient before the normal
// is built, so the surface picks up the fine "wave chop" that Gerstner can't
// reach without an explosive vertex count — and hardware mipmap filtering
// kills the per-pixel speckle that an FFT in WebGPU would still need a
// custom AA pass to solve.
//
// The texture encodes pre-computed surface slopes (dh/du, dh/dv) into the RG
// channels with the standard [-1,1] → [0,1] convention. At sample time the
// shader decodes (px*2-1, py*2-1), scales by `detailStrength / tileScale`,
// and adds to the heightfield's (dydx, dydz) gradient. The actual height of
// the detail isn't reconstructed — only slopes matter for shading.
//
// Tileability: each component sine uses integer (kx, kz) on the N×N grid, so
// the heightfield (and thus its slopes) repeats seamlessly across tile
// boundaries. The texture is set up with REPEAT wrapping + anisotropy so
// grazing-angle samples don't smear.
// ---------------------------------------------------------------------------

/**
 * Two caches — one per detail-texture provider. `procedural` is the legacy
 * 22-component analytic sum that ships today; `fft` is the Phillips-spectrum
 * IFFT bake from `ocean-fft/cpu-bake.ts`. Both are RGBA8 / REPEAT / mipmapped
 * so the shader code consuming them is identical regardless of mode. The
 * FFT bake is the first step of the larger FFT-ocean migration (see
 * `docs/fft-ocean-plan.md`); future phases swap GPU compute in behind the
 * same flag.
 */
let sharedWaveDetailNormalProcedural: THREE.DataTexture | null = null
let sharedWaveDetailNormalFft: THREE.DataTexture | null = null

function buildWaveDetailNormalTexture(): THREE.DataTexture {
  const N = 256
  const data = new Uint8Array(N * N * 4)

  // Integer (kx, kz) pairs — each is one tileable directional sine on the
  // unit tile. The set roughly approximates a Phillips spectrum (more energy
  // mid-frequency, less at the highest cells) so the detail reads as wave
  // chop rather than noise.
  const RAW_DIRS: [number, number][] = [
    [3, 1],
    [2, 3],
    [4, -1],
    [1, 4],
    [-1, 3],
    [-3, 2],
    [6, 2],
    [5, -3],
    [-2, 5],
    [3, 5],
    [-4, 4],
    [7, 1],
    [8, 4],
    [-5, 6],
    [6, -5],
    [9, 3],
    [4, 8],
    [-7, -5],
    [11, 4],
    [-8, 7],
    [10, -6],
    [13, 5],
  ]
  type Comp = { kx: number; kz: number; amp: number; phase: number }
  const FREQS: Comp[] = RAW_DIRS.map(([kx, kz]) => {
    const k = Math.hypot(kx, kz)
    return {
      kx,
      kz,
      amp: 1 / k ** 1.3,
      // Deterministic per-component phase via a cheap hash.
      phase: ((Math.sin(kx * 12.9898 + kz * 78.233) * 43758.5453) % 1) * (2 * Math.PI),
    }
  })

  // Heights on unit tile.
  const heights = new Float32Array(N * N)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N
      const v = y / N
      let h = 0
      for (const f of FREQS) {
        h += f.amp * Math.sin(2 * Math.PI * (f.kx * u + f.kz * v) + f.phase)
      }
      heights[y * N + x] = h
    }
  }

  // Toroidal central-difference slopes (so the tile is seamless under REPEAT).
  // `dh/du` is the slope per unit of u ∈ [0,1]; runtime divides by tileScale
  // to convert that into world-space dh/dx.
  const slopes = new Float32Array(N * N * 2)
  let smax = 0
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const left = heights[y * N + ((x - 1 + N) % N)]!
      const right = heights[y * N + ((x + 1) % N)]!
      const up = heights[((y - 1 + N) % N) * N + x]!
      const down = heights[((y + 1) % N) * N + x]!
      // (right - left) / 2 is ∂h/∂(u·N); multiply by N to get ∂h/∂u.
      const dhdu = (right - left) * 0.5 * N
      const dhdv = (down - up) * 0.5 * N
      slopes[(y * N + x) * 2 + 0] = dhdu
      slopes[(y * N + x) * 2 + 1] = dhdv
      const am = Math.max(Math.abs(dhdu), Math.abs(dhdv))
      if (am > smax) smax = am
    }
  }

  // Pack with a normalization that leaves headroom in the [-1, +1] range.
  // 0.5/smax puts the peak slope at ±0.5 of the encoded range; runtime scales
  // back up via `detailStrength` so the visible amplitude is tunable.
  const inorm = smax > 0 ? 0.5 / smax : 0
  for (let i = 0; i < N * N; i++) {
    const ndx = slopes[i * 2 + 0]! * inorm
    const ndz = slopes[i * 2 + 1]! * inorm
    data[i * 4 + 0] = Math.max(0, Math.min(255, Math.round((ndx * 0.5 + 0.5) * 255)))
    data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round((ndz * 0.5 + 0.5) * 255)))
    data[i * 4 + 2] = 128
    data[i * 4 + 3] = 255
  }

  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.name = 'water:detailNormal'
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  // Without anisotropy the texture smears noticeably as the camera tilts
  // toward grazing — 4× is the standard SoT-style sweet spot and is cheap.
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

function getWaveDetailNormalTexture(mode: 'procedural' | 'fft'): THREE.DataTexture {
  if (mode === 'fft') {
    if (!sharedWaveDetailNormalFft) {
      sharedWaveDetailNormalFft = buildFftDetailNormalTexture()
    }
    return sharedWaveDetailNormalFft
  }
  if (!sharedWaveDetailNormalProcedural) {
    sharedWaveDetailNormalProcedural = buildWaveDetailNormalTexture()
  }
  return sharedWaveDetailNormalProcedural
}

/**
 * GPU-shader water built on Three.js's TSL node pipeline.
 *
 * The vertex shader Gerstner-displaces a flat plane and subtracts a per-bike
 * Gaussian "hull dimple" + adds each bike's transverse wake oscillation. The
 * wake displacement uses the same closed-form function as the sim layer's
 * `sampleWakeFromSource`, so the buoyancy field a trailing rider feels
 * matches the visual ripples one-to-one — the lead bike's wake becomes a
 * real bump that other bikes can launch off ("jump my wake").
 *
 * The fragment shader recomputes the analytic normal per pixel — including
 * both the dimple and wake gradients — and adds:
 *
 *  - PBR-style albedo gradient (deep blue → cyan with crest height)
 *  - Crest foam from height + slope of the wave field
 *  - Hull foam ring around each bike
 *  - V-shaped wake foam stripe trailing behind each moving bike
 *  - Fresnel sky-tint on the emissive channel
 *  - Cheap hash-noise sparkle, gated to crests
 *
 * The Gerstner sum mirrors `sampleSurface` in the sim's wave-field module so
 * the rendered surface and the buoyancy field stay in lock-step. The CPU
 * sampler remains the source of truth for buoyancy; this is its visual twin.
 *
 * Wave parameters are baked into the shader at construction. If
 * `defaultWaves()` ever changes at runtime, rebuild the material.
 */
export function createWaterMesh(
  field: WaveFieldState,
  opts?: {
    size?: number
    subdivisions?: number
    /** Renderer backend. Required to know whether to use the GPU FFT
     *  compute path (WebGPU only) or fall back to the static CPU bake
     *  when `?water=fft` is active. Detected by `createRenderer` and
     *  passed through from boot. Omit to default to WebGL2 (skip GPU
     *  compute). */
    backend?: 'webgpu' | 'webgl2'
  },
): WaterMesh {
  const size = opts?.size ?? 240
  // 384 subs × 240 m ≈ 0.625 m vertex spacing. The mesh follows the
  // camera (see `tick`'s `originXZ` arg + the meshOrigin uniform), so the
  // 240 m of mesh stays centered on the visible patch instead of being
  // anchored at world origin (with the player at z ≈ 90 sitting near the
  // edge). Combined with the higher subdivision, the 4 m wake wavelength
  // gets ~6.4 verts per crest — ridges show up as actual geometry, not a
  // single-vertex shimmer. 384² ≈ 147 k verts is trivial on a real GPU.
  const subs = opts?.subdivisions ?? 384

  // ---- Debug toggles ----------------------------------------------------
  // `?water=classic` falls back to vertical-only Gerstner + the original
  // single-color albedo gradient (no horizontal pinching, no scatter blend).
  // Useful for A/B-ing the SoT-style upgrade in playtest.
  // `?water=wire` (handled later) renders wireframe — see end of function.
  // `?steep=<n>` overrides the initial steepness scale (0..1.5 recommended).
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
  const waterMode = params?.get('water') ?? 'v2'
  const isClassic = waterMode === 'classic'
  // FFT detail-texture opt-in. When set, the sub-Gerstner detail cascade
  // samples a Phillips-spectrum IFFT bake instead of the procedural
  // 22-sine texture. First step of the FFT-ocean migration in
  // `docs/fft-ocean-plan.md` — buoyancy + big-wave silhouette stay on the
  // existing Gerstner sum, only the high-frequency detail layer swaps.
  //
  // Two variants live behind the same flag:
  //   - WebGPU backend → GPU compute kernel re-bakes the slope texture
  //     every frame, so the surface actually animates (Phase C3).
  //   - WebGL2 fallback → static CPU bake from Phase C2; same visual
  //     character as the GPU path at t=0 but no animation, so the warp
  //     + scroll in the cascade is doing all the motion work.
  const detailMode: 'procedural' | 'fft' = waterMode === 'fft' ? 'fft' : 'procedural'
  const useGpuFft = detailMode === 'fft' && opts?.backend === 'webgpu'
  // Phase A2 — full-spectrum GPU IFFT drives the BIG-WAVE silhouette.
  // Activates when both `?water=fft` and a spectrum-mode wave field are
  // in play on WebGPU: the vertex shader trades its 32-mode analytic
  // sum for two texture samples (displacement + slope) per vertex, and
  // gets the full Phillips spectrum back without paying the per-vertex
  // unrolled-loop cost. The Gerstner-mode field stays on the analytic
  // path even with `?water=fft` since the displacement kernel needs
  // `field.spectrumParams` as input.
  const useGpuDisplacement = useGpuFft && field.kind === 'spectrum'
  // A2 + SoT cascades — Sea of Thieves' SIGGRAPH 2018 talk / Horvath
  // 2015 / Atlas (GDC 2019) all combine MULTIPLE FFT cascades at
  // different tile sizes to capture wave wavelengths across orders
  // of magnitude. Each cascade carries a different frequency band:
  // long-period swell from the biggest-tile cascade, mid-band wind
  // sea, fine chop. Tile sizes are picked non-commensurate so the
  // cascades don't re-align and produce visible regular patterns
  // (Horvath calls this "the single biggest fix for I-can-see-the-
  // tile" — pick irrational ratios, not clean multiples).
  //
  // Cascade 0 — `field.spectrumParams` (tileSize=90, windSpeed=11).
  //   The "wind sea" band. CPU buoyancy reads top-K of THIS
  //   spectrum, so the bike's physics matches this cascade's heights.
  //   Stays the buoyancy source of truth.
  // Cascade 1 — smaller tile (22 m), lower wind speed (6 m/s, peak
  //   wavelength L ≈ 3.7 m). Fine chop riding on top of the swell.
  //   Wider directional spread (s=1) so the chop doesn't band into
  //   stripes when summed onto the well-aligned swell.
  // Cascade 2 — large tile (250 m), high wind speed (16 m/s, peak
  //   wavelength L ≈ 26 m). Long-period swell that gives the
  //   horizon line its slow rolling motion. Low amplitude — this is
  //   atmospheric, not foreground geometry. Narrow alignment to
  //   read as cleanly directional incoming swell.
  //
  // Vertex shader sums height + Dx + Dz across all cascades; foam
  // takes the minimum Jacobian across cascades (J<0 anywhere means
  // the surface is folding there, regardless of which cascade caused
  // it). CPU buoyancy stays on cascade 0 only — the chop + long-
  // swell cascades are visuals-only (bounded contribution to total
  // height, ~10–30 cm RMS each, well under the buoyancy gap budget).
  // `?fftbake=fft` switches ALL THREE displacement cascades
  // (wind-sea + chop + long-swell) from the direct-DFT path to
  // the A9 real-FFT path. Both produce the same handle shape, so
  // the downstream vertex shader is indifferent. Default =
  // `ddft` (direct DFT).
  //
  // The FFT primitive supports any power-of-two N ≥ 4 (the
  // dispatch is parity-agnostic — handles both log₂N parities).
  // We bump cascade 0 to N=128 on the FFT branch — that's the
  // real win: ~½-meter wave detail straight from the spectrum,
  // no separate normal-map cascade needed. The direct-DFT path
  // can't afford N=128 (its cost is O(N⁴) = 268M ops vs the
  // FFT's O(N²·logN) = 115k mode-ops). The CPU buoyancy sampler
  // stays on the original N=32 top-K of cascade 0 so buoyancy
  // doesn't change between the two paths — they read the same
  // h0 array (deterministically built from `spectrumParams`).
  const fftBakeMode = params?.get('fftbake') === 'fft' ? 'fft' : 'ddft'
  // Resolution tier for the FFT-path cascades. `hi` reverts to the
  // original shipping values (N=128 main + N=64 chop/swell → 68+52+52
  // = 172 compute dispatches/frame at 60 Hz). `lo` (default) halves the
  // main cascade and drops chop/swell to N=32, cutting dispatch count
  // to ~124/frame (~30 % reduction) and halving per-dispatch GPU work
  // on each cascade. The detail drop is visible at close camera angles
  // and on long open-water vistas but hard to spot during a race; the
  // 0.6–0.8 ms/frame submission overhead noted in `gpu-bake-fft.ts`
  // shrinks proportionally. Override per-session with `?fft=hi`.
  const fftRes = params?.get('fft') === 'hi' ? 'hi' : 'lo'
  const fftMainN = fftRes === 'hi' ? 128 : 64
  const fftSecondaryN = fftRes === 'hi' ? 64 : 32
  // Frame-skip cadence for the FFT cascade + foam-feedback dispatches.
  // `?fftskip=N` runs the cascades once every N frames (default 2 — wave
  // surface updates at ~30 Hz inside a 60 Hz rAF loop). The displacement
  // textures are held between updates; the vertex/fragment shader keeps
  // sampling them so the surface is visually "frozen" for one frame
  // between updates, which is imperceptible at racing speed but halves
  // the per-frame compute dispatch count + GPU kernel work. Each
  // cascade's `tick(time, ...)` re-evaluates `h0·e^{iωt}` to the
  // current time when it runs, so the spectrum doesn't go stale across
  // skipped frames — it just samples a coarser temporal grid.
  // Sim-side buoyancy reads `field` directly (not the GPU textures), so
  // multiplayer sync + replays + bike feel are unaffected.
  // Override per-session with `?fftskip=1` for every-frame updates.
  const fftSkipParam = Number(params?.get('fftskip') ?? '2')
  const fftSkip = Number.isFinite(fftSkipParam) && fftSkipParam >= 1 ? Math.floor(fftSkipParam) : 2
  const displacementFactory =
    fftBakeMode === 'fft' ? createGpuOceanFftDisplacement : createGpuOceanDisplacement
  const displacementPhillipsParams =
    fftBakeMode === 'fft' && field.kind === 'spectrum'
      ? { ...field.spectrumParams, N: fftMainN }
      : field.kind === 'spectrum'
        ? field.spectrumParams
        : null
  const gpuDisplacementHandle =
    useGpuDisplacement && displacementPhillipsParams !== null
      ? displacementFactory({ phillipsParams: displacementPhillipsParams })
      : null
  // The chop + long-swell cascades share the same `displacementFactory`
  // (direct DFT or FFT path) as the wind-sea cascade above. On the FFT
  // branch they follow the `?fft` tier knob (default lo = N=32, hi =
  // N=64). On the DDFT branch they stay at the sim's spectrum N (32).
  const chopN =
    fftBakeMode === 'fft' ? fftSecondaryN : field.kind === 'spectrum' ? field.spectrumParams.N : 32
  const swellN =
    fftBakeMode === 'fft' ? fftSecondaryN : field.kind === 'spectrum' ? field.spectrumParams.N : 32
  const gpuChopHandle =
    useGpuDisplacement && field.kind === 'spectrum'
      ? displacementFactory({
          phillipsParams: {
            ...field.spectrumParams,
            N: chopN,
            tileSize: 22,
            windSpeed: 6,
            // Rotate the chop wind direction 90° from the main
            // cascade so the small-wavelength wave fronts run
            // PERPENDICULAR to the swell — chop crossing swell is
            // what real wind seas look like, and it kills the
            // strict-linear-alignment look that single-direction
            // summed cascades produce.
            windDirX: 0.8,
            windDirZ: -0.6,
            amplitude: 2.5e-6,
            // Wider directional spread on the chop cascade so the
            // smaller wavelengths don't read as parallel stripes
            // when summed onto the well-aligned swell.
            directionalSpread: 1,
            // Different seed so the chop spectrum is statistically
            // independent of the swell — otherwise both cascades
            // would beat against each other and produce visible
            // moiré at the cascade tile boundaries.
            seed: 0x0cea,
          },
          // Less Tessendorf pinch on the chop — it's already
          // fine-grained, more pinching just produces NaN-grade
          // partials on the alpha (Jacobian) channel.
          choppiness: 0.4,
        })
      : null
  const gpuSwellHandle =
    useGpuDisplacement && field.kind === 'spectrum'
      ? displacementFactory({
          phillipsParams: {
            ...field.spectrumParams,
            N: swellN,
            tileSize: 250,
            windSpeed: 16,
            // Rotate long swell wind 30° from main cascade — real
            // long-period swell is often generated by a storm far
            // away (different direction from the LOCAL wind).
            // Three cascades with three different wind directions
            // gives the surface a recognizably chaotic-but-coherent
            // ocean character.
            windDirX: 0.3,
            windDirZ: 0.95,
            // Low amplitude. Spectral energy scales with `A · L²` so
            // bumping windSpeed to 16 (L = 26m vs 12m on cascade 0)
            // already 4× the per-mode energy — `A = 1e-7` brings
            // cascade 2's RMS contribution to ~0.3m, which adds the
            // slow horizon motion without overpowering the bike's
            // buoyancy at the start grid.
            amplitude: 1e-7,
            // Narrow alignment — long-period swell IS directional in
            // real oceans (storm rollers come from one direction
            // across hundreds of miles).
            directionalSpread: 6,
            seed: 0x5ea1,
          },
          choppiness: 0.3,
        })
      : null
  // A8 — Persistent foam feedback buffer. Reads each cascade's
  // Jacobian via the displacement-texture .a channel, takes the min,
  // smoothsteps it into instant-foam intensity, and keeps a temporally
  // decaying max in a world-space R32F storage texture. The fragment
  // shader samples this instead of computing foldFoam stateless — foam
  // now persists for ~1 second after a wave breaks. Single read_write
  // storage texture (per-texel self-update is race-free since each
  // thread only touches its own texel). Gated on the same condition
  // as the cascades — analytic / classic paths leave foam stateless
  // since they don't have a per-pixel Jacobian source.
  // `?foamfb=0` disables the feedback handle so the FFT path falls
  // back to the legacy stateless `smoothstep(0.5, 0.0, J)` foldFoam.
  // Useful for A/B-comparing the persistence feature against the
  // pre-A8 look on the same camera position.
  const foamFeedbackEnabled = params?.get('foamfb') !== '0'
  // Drift speed (m/s) along cascade 0's wind direction. ~30 % of
  // wind speed is the textbook surface-drift coefficient. At the
  // default windSpeed=11 m/s that's ~3 m/s — enough drift over a
  // 700 ms foam lifetime (=2 m total drift) to be clearly visible
  // without strobing across the buffer.
  const FOAM_DRIFT_FRACTION_OF_WIND = 0.3
  const initialFoamDriftSpeed =
    field.kind === 'spectrum' ? field.spectrumParams.windSpeed * FOAM_DRIFT_FRACTION_OF_WIND : 3
  const initialFoamDriftX =
    field.kind === 'spectrum'
      ? field.spectrumParams.windDirX * initialFoamDriftSpeed
      : initialFoamDriftSpeed
  const initialFoamDriftZ =
    field.kind === 'spectrum' ? field.spectrumParams.windDirZ * initialFoamDriftSpeed : 0
  const foamFeedbackHandle =
    foamFeedbackEnabled && gpuDisplacementHandle && gpuChopHandle && gpuSwellHandle
      ? createFoamFeedback({
          cascades: [gpuDisplacementHandle, gpuChopHandle, gpuSwellHandle],
          driftX: initialFoamDriftX,
          driftZ: initialFoamDriftZ,
        })
      : null
  // A9 foundation smoke test: `?fftverify=1` instantiates the
  // standalone TSL radix-2 FFT pipeline (without integrating it
  // into the displacement path) and dispatches it once per frame.
  // The output texture isn't sampled anywhere yet — this is purely
  // a "does the compute pipeline build + dispatch without
  // crashing the renderer" check, useful for catching kernel-build
  // errors before the full A9 integration lands. A successful run
  // produces no visible difference; a failed kernel build is
  // visible in the browser console.
  const fftVerifyEnabled = params?.get('fftverify') === '1'
  const fft2dHandle: Fft2dHandle | null =
    fftVerifyEnabled && opts?.backend === 'webgpu' ? createFft2d({ N: 64 }) : null
  // `?wire=1` is an ORTHOGONAL toggle — works with classic, v2, and any
  // future shader variant. The old `?water=wire` is still honored for
  // backward compatibility.
  const wireFlag = params?.get('wire') === '1' || waterMode === 'wire'

  const geom = new THREE.PlaneGeometry(size, size, subs, subs)
  geom.rotateX(-Math.PI / 2)

  // Time uniform driven from the sim's `field.time`. Using the sim clock
  // (rather than wall-clock) keeps rendering deterministic and matches
  // buoyancy exactly across rewinds / fixed-step runs.
  const tNode = uniform(field.time)

  // Global steepness scale Q ∈ [0, ~1.5]. 0 = vertical-only Gerstner (round
  // bumps); higher values pinch crests laterally (Sea-of-Thieves-style
  // ridges). Each wave has a per-wave Q_BASE in waveConsts (chops sharper
  // than swells); this uniform multiplies all of them. Default 0.7 keeps the
  // sum Σ Q_eff · k · A well below the loop-formation limit (~1).
  const initialSteepness = isClassic
    ? 0
    : Math.max(0, Math.min(1.5, Number(params?.get('steep') ?? '0.7')))
  const steepnessUniform = uniform(initialSteepness)

  // ---- Tunable scalars (water debug menu) -------------------------------
  // Each is a uniform so the menu can scrub it live without rebuilding the
  // material. Defaults match the values the v2 shader was authored against;
  // RESET in the menu restores them via `waterMesh.debug.defaults`.
  const REFLECTION_STRENGTH_DEFAULT = 0.85
  const SUN_GLOW_DEFAULT = 0.6
  const ROUGH_BASE_DEFAULT = 0.18
  const ROUGH_SPARKLE_DEFAULT = 0.04
  // Strength of the sub-Gerstner detail-normal cascades (see comment block
  // above the texture builder). 0 = bypass detail entirely (analytic-Gerstner
  // only); 1.0 = baseline cascade contribution; 1.4 = the punchier default
  // that lands closer to SoT after side-by-side comparison — the bare 1.0
  // version read as "soft stipple", at 1.4 the chop reads as actual surface
  // wave detail. `?detail=0` parks this at 0 for A/B.
  const DETAIL_STRENGTH_DEFAULT = 1.4
  const reflStrengthUniform = uniform(REFLECTION_STRENGTH_DEFAULT)
  const sunGlowUniform = uniform(SUN_GLOW_DEFAULT)
  const roughBaseUniform = uniform(ROUGH_BASE_DEFAULT)
  const roughSparkleUniform = uniform(ROUGH_SPARKLE_DEFAULT)
  const detailFlag = !isClassic && params?.get('detail') !== '0'
  const detailStrengthUniform = uniform(detailFlag ? DETAIL_STRENGTH_DEFAULT : 0)
  // Per-group amplitude scales — one for swells (waves 0–1), one for chops
  // (waves 2–5). Both default to 1.0 (no scale). The shader multiplies the
  // baked per-wave constants by these uniforms; the CPU buoyancy mirrors
  // by mutating `field.waves[i].amplitude` directly so the two paths stay
  // in lockstep. Baseline amplitudes are captured here so toggling the
  // scales preserves the relative balance of the wave preset.
  const SWELL_INDICES = new Set([0, 1])
  const swellScaleUniform = uniform(1)
  const chopScaleUniform = uniform(1)
  // Per-wave baseline amplitudes — captured here so swell/chop scale
  // sliders can restore the original balance. In spectrum mode the
  // sliders no-op (the Gerstner notion of "swell vs chop" doesn't map
  // cleanly to a continuous spectrum); we still grab the converted
  // amplitudes so the array exists for downstream code, but
  // `setSwellScale`/`setChopScale` are short-circuited below.
  const baseAmplitudes =
    field.kind === 'spectrum'
      ? spectrumModesToGerstnerShape(field.spectrum).map((m) => m.amp)
      : field.waves.map((w) => w.amplitude)
  // Time scale for the main loop. Stored here rather than as a uniform
  // because dt is consumed by `advanceWaveField` on the CPU side; the
  // shader reads `field.time` regardless of how fast it advances.
  let timeScale = 1

  // World-XZ origin of the mesh — set by `tick(...)` to the camera's XZ
  // each frame so the mesh follows the camera. The wave / wake math
  // samples at WORLD coords (positionLocal + meshOrigin), so the surface
  // stays continuous in world space even though the mesh slides under
  // the camera. This keeps the dense-vertex region pinned to the visible
  // area regardless of where the player has driven on the lagoon.
  const meshOriginX = uniform(0)
  const meshOriginZ = uniform(0)

  // Terrain heightmap (top-down max-Y) sampled by the vertex shader to
  // attenuate wave displacement in shallow water and by the fragment shader
  // to drive depth-driven surf foam at the waterline. A fixed-size
  // placeholder filled with `DEEP_SENTINEL` is allocated at construction
  // so the shader compiles + binds safely on every platform;
  // `setTerrainHeightmap` copies the track's baked data into this same
  // texture in-place (so the GPU-side texture binding never changes,
  // avoiding driver re-allocation pitfalls). While disabled,
  // `terrainEnabledUniform = 0` makes the shader treat the whole sea as
  // bottomless — full waves, no surf foam.
  const TERRAIN_HEIGHTMAP_RES = TERRAIN_HEIGHTMAP_RESOLUTION
  const DEEP_HALF = THREE.DataUtils.toHalfFloat(-10000)
  const heightmapData = new Uint16Array(TERRAIN_HEIGHTMAP_RES * TERRAIN_HEIGHTMAP_RES)
  heightmapData.fill(DEEP_HALF)
  const terrainHeightTex = new THREE.DataTexture(
    heightmapData,
    TERRAIN_HEIGHTMAP_RES,
    TERRAIN_HEIGHTMAP_RES,
    THREE.RedFormat,
    THREE.HalfFloatType,
  )
  terrainHeightTex.name = 'water:terrainHeightmap'
  terrainHeightTex.minFilter = THREE.LinearFilter
  terrainHeightTex.magFilter = THREE.LinearFilter
  terrainHeightTex.wrapS = THREE.ClampToEdgeWrapping
  terrainHeightTex.wrapT = THREE.ClampToEdgeWrapping
  terrainHeightTex.generateMipmaps = false
  terrainHeightTex.needsUpdate = true
  const terrainMinUniform = uniform(new THREE.Vector2(0, 0))
  const terrainMaxUniform = uniform(new THREE.Vector2(1, 1))
  const terrainEnabledUniform = uniform(0)
  // Absolute water surface Y in world space. Mirrors `mesh.position.y`,
  // which `main.ts` sets from `track.water.height`. Used to compute
  // `waterDepth = waterY − terrainY` for shoaling + surf.
  const waterYUniform = uniform(0)
  // Wave amplitude reaches full strength by this many meters of depth and
  // smoothly fades to zero at the waterline (depth = 0). 3 m is the user-
  // selected "balanced" setting — reliably eliminates clipping while
  // keeping waves visible in mid-shallows.
  const SHOAL_FADE_DEPTH = 3.0

  // Bike slot uniform array. Each vec4 = (px, pz, vx, vz). Inactive slots
  // are parked at INACTIVE_FAR so their Gaussian + wake fall off to zero.
  // Velocity is stored UNWEIGHTED — `weights[i]` is the separate fade
  // multiplier (so that wake amplitude scales linearly with weight while
  // direction stays accurate even at small weights).
  const bikeSlots: THREE.Vector4[] = []
  const bikeWeights: number[] = []
  for (let i = 0; i < MAX_BIKES; i++) {
    bikeSlots.push(new THREE.Vector4(INACTIVE_FAR, INACTIVE_FAR, 0, 0))
    bikeWeights.push(0)
  }
  const bikesUniform = uniformArray(bikeSlots, 'vec4')
  const weightsUniform = uniformArray(bikeWeights, 'float')

  type WaveConst = {
    k: number
    omega: number
    dirX: number
    dirZ: number
    amp: number
    phase: number
    /** Per-wave steepness coefficient (multiplied at runtime by the global
     * `steepnessUniform`). Higher values pinch the wave's crest laterally;
     * 0 falls back to a pure heightfield (no horizontal displacement).
     * Tuned per-wave so chops are sharper (more "ridge"-like) than the
     * long swells (which stay rolling). */
    qBase: number
  }
  // Per-wave Q defaults — index-aligned to defaultWaves(): two long swells,
  // four chop scales. Swells stay gentle; chops get sharp ridges.
  const Q_BASE_DEFAULTS = [0.35, 0.35, 0.85, 0.95, 1.0, 1.0]
  // Two paths into the same `waveConsts` shape: Gerstner mode reads
  // hand-tuned (wavelength, speed, dir, amp, phase) directly; spectrum
  // mode converts top-K Phillips modes to the same shape via the math
  // in `spectrum-to-gerstner.ts`. Spectrum modes get `qBase = 0` (pure
  // heightfield, no horizontal pinching) — Tessendorf-style choppy
  // displacement is a Phase A2 follow-up. The shader code that
  // consumes `waveConsts` is identical regardless of source.
  const waveConsts: WaveConst[] =
    field.kind === 'spectrum'
      ? spectrumModesToGerstnerShape(field.spectrum).map((m) => ({
          k: m.k,
          omega: m.omega,
          dirX: m.dirX,
          dirZ: m.dirZ,
          amp: m.amp,
          phase: m.phase,
          qBase: 0,
        }))
      : field.waves.map((w, i) => {
          const k = (2 * Math.PI) / w.wavelength
          return {
            k,
            omega: w.speed * k,
            dirX: w.dirX,
            dirZ: w.dirZ,
            amp: w.amplitude,
            phase: w.phase,
            qBase: Q_BASE_DEFAULTS[i] ?? 0.7,
          }
        })

  // Gerstner — heightfield part: returns vec3(y, dy/dx, dy/dz). These are the
  // same values you'd get from a vertical-only sum of sines, used both for the
  // wave's vertical displacement and for the x/z components of the surface
  // normal (cosine slopes). Waves are unrolled at build time. Per-wave amp
  // is multiplied by `swellScaleUniform` (waves 0–1) or `chopScaleUniform`
  // (waves 2–5) so the debug menu can rebalance swell vs chop live.
  const gerstnerHeight = Fn(([x, z, t]: [unknown, unknown, unknown]) => {
    const xN = x as ReturnType<typeof float>
    const zN = z as ReturnType<typeof float>
    const tN = t as ReturnType<typeof float>
    const y = float(0).toVar()
    const dydx = float(0).toVar()
    const dydz = float(0).toVar()
    for (let i = 0; i < waveConsts.length; i++) {
      const w = waveConsts[i]!
      const ampScale = SWELL_INDICES.has(i) ? swellScaleUniform : chopScaleUniform
      const phase = float(w.k * w.dirX)
        .mul(xN)
        .add(float(w.k * w.dirZ).mul(zN))
        .sub(tN.mul(w.omega))
        .add(float(w.phase))
      const s = sin(phase)
      const c = cos(phase)
      y.addAssign(s.mul(w.amp).mul(ampScale))
      dydx.addAssign(c.mul(w.amp * w.k * w.dirX).mul(ampScale))
      dydz.addAssign(c.mul(w.amp * w.k * w.dirZ).mul(ampScale))
    }
    return vec3(y, dydx, dydz)
  })

  // Gerstner — horizontal-displacement part: returns vec3(dx, dz, qSum).
  // The horizontal displacement is what produces the SoT-style pinched
  // ridges (vs round bumps). qSum is the y-component reduction in the
  // normal formula (GPU Gems eq.13: N.y = 1 - Σ Q·k·A·sin(phase)).
  // Two-Fn split (rather than one monolithic Fn) is forced by TSL's single-
  // node return; the duplicated sin/cos per wave is trivial on a real GPU.
  // With Q=0 (`?water=classic`) this Fn returns vec3(0, 0, 0) and the
  // surface collapses to the pure heightfield case.
  const gerstnerDisp = Fn(([x, z, t]: [unknown, unknown, unknown]) => {
    const xN = x as ReturnType<typeof float>
    const zN = z as ReturnType<typeof float>
    const tN = t as ReturnType<typeof float>
    const dx = float(0).toVar()
    const dz = float(0).toVar()
    const qSum = float(0).toVar()
    for (let i = 0; i < waveConsts.length; i++) {
      const w = waveConsts[i]!
      const ampScale = SWELL_INDICES.has(i) ? swellScaleUniform : chopScaleUniform
      const phase = float(w.k * w.dirX)
        .mul(xN)
        .add(float(w.k * w.dirZ).mul(zN))
        .sub(tN.mul(w.omega))
        .add(float(w.phase))
      const s = sin(phase)
      const c = cos(phase)
      const qScaled = steepnessUniform.mul(float(w.qBase))
      // Horizontal displacement: P.x += Q·A·D.x · cos(phase),
      //                          P.z += Q·A·D.z · cos(phase)
      dx.addAssign(
        qScaled
          .mul(float(w.amp * w.dirX))
          .mul(c)
          .mul(ampScale),
      )
      dz.addAssign(
        qScaled
          .mul(float(w.amp * w.dirZ))
          .mul(c)
          .mul(ampScale),
      )
      // Normal y-component reduction: Σ Q · k · A · sin(phase)
      qSum.addAssign(
        qScaled
          .mul(float(w.k * w.amp))
          .mul(s)
          .mul(ampScale),
      )
    }
    return vec3(dx, dz, qSum)
  })

  // Fused per-bike vertex contribution: hull dimple (subtractive) + wake
  // displacement (additive). We iterate slots ONCE per vertex and compute
  // r² ONCE per slot — the dimple uses a tight cull (≈ 9.6 m), the wake
  // uses a wider cull (40 m). Splitting into two Fns doubled the per-vertex
  // slot fetch + r² compute; the headless WebGL2 software fallback
  // (SwiftShader, used by Playwright) was tanking to ~3 fps. Fused, the
  // per-vertex base cost is one r², one mul-mul-add. Returns
  // vec3(deltaY, ddelta/dx, ddelta/dz) where dimple subtracts and wake
  // adds, so callers do `wave + bikeContrib`.
  //
  // Dimple:  -D · exp(-r² / R²)
  // Wake:    A · weight · gate(speed) · trans(perp) · ramp(b) · decay(b)
  //          · sin(K · behind − Ω · t)
  // where b = max(-(P − bike)·hat, 0), perp = |(P − bike) × hat|,
  // hat = v / |v|. Mirror of `sampleWakeFromSource` in wave-field.ts.
  const bikeSurfaceContrib = Fn(([x, z, t]: [unknown, unknown, unknown]) => {
    const xN = x as ReturnType<typeof float>
    const zN = z as ReturnType<typeof float>
    const tN = t as ReturnType<typeof float>
    const y = float(0).toVar()
    const dydx = float(0).toVar()
    const dydz = float(0).toVar()
    const invR2 = 1 / (BIKE_DIMPLE_R * BIKE_DIMPLE_R)
    for (let i = 0; i < MAX_BIKES; i++) {
      // TSL's UniformArrayElementNode types don't expose vec4 swizzles even
      // though the runtime proxy makes `.x`/`.y`/`.z`/`.w` work. Cast to
      // `any` so the build-time TS check stops complaining without us
      // losing the runtime ergonomics.
      // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle proxy
      const slot = bikesUniform.element(i) as any
      // biome-ignore lint/suspicious/noExplicitAny: TSL types lose precision here
      const dx = xN.sub(slot.x) as any
      // biome-ignore lint/suspicious/noExplicitAny: TSL types lose precision here
      const dz = zN.sub(slot.y) as any
      const r2 = dx.mul(dx).add(dz.mul(dz))
      // Wake cull is wider than dimple cull. Wrap both in the wake-radius
      // check so the common case (vertex far from this bike) skips
      // everything in one branch.
      If(r2.lessThan(float(WAKE_DISP_CULL_R_SQ)), () => {
        // ----- Dimple (only the close-in band) -----
        If(r2.lessThan(float(BIKE_DIMPLE_CULL_R_SQ)), () => {
          const e = exp(r2.mul(-invR2))
          const depth = e.mul(-BIKE_DIMPLE_DEPTH)
          y.addAssign(depth)
          // d(depth)/dx = depth · (-2 dx / R²) — note: depth is negative
          // here (dimple is subtractive), so the gradient sign also flips.
          dydx.addAssign(depth.mul(dx).mul(-2 * invR2))
          dydz.addAssign(depth.mul(dz).mul(-2 * invR2))
        })
        // ----- Wake (mirror of sampleWakeFromSource) -----
        // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle proxy
        const vx = slot.z as any
        // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle proxy
        const vz = slot.w as any
        const speed = sqrt(vx.mul(vx).add(vz.mul(vz)))
        const safeSpeed = max(speed, float(0.0001))
        const hatX = vx.div(safeSpeed)
        const hatZ = vz.div(safeSpeed)
        const parallel = dx.mul(hatX).add(dz.mul(hatZ))
        const behind = max(parallel.negate(), float(0))
        // Skip when sample is in front of the bike — wake only exists
        // behind. behind > 0 also rules out the bike's own location.
        If(behind.greaterThan(float(0)), () => {
          const perp = abs(dx.mul(hatZ).sub(dz.mul(hatX)))
          const speedGate = smoothstep(float(WAKE_SPEED_LOW), float(WAKE_SPEED_HIGH), speed)
          const wakeWidth = behind.mul(WAKE_HALF_ANGLE_TAN).add(float(WAKE_BASE_WIDTH))
          // Two-piece signed transverse profile (Kelvin-style V):
          //   inside V (perp < wakeWidth):   -cos(π · perp / wakeWidth)
          //                                   → -1 at axis (trough), +1 at edge (ridge)
          //   outside V (perp >= wakeWidth): linear fade 1 → 0 over halfwidth
          // Combined: `insidePart * fadeOut`. For perp <= wakeWidth, fadeOut=1
          // so the cosine dominates. For perp > wakeWidth, insidePart clamps
          // to +1 (cos(π) = -1, negated → 1) and fadeOut handles the falloff.
          const insideArg = min(perp, wakeWidth).div(wakeWidth).mul(Math.PI)
          const insidePart = cos(insideArg).negate()
          const fadeOut = max(
            float(0),
            float(1).sub(max(float(0), perp.sub(wakeWidth)).div(float(WAKE_EDGE_BELL_HALFWIDTH))),
          )
          const transverseSigned = insidePart.mul(fadeOut)
          const longRamp = float(1).sub(exp(behind.mul(-WAKE_LONG_RAMP)))
          const longDecay = exp(behind.mul(-WAKE_LONG_DECAY))
          // Transverse "scallops" (M9.35): mirrors sampleWakeFromSource.
          // sin(K · behind − ω · t) modulates the V's amplitude along its
          // length; the pattern drifts backward in the bike's frame as t
          // advances, giving the wake the live oscillating ridges of a
          // real Kelvin wake.
          const longPhase = tN.mul(-WAKE_TRANS_OMEGA).add(behind.mul(WAKE_TRANS_K))
          const transverseMod = float(1).add(sin(longPhase).mul(WAKE_TRANS_AMP))
          // biome-ignore lint/suspicious/noExplicitAny: TSL UniformArrayElementNode lacks float-typing in TS
          const weight = weightsUniform.element(i) as any
          const amp = float(WAKE_DISP_AMP)
            .mul(weight)
            .mul(speedGate)
            .mul(longRamp)
            .mul(longDecay)
            .mul(transverseMod)
          y.addAssign(amp.mul(transverseSigned))
          // Approximate gradient: dominated by the perp direction (the V
          // shape's slope). Use the inside-V slope as a uniform-ish
          // approximation across the wake — visible shading on the V's
          // inner trough wall, less accurate at the outer fade. Drops the
          // longitudinal-decay cross-term (small effect at typical scale).
          // ∂profile/∂perp ≈ (π / wakeWidth) · sin(π · perp / wakeWidth) inside V.
          const dProfileDPerp = sin(insideArg).mul(float(Math.PI).div(wakeWidth))
          // ∂perp/∂x = sign(dx·hatZ − dz·hatX) · hatZ. We don't have a
          // built-in sign() — recover it as c / |c| where |c| = perp (with
          // a small floor to avoid div-by-zero on-axis).
          const c = dx.mul(hatZ).sub(dz.mul(hatX))
          const signC = c.div(max(perp, float(0.0001)))
          const dPerpDx = signC.mul(hatZ)
          const dPerpDz = signC.mul(hatX).negate()
          const ampDProfile = amp.mul(dProfileDPerp)
          dydx.addAssign(ampDProfile.mul(dPerpDx))
          dydz.addAssign(ampDProfile.mul(dPerpDz))
        })
      })
    }
    return vec3(y, dydx, dydz)
  })

  // Vertex stage: ambient Gerstner waves + fused per-bike contribution
  // (hull dimple subtracts, wake adds — see `bikeSurfaceContrib` for the
  // sign handling). The mesh slides under the camera each frame, so we
  // sample the wave/wake field at WORLD coords (`positionLocal + meshOrigin`)
  // — that keeps the surface continuous in world space even as the mesh's
  // local origin moves.
  //
  // We use the standard Gerstner formulation (GPU Gems Ch.1) — vertices
  // are displaced both horizontally and vertically, so crests pinch into
  // ridges instead of being round bumps:
  //
  //   P.x = x0 + Σ Q_i · A_i · D_i.x · cos(phase_i)
  //   P.y = y0 + Σ A_i · sin(phase_i)
  //   P.z = z0 + Σ Q_i · A_i · D_i.z · cos(phase_i)
  //
  // The closed-form normal from GPU Gems eq. 13:
  //   N = (-Σ A·k·D.x·cos, 1 - Σ Q·k·A·sin, -Σ A·k·D.z·cos)
  //
  // Note that the heightfield slopes (Σ A·k·D.x·cos) are the SAME values
  // we'd compute for a pure heightfield Gerstner; the only new term in
  // the normal is the y-component reduction (`qSum`). With Q=0 (classic
  // mode) the formula collapses exactly to the old heightfield normal.
  //
  // We compute the gradients here at the vertex stage and forward them
  // via `varying(...)` so the fragment can build the surface normal from
  // interpolated values instead of re-running the Gerstner sum per pixel.
  // Per-vertex + interp is visually indistinguishable here because the
  // mesh resolution (≈ 0.6 m) is finer than the wave gradient.
  //
  // Physics-side note: wave-field.ts (CPU buoyancy) keeps the simpler
  // vertical-only formulation. With low-to-moderate Q, the rendered
  // surface and the buoyancy field stay within ~0.4 m of each other
  // horizontally — well below visible disconnect for a hoverbike skimming
  // the surface. If steepness is pushed past 1, consider a Newton iteration
  // on the CPU side to recover the rest position from world XZ.
  const worldX = positionLocal.x.add(meshOriginX)
  const worldZ = positionLocal.z.add(meshOriginZ)
  // Big-wave source. Two paths produce the same `vec3(y, dy/dx, dy/dz)`
  // height + slope and `vec3(dx, dz, qSum)` displacement triples; the
  // surrounding shoaling / wake / bike-contrib code is shape-agnostic
  // so it works unchanged across paths.
  //
  //   A1b / Gerstner default — sums the unrolled `waveConsts` array
  //     analytically per vertex. Either the legacy 6-wave Gerstner
  //     preset or 32 top-K Phillips modes converted to Gerstner shape
  //     via `spectrum-to-gerstner.ts`. Cheap per vertex, peaks at
  //     ~24 trig calls.
  //
  //   A2 / GPU IFFT — samples the displacement + slope textures the
  //     compute kernel writes each frame from the full N² Phillips
  //     spectrum. Same cost per vertex regardless of N; spectrum
  //     budget moves from per-vertex-unroll to per-frame compute.
  //     Captures ALL spectral content (no top-K truncation), which is
  //     the visible payoff of the FFT migration.
  //
  // `qSum` (Tessendorf-style normal-Y reduction from horizontal
  // pinching) is Gerstner-specific math; the FFT path leaves it at 0,
  // so the normal collapses to the standard heightfield form
  // `normalize(−dydx, 1, −dydz)`. That's the right normal for an
  // FFT-displaced surface since the displacement and slope come from
  // the same spectrum — the heightfield slope already encodes the
  // surface tilt at the displaced vertex's logical position.
  // Cast through `unknown` so the two branches produce the same TSL
  // node type for downstream `.x`/`.y`/`.z` swizzling. The shapes match
  // — both return `vec3` — but TypeScript narrows `vec3(literal, ...)`
  // and `vec3(node, ...)` differently and the union is too narrow for
  // the downstream `varying(...)` plumbing to typecheck.
  type Vec3Like = ReturnType<typeof gerstnerHeight>
  let vertexHeight: Vec3Like
  let vertexDisp: Vec3Like
  // A3 — Jacobian sampled alongside the displacement triple when on the
  // FFT path; left at the calm-surface sentinel (J=1) otherwise. The
  // fragment-stage foam mixer reads this through a varying and turns
  // it into a breaking-wave foam term (see `foldFoamFft` below). On
  // the analytic path qSum already gates fold-style foam, so the
  // sentinel keeps the FFT branch dead-code-free without disturbing
  // the existing path.
  // biome-ignore lint/suspicious/noExplicitAny: TSL float node
  let vertexJacobian: any = float(1)
  if (gpuDisplacementHandle && gpuChopHandle && gpuSwellHandle) {
    // Cascade 0 — wind sea. Sampled at worldXZ / 90m.
    const windUv = vec2(worldX, worldZ).div(float(gpuDisplacementHandle.tileSize))
    // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
    const windDisp = texture(gpuDisplacementHandle.displacementTexture, windUv) as any
    // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
    const windSlope = texture(gpuDisplacementHandle.slopeTexture, windUv) as any
    // Cascade 1 — chop. Sampled at worldXZ / 22m.
    const chopUv = vec2(worldX, worldZ).div(float(gpuChopHandle.tileSize))
    // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
    const chopDisp = texture(gpuChopHandle.displacementTexture, chopUv) as any
    // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
    const chopSlope = texture(gpuChopHandle.slopeTexture, chopUv) as any
    // Cascade 2 — long-period swell. Sampled at worldXZ / 250m.
    const longUv = vec2(worldX, worldZ).div(float(gpuSwellHandle.tileSize))
    // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
    const longDisp = texture(gpuSwellHandle.displacementTexture, longUv) as any
    // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
    const longSlope = texture(gpuSwellHandle.slopeTexture, longUv) as any
    // Sum height + slopes + horizontal displacement across all 3
    // cascades. R = height, G = Dx, B = Dz, A = Jacobian.
    vertexHeight = vec3(
      windDisp.r.add(chopDisp.r).add(longDisp.r),
      windSlope.r.add(chopSlope.r).add(longSlope.r),
      windSlope.g.add(chopSlope.g).add(longSlope.g),
    ) as unknown as Vec3Like
    vertexDisp = vec3(
      windDisp.g.add(chopDisp.g).add(longDisp.g),
      windDisp.b.add(chopDisp.b).add(longDisp.b),
      float(0),
    ) as unknown as Vec3Like
    // Foam takes the MIN Jacobian across cascades — wherever any
    // cascade folds (J<0), foam should appear. Using min preserves
    // the "fold = breaking" interpretation regardless of which
    // wavelength band is responsible.
    vertexJacobian = min(min(windDisp.a, chopDisp.a), longDisp.a)
  } else {
    vertexHeight = gerstnerHeight(worldX, worldZ, tNode)
    vertexDisp = gerstnerDisp(worldX, worldZ, tNode)
  }
  const vertexBike = bikeSurfaceContrib(worldX, worldZ, tNode)
  // vertexHeight = vec3(y, dy/dx, dy/dz)
  // vertexDisp   = vec3(dx, dz, qSum)
  // vertexBike   = vec3(deltaY, ddelta/dx, ddelta/dz)

  // Terrain-driven shoaling. Sample the baked top-down terrain heightmap
  // at this vertex's world XZ, compute vertical water depth, and fade the
  // wave displacement smoothly to zero as depth → 0. This is the geometric
  // fix for wave crests poking up through shoreline / seabed geometry:
  // wherever the water plane sits above terrain, depth is positive and
  // waves swing freely; wherever terrain rises into or above the water,
  // depth pinches toward zero and the waves flatten out. Real shoaling
  // physics actually steepens waves before breaking — that's modeled in
  // the fragment surf foam below instead, where it shows up as visible
  // breakers without risking geometry clipping.
  //
  // While `terrainEnabledUniform = 0` (no heightmap installed yet, e.g.
  // editor mode) we force `effectiveTerrainY` to the deep sentinel so the
  // shoal factor reads 1 and the original full-amplitude behaviour stays
  // intact. Out-of-AABB sampling falls back the same way: water past the
  // baked terrain area (open-horizon backdrop) reads as deep ocean.
  const tMin = terrainMinUniform
  const tMax = terrainMaxUniform
  const terrainU = worldX.sub(tMin.x).div(tMax.x.sub(tMin.x))
  const terrainV = worldZ.sub(tMin.y).div(tMax.y.sub(tMin.y))
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
  const terrainSample = texture(terrainHeightTex, vec2(terrainU, terrainV)) as any
  const sampledTerrainY = terrainSample.r
  const inU = float(1)
    .sub(smoothstep(float(0.998), float(1.002), terrainU))
    .mul(smoothstep(float(-0.002), float(0.002), terrainU))
  const inV = float(1)
    .sub(smoothstep(float(0.998), float(1.002), terrainV))
    .mul(smoothstep(float(-0.002), float(0.002), terrainV))
  const inBounds = inU.mul(inV).mul(terrainEnabledUniform)
  const effectiveTerrainY = mix(float(-10000), sampledTerrainY, inBounds)
  const vertexWaterDepth = waterYUniform.sub(effectiveTerrainY)
  // Smooth fade from "no waves" at depth ≤ 0 to "full waves" at the chosen
  // shoaling depth. Squared falloff on the inner side so the tail of
  // attenuation reads as a gentle calming rather than an abrupt edge.
  const shoalRaw = clamp(vertexWaterDepth.div(float(SHOAL_FADE_DEPTH)), float(0), float(1))
  const shoalFactor = shoalRaw.mul(shoalRaw)

  // Apply the shoaling attenuation to BOTH the ambient swell/chop and the
  // horizontal Gerstner displacement. Wake (bikeSurfaceContrib) is left at
  // full strength: the bike is always in deep-enough water to ride, and
  // the wake is what gives the racing surface its sense of motion. Slopes
  // get the same multiplier so the surface normal stays consistent with
  // the attenuated height — without this, calm shallows would still
  // shimmer with crest-strength sun glints.
  const attenAmbient = vertexHeight.x.mul(shoalFactor)
  const attenDydx = vertexHeight.y.mul(shoalFactor)
  const attenDydz = vertexHeight.z.mul(shoalFactor)
  const attenDispX = vertexDisp.x.mul(shoalFactor)
  const attenDispZ = vertexDisp.y.mul(shoalFactor)
  const attenQSum = vertexDisp.z.mul(shoalFactor)

  const totalHeight = attenAmbient.add(vertexBike.x)
  const totalDydx = attenDydx.add(vertexBike.y)
  const totalDydz = attenDydz.add(vertexBike.z)

  // Foam accumulator (stateless, no render targets needed).
  //
  // The trick: waves are deterministic functions of (x, z, t), so "did this
  // position have a crest 0.5s ago?" reduces to evaluating gerstner(x, z,
  // t-0.5). We sample the foam-trigger signal (slopeFoam OR foldFoam) at
  // N time steps in the recent past, decay each by exp(-i·dt·k), and take
  // the max. The result: foam appears AT a crest and lingers behind for
  // ~1s as the wave moves on, instead of vanishing the moment the crest
  // passes. That's what gives ocean foam its "trail" character — the
  // crest moves on but the whitecap doesn't.
  //
  // This is the cheap stateless cousin of SoT's persistent foam texture
  // (which uses an FFT Jacobian + render-target ping-pong). For our
  // arcade racer, 4 time samples × 6 waves × 2 trig per call ≈ 96 trig
  // per vertex on top of the existing 24 — well within the per-frame
  // budget on any real GPU.
  //
  // Wakes are NOT included in the time history (would need historical
  // bike positions). Wake foam stays current-time only via bikeFoam below.
  // Off in classic mode for clean A/B comparison.
  const foamAccumulator = Fn(([x, z, t]: [unknown, unknown, unknown]) => {
    const xN = x as ReturnType<typeof float>
    const zN = z as ReturnType<typeof float>
    const tN = t as ReturnType<typeof float>
    const maxFoam = float(0).toVar()
    const NUM_SAMPLES = 4
    const DT = 0.25
    const DECAY_RATE = 1.5 // half-life ≈ 0.46s
    for (let i = 0; i < NUM_SAMPLES; i++) {
      const dt = i * DT
      const tShifted = tN.sub(float(dt))
      const h = gerstnerHeight(xN, zN, tShifted)
      const d = gerstnerDisp(xN, zN, tShifted)
      // h.y, h.z are dy/dx, dy/dz at this time sample.
      const slope = sqrt(h.y.mul(h.y).add(h.z.mul(h.z)))
      // Foam triggers use a power curve (slope^2 stretched) instead of
      // smoothstep. The smoothstep had a hard zero plateau below the
      // lower threshold, so adjacent vertices straddling the threshold
      // produced visible foam/no-foam edges on wave faces. Power curve
      // is smooth everywhere — even tiny slopes produce a wisp of foam
      // that fades continuously to zero — so per-vertex transitions
      // never snap on or off. The temporal max() of this curve over
      // four past time samples still gives lingering foam trails behind
      // passing crests.
      const slopeFoam = pow(clamp(slope.mul(float(1.4)), float(0), float(1)), float(2.0))
      const foldFoam = pow(
        clamp(max(float(0), d.z).mul(float(3.0)), float(0), float(1)),
        float(2.0),
      )
      const localFoam = max(slopeFoam, foldFoam)
      const decay = float(Math.exp(-dt * DECAY_RATE))
      maxFoam.assign(max(maxFoam, localFoam.mul(decay)))
    }
    return maxFoam
  })
  // Foam accumulator is attenuated by the same shoaling factor so the
  // existing slope/fold-driven foam doesn't keep firing on flat shallows
  // where wave geometry has been damped to zero.
  //
  // FFT path explicitly skips the accumulator — it re-evaluates
  // gerstnerHeight/Disp at 4 past time samples, and gerstnerHeight
  // unrolls over `waveConsts.length` modes (= top-K Phillips converted
  // to Gerstner shape). At top-K=128 the unrolled foam shader becomes
  // huge (4 × 128 × 2 trig pairs per vertex × 147k vertices) and on
  // some drivers hangs the kernel during compile/dispatch. On the FFT
  // path the temporal-trail role is already covered by the Jacobian
  // foam path + pixelFoam mix, so we set the accumulator to 0 and let
  // the shader stay small.
  const vertexFoamAccum =
    isClassic || useGpuDisplacement
      ? float(0)
      : foamAccumulator(worldX, worldZ, tNode).mul(shoalFactor)

  // positionNode is in mesh-local space; the mesh translation
  // (mesh.position.x/z = camera XZ) carries the vertex out to world.
  // Adding the Gerstner horizontal displacement to positionLocal.x/z applies
  // the pinching in mesh-local space — equivalent to world-space because
  // the mesh transform is a pure translation. Horizontal disp is shoaling-
  // attenuated alongside the vertical, so shallow water also stops
  // pinching laterally toward terrain.
  const positionNode = vec3(
    positionLocal.x.add(attenDispX),
    totalHeight,
    positionLocal.z.add(attenDispZ),
  )

  // Forward height + gradient + qSum + accumulated foam to fragment via
  // varyings. The framework marks these as vertex-stage and inserts the
  // interpolated reads. Extra varyings carry the depth + shoaling factor
  // so the fragment surf foam can pulse with incoming wave crests.
  const heightFrag = varying(totalHeight)
  const dydx = varying(totalDydx)
  const dydz = varying(totalDydz)
  const qSumFrag = varying(attenQSum)
  const foamAccumFrag = varying(vertexFoamAccum)
  const waterDepthFrag = varying(vertexWaterDepth)
  // A3 — Jacobian forwarded to fragment for breaking-wave foam. Only
  // meaningful on the FFT path (sentinel J=1 elsewhere); the fragment
  // foam mixer gates on `useGpuDisplacement` so the analytic branch
  // pays nothing for the unused varying.
  const jacobianFrag = varying(vertexJacobian)
  // Wave-peak mask — the magnitude of the horizontal Tessendorf
  // displacement (λ·Dx, λ·Dz) already in `attenDispX`/`attenDispZ`.
  // Sea of Thieves' SIGGRAPH 2018 talk credits this signal as the
  // gate for their subsurface-scattering color blend: choppy peaks
  // pinch large displacements, and those are the spots where light
  // travels a short path through the wave, so they read as bright
  // scatter. We expose it as a varying so the fragment can use it
  // to push scatter on pinched crests independent of raw height
  // (a flat-but-pinching wave face is a peak too). Sentinel 0 off
  // the FFT path so the additive blend is a no-op there.
  const peakSignal = useGpuDisplacement
    ? attenDispX.mul(attenDispX).add(attenDispZ.mul(attenDispZ)).sqrt()
    : float(0)
  const peakMaskFrag = varying(peakSignal)
  // Pre-attenuation wave height — the height the swells/chops WOULD have
  // had at this position if shoaling didn't shrink them. The fragment surf
  // pulse reads this so breakers fire with the natural cadence of incoming
  // crests even where geometry has gone flat.
  const ambientHeightFrag = varying(vertexHeight.x)

  // Sub-Gerstner detail-normal cascades. Two world-XZ-aligned samples of the
  // procedural wave-detail texture at different tile sizes + scroll speeds,
  // their decoded slopes summed into the heightfield gradient before the
  // normal is built. This is the "FFT-lite" layer: it fills in the chop
  // below the 5.5 m wavelength floor of the Gerstner set, with hardware
  // mipmap filtering providing distance anti-aliasing for free.
  //
  // Cascade A — 6 m tile, slow scroll along the swell direction. Reads as
  // medium chop riding on the back of each Gerstner wave.
  // Cascade B — 1.5 m tile, faster scroll on a near-perpendicular axis. The
  // sub-meter ripple texture that catches sun glints and breaks up the
  // mirror-surface look at close range.
  //
  // Strengths are tuned so the combined slope contribution rarely exceeds
  // ~0.35 (well below the analytic Gerstner peaks of ~1.0), so the detail
  // reads as surface texture without erasing the silhouette of the big waves.
  // Detail-cascade texture provider. Three paths, mutually exclusive:
  //   1. procedural    — legacy 22-sine analytic bake (default).
  //   2. fft + WebGL2  — static Phillips IFFT bake (C2 fallback).
  //   3. fft + WebGPU  — live Phillips IFFT compute (C3 default).
  // (3) writes its slopes into the StorageTexture each frame from the
  // `mesh.onBeforeRender` hook further down; the shader code reading
  // `detailTex` is identical across all three since the encoding +
  // wrap-mode + format match.
  const gpuFftHandle = useGpuFft ? createGpuOceanFft() : null
  const detailTex: THREE.Texture = gpuFftHandle
    ? gpuFftHandle.outputTexture
    : getWaveDetailNormalTexture(detailMode)
  // Tiles enlarged from (6 m, 1.5 m) → (11 m, 2 m) and the UV axes rotated
  // by non-perpendicular angles (+23° / -37°) so the texture's natural
  // pattern doesn't read as obvious world-grid-aligned strips. Two layers
  // of mitigation against the "tiling repetition" complaint: larger tiles
  // mean fewer full repeats visible in a single viewport, and the off-axis
  // rotation breaks the cross-hatch beat that two axis-aligned cascades at
  // different scales would otherwise produce.
  //
  // Slope scales bumped proportionally so the peak world-space slope
  // contribution stays in the same range (~0.21 cascade A, ~0.30 cascade B)
  // despite the larger tile size. Bake normalization pegs decoded values
  // at ±0.5, so peak ≈ 0.5 · (SCALE / TILE).
  const DETAIL_A_TILE = 11.0
  const DETAIL_B_TILE = 2.0
  const DETAIL_A_SCALE = 4.5
  const DETAIL_B_SCALE = 1.2
  const A_ANGLE = 0.4
  const B_ANGLE = -0.65
  const aCos = Math.cos(A_ANGLE)
  const aSin = Math.sin(A_ANGLE)
  const bCos = Math.cos(B_ANGLE)
  const bSin = Math.sin(B_ANGLE)

  // Domain warping. Sample the detail texture itself at a very low
  // frequency (35 m tile) to produce a slow, non-periodic noise field,
  // then use that to displace the world-XZ coords BEFORE they're rotated
  // into each cascade's local frame. Both cascades now read at positions
  // that drift on a 35 m scale, so even at the same world coordinate the
  // cascade pattern won't align with itself repeatedly. This is the
  // standard FFT-cascades-lite trick for hiding strict tile periodicity
  // without piling on additional cascades, and at the cost of just one
  // extra texture sample (which the mip filter resolves to a high mip
  // for free — slow noise reads from a low-resolution mip).
  const warpUv = positionWorld.xz.div(float(35))
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle types
  const warpSample = texture(detailTex, warpUv) as any
  const warpX = warpSample.r.sub(float(0.5)).mul(float(2.5))
  const warpZ = warpSample.g.sub(float(0.5)).mul(float(2.5))
  const warpedX = positionWorld.x.add(warpX)
  const warpedZ = positionWorld.z.add(warpZ)

  // Grazing-angle fade for the detail cascades. At near-horizon viewing,
  // the texture's intrinsic pattern reads as visible diagonal striations
  // on wave faces (the "stair-stepping" artifact in side-view screenshots
  // — a side effect of viewing a fine-grained slope perturbation across a
  // long oblique path through pixel-space). Fade detail toward zero at
  // grazing so the horizon line is carried purely by the big-shape
  // analytic-Gerstner silhouette + the foam mask. `viewDir.y` is a clean
  // proxy that doesn't depend on the surface normal (no feedback loop
  // with detailSlope, which feeds INTO the normal).
  const viewDirEarly = normalize(cameraPosition.sub(positionWorld))
  const verticalView = max(float(0), viewDirEarly.y)
  const detailGrazeFade = smoothstep(float(0.1), float(0.5), verticalView)

  // Rotate WARPED world XZ into each cascade's local frame, then divide
  // by tile size and offset by scroll. The scroll directions stay in
  // tile-local space, so cascade A's scroll runs along its own rotated +X
  // and cascade B's runs along its own rotated -X — adds further temporal
  // variety on top of the off-axis spatial layout.
  const wxA0 = warpedX.mul(float(aCos)).sub(warpedZ.mul(float(aSin)))
  const wzA0 = warpedX.mul(float(aSin)).add(warpedZ.mul(float(aCos)))
  const detailUvA = vec2(wxA0, wzA0)
    .div(float(DETAIL_A_TILE))
    .add(vec2(tNode.mul(float(0.04)), tNode.mul(float(-0.027))))
  const wxB0 = warpedX.mul(float(bCos)).sub(warpedZ.mul(float(bSin)))
  const wzB0 = warpedX.mul(float(bSin)).add(warpedZ.mul(float(bCos)))
  const detailUvB = vec2(wxB0, wzB0)
    .div(float(DETAIL_B_TILE))
    .add(vec2(tNode.mul(float(-0.11)), tNode.mul(float(0.08))))
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle types
  const detailSampleA = texture(detailTex, detailUvA) as any
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle types
  const detailSampleB = texture(detailTex, detailUvB) as any
  // Decoded slopes are in TILE-LOCAL frame (because the UV was rotated).
  // Rotate them back into world XZ via the inverse rotation matrix
  // (transpose of the forward rotation) so they add correctly to the
  // analytic Gerstner slopes which live in world space.
  const rsAx = detailSampleA.r.mul(float(2)).sub(float(1))
  const rsAy = detailSampleA.g.mul(float(2)).sub(float(1))
  const detailSlopeA = vec2(
    rsAx.mul(float(aCos)).add(rsAy.mul(float(aSin))),
    rsAx.mul(float(-aSin)).add(rsAy.mul(float(aCos))),
  ).mul(float(DETAIL_A_SCALE).div(float(DETAIL_A_TILE)))
  const rsBx = detailSampleB.r.mul(float(2)).sub(float(1))
  const rsBy = detailSampleB.g.mul(float(2)).sub(float(1))
  const detailSlopeB = vec2(
    rsBx.mul(float(bCos)).add(rsBy.mul(float(bSin))),
    rsBx.mul(float(-bSin)).add(rsBy.mul(float(bCos))),
  ).mul(float(DETAIL_B_SCALE).div(float(DETAIL_B_TILE)))
  const detailSlope = detailSlopeA.add(detailSlopeB).mul(detailStrengthUniform).mul(detailGrazeFade)

  // Camera-to-fragment distance. Used by the analytic-slope flatten below,
  // the hash-noise distance fades (foam / shoreline / sparkle), the planar-
  // reflection distortion taper, and the aerial-perspective haze mix.
  // Computed once and reused everywhere.
  const camDist = cameraPosition.sub(positionWorld).length()

  // Flatten the analytic Gerstner slopes toward zero with distance. The
  // Gerstner gradients are high-frequency relative to camera-space
  // wavelength past ~25 m at 1080p — without flattening, the PBR specular
  // lobe picks up pixel-sized glints that flicker frame-to-frame. The
  // detail-normal cascades DON'T need this lerp: hardware mipmap filtering
  // already collapses their slopes toward zero at distance. So we flatten
  // analytic slopes only, then add detail on top — the close-in band keeps
  // both layers, the horizon band keeps just the (filtered) detail.
  const analyticFlatten = smoothstep(float(25), float(140), camDist)
  const analyticDydxFlat = mix(dydx, float(0), analyticFlatten)
  const analyticDydzFlat = mix(dydz, float(0), analyticFlatten)
  const qSumFlat = mix(qSumFrag, float(0), analyticFlatten)

  // Combined heightfield gradient (analytic-flattened + detail). Used by
  // the normal, by the reflection distortion, and by the slope-driven foam
  // below.
  const effDydx = analyticDydxFlat.add(detailSlope.x)
  const effDydz = analyticDydzFlat.add(detailSlope.y)

  // GPU Gems eq.13 normal: (-Σdy/dx, 1 - Σ Q·k·A·sin, -Σdy/dz).
  // The wake's gradients are folded into dydx/dydz; the wake has no
  // horizontal-displacement term so it doesn't contribute to qSum. The
  // analytic-slope flatten + detail mip-LOD give us all the distance AA
  // we need at the slope level — the Toksvig-style roughness boost on
  // `roughnessNode` (below) mops up any residual per-pixel normal
  // variance the lighting model would otherwise alias on. So rawNormal
  // IS the per-pixel normal — no extra flatten pass needed.
  const rawNormal = normalize(vec3(effDydx.negate(), float(1).sub(qSumFlat), effDydz.negate()))
  const normalNode = rawNormal

  // View vector + ndotv computed once and reused by both the scatter blend
  // (base color) and the fresnel sky-tint emissive below.
  const viewDir = normalize(cameraPosition.sub(positionWorld))
  const ndotv = max(dot(normalNode, viewDir), float(0))

  // Scene-depth sample. The texture is populated via
  // `renderer.copyFramebufferToTexture` from this mesh's `onBeforeRender`
  // (near the bottom of the file), AFTER all opaque objects have been
  // encoded into the active pass — that's the moment when the depth
  // attachment reflects "scene minus water". `closeness` derived from it
  // feeds two consumers:
  //   1. The shallow-water tint in `baseColor` below (this block),
  //   2. The shoreline intersection foam further down in the fragment.
  //
  // Why our own DepthTexture instead of Three.js's
  // `viewportDepthTexture()`: that helper's `updateBefore` fires once
  // per render at the first node referencing it — under WebGPURenderer
  // that resolves to BEFORE any opaque has been encoded into the active
  // pass, so the texture captures a cleared depth buffer (= 1.0
  // everywhere). With the helper, the depth compare reads the scene as
  // "all at the far plane" and the shallow tint + intersection foam
  // never fire.
  const sceneDepthTexture = new THREE.DepthTexture(1, 1)
  sceneDepthTexture.name = 'water:sceneDepth'
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
  const sceneDepthSampleNode = texture(sceneDepthTexture, screenUV) as any
  const sceneDepthRaw = sceneDepthSampleNode.r
  const sceneViewZ = perspectiveDepthToViewZ(sceneDepthRaw, cameraNear, cameraFar)
  const waterViewZ = positionView.z
  // Positive = terrain is BEHIND water (deeper into the scene from the
  // camera's POV). View-space Z is negative for points in front of the
  // camera, so waterViewZ − sceneViewZ is positive when sceneViewZ is
  // more negative. This is the distance along the VIEW RAY between the
  // water surface and the seabed / shoreline terrain — at grazing angles
  // that path is much longer than the vertical depth, which is exactly
  // the Beer-Lambert path-length we want for absorption tinting.
  const closenessSigned = waterViewZ.sub(sceneViewZ)
  const closeness = max(float(0), closenessSigned)

  // Albedo: two-color scatter blend.
  //
  // Sea-of-Thieves-style: a deep teal in troughs blends to a bright
  // cyan-green "scatter color" on crests, on grazing-view-angle samples,
  // AND on waves backlit by the sun. The three contributions stack:
  //
  //   heightFactor   — crest faces scatter, troughs don't
  //   viewFactor     — sub-surface scattering makes wave bodies brightest
  //                    when viewed nearly along the surface (grazing)
  //   sunBackscatter — light passing through a wave from sun-side to eye-
  //                    side; peaks when the line of sight points roughly
  //                    toward the sun
  //
  // Classic mode (`?water=classic`) keeps the original blue→cyan mix with
  // pure height-driven blending for A/B comparison.
  const heightNorm = smoothstep(float(-0.9), float(0.9), heightFrag)
  // Scatter ramps from -0.5 to 0.5 m of wave height (was -0.7 to 0.8) so
  // mid-height wave faces — not just the sharpest peaks — carry visible
  // scatter color. Pushes the wave silhouettes from "soft blanket" toward
  // SoT's "punchy deep-trough-to-bright-crest gradient" character.
  const heightFactor = isClassic ? heightNorm : smoothstep(float(-0.5), float(0.5), heightFrag)
  // Deep + scatter pushed toward more saturated SoT tones. The original v2
  // teal worked under midday sun but read as washed-out cream/beige under
  // the day-night cycle's sunset palette (warm horizon haze + warm sun-tint
  // emissive desaturated the surface). Punchier deep navy + brighter cyan-
  // green scatter survives the warm-sky desaturation and keeps the water
  // reading as ocean rather than fabric. Classic preset unchanged for A/B.
  const deepColor = isClassic ? vec3(0.04, 0.18, 0.4) : vec3(0.01, 0.09, 0.2)
  // Two distinct "scatter" colors per Sea of Thieves' three-color
  // albedo system (deep + scatter + subsurface). The height-driven
  // `scatterColor` is the legacy SoT-style cyan-green that lights up
  // the upper half of wave faces — neutral teal so it works under
  // any sky color. The peak-mask SSS color is more YELLOW-GREEN —
  // that's the SoT "lit from within" glow that fires specifically
  // where the Tessendorf horizontal pinch is large (i.e. light has
  // a SHORT path through the wave because it's about to break).
  // The yellow lift comes from the warmer end of the visible
  // spectrum getting absorbed less than the cooler end at short
  // travel distances — the same Rayleigh / Beer-Lambert physics
  // that makes shallow ocean read turquoise instead of navy.
  const scatterColor = isClassic ? vec3(0.16, 0.55, 0.78) : vec3(0.18, 0.78, 0.78)
  // SSS bumped toward iconic SoT bright-green (more saturated, less
  // yellow). The previous (0.42, 0.85, 0.45) read as "lime" instead of
  // the recognizable "tropical lagoon" hue SoT crests have. Bumping
  // green to 0.95 and dropping red to 0.20 produces a more
  // characteristic cyan-yellowish-green that's visibly distinct from
  // the cooler scatterColor while still reading as ocean.
  const sssColor = isClassic ? scatterColor : vec3(0.2, 0.95, 0.5)

  // Shallow-water tint. When the view ray is short between water surface
  // and terrain (e.g. lagoon shoreline, sandy floor), short Beer-Lambert
  // path → less blue absorption → water reads brighter turquoise. This is
  // SoT's "shelf glow" + Subnautica's tropical shallows effect. Off in
  // classic mode (preserves the original A/B palette).
  //
  // `closeness` is the path-length between water surface and the next
  // opaque surface, so this already accounts for the grazing-angle path
  // exaggeration — looking straight down through 2 m of water reads
  // shallow, looking the same vertical 2 m through a grazing ray reads
  // as 10+ m of path and stays full deep.
  const shallowTintColor = vec3(0.16, 0.5, 0.5)
  const shallowFactor = isClassic
    ? float(0)
    : float(1).sub(smoothstep(float(0), float(8), closeness))
  const tintedDeepColor = isClassic
    ? deepColor
    : mix(deepColor, shallowTintColor, shallowFactor.mul(float(0.55)))

  // Sun-direction back-scatter. uSunDir matches the scene's
  // DirectionalLight (50, 70, 70) — see scene.ts. Stored normalized as a
  // uniform so a future day/night cycle can animate it. The dot is
  // viewDir.negate() · sunDir = (line-of-sight) · (toward-sun); peaks at
  // 1.0 when the camera is looking toward the sun, falls to 0 when
  // looking perpendicular, < 0 when looking away (clamped). Squared so
  // the boost is concentrated near the sun direction.
  const sunDirUniform = uniform(new THREE.Vector3(50, 70, 70).normalize())
  // Horizon haze color — what the surface fades toward at long view
  // distances (aerial perspective; see the `aerialMix` block in the
  // albedo composition below). Default is a desaturated cool teal that
  // works at midday; the sky module mutates it each tick via
  // `setHorizonColor(...)` so sunset / dawn / dusk water picks up the
  // matching sky warmth automatically.
  const horizonHazeUniform = uniform(new THREE.Vector3(0.4, 0.55, 0.6))
  const sunBackscatter = isClassic
    ? float(0)
    : pow(max(float(0), dot(viewDir.negate(), sunDirUniform)), float(2))

  // SoT-style choppiness peak mask: `length(λ·Dx, λ·Dz) / scale`
  // saturated to [0, 1]. Where the Tessendorf horizontal pinch is
  // large (= near a crest about to break), light has a shorter path
  // through the wave body so subsurface scatter dominates. The scale
  // divisor sets where the mask saturates — at the calibrated
  // 3-cascade spectrum, peakSignal peaks around ~0.4 m on chop, so
  // dividing by 0.35 lands the mask at full strength on visible
  // crests without needing extreme pinching. Only fires on the FFT
  // path (analytic branch leaves `peakMaskFrag` at 0).
  const peakMaskScaled = useGpuDisplacement
    ? clamp(peakMaskFrag.div(float(0.35)), float(0), float(1))
    : float(0)
  const scatterAmount = isClassic
    ? heightNorm
    : (() => {
        // Crest scatter ramps with height; grazing view bumps it; sun
        // backlight bumps it further. Combined boost can exceed 1.0 (we
        // clamp at the end so deep troughs stay dark even with sun
        // alignment). This drives the LEGACY scatter-color blend
        // (cyan-green) — the warmer SSS color is layered on top
        // below via the peak mask.
        const viewFactor = float(1).sub(ndotv)
        const baseBoost = mix(float(0.55), float(1.0), viewFactor)
        const sunBoost = sunBackscatter.mul(0.55)
        return clamp(heightFactor.mul(baseBoost.add(sunBoost)), float(0), float(1))
      })()
  // Step 1 of the SoT three-color blend: deep → mid-water scatter
  // (the legacy cyan-green). Captures height-driven swell shading.
  const scatterBlended = mix(tintedDeepColor, scatterColor, scatterAmount)
  // Step 2: layer the SSS yellow-green on top, gated by the peak
  // mask (choppiness pinch) and modulated by sun-backlight
  // alignment. SoT's recipe: SSS fires where the wave is pinched
  // AND the sun is roughly behind the wave from the camera's POV
  // (the literal "light through the wave" geometry).
  //
  // Ambient floor (0.35) so SSS reads on crests even when the sun
  // isn't aligned with the camera — without it, the sunset palette
  // (sun behind the player most of the time) makes SSS invisible.
  // The (sunBackscatter + 0.35) ramps SSS from 35% to ~135% as the
  // camera turns toward the sun. Tuned via Chrome MCP A/B —
  // higher floors (0.5) overdid the yellow-green tint and washed
  // out the cyan scatter, lower floors (0.25) made SSS invisible
  // at sunset.
  const sssGate = useGpuDisplacement
    ? clamp(peakMaskScaled.mul(sunBackscatter.add(float(0.35))), float(0), float(1))
    : float(0)
  const baseColorPreCaustic = isClassic
    ? scatterBlended
    : mix(scatterBlended, sssColor, sssGate.mul(float(0.55)))

  // Caustics — bright veining where sunlight refracts through wave
  // crests and concentrates on the seabed. Real caustics are projected
  // onto the underwater geometry; we cheat by painting them onto the
  // water surface itself, modulated to only appear where the water
  // reads "clear" (shallow + looking-down), so the player's brain
  // attributes the pattern to the seabed below.
  //
  // Pattern: two grids of `abs(sin)*abs(sin)` checkerboards at different
  // scales / rotations, intersected (min) and powered up. The
  // intersection produces curving veining where both grids happen to
  // brighten — that's the hallmark caustic look.
  //
  // Visibility is gated by:
  //   - `shallowFactor`: only show in shallows. Out in deep ocean, no
  //     caustics — that's correct, real caustics dim with depth.
  //   - `ndotv`: only when looking through clear (mostly down) water.
  //     At grazing the surface is opaque (Beer-Lambert) so caustics
  //     wouldn't be visible through it anyway.
  //   - distance fade: aliases hard past ~60 m, so fade to 0 there.
  //   - sun visibility (via the lighting model, since this is a
  //     baseColor contribution and not emissive): no sun → no caustics,
  //     shadow on water → no caustics in that patch. Both correct.
  //
  // Off in classic mode for clean A/B.
  // Layer 1: uniform-scale grid scrolling at one velocity.
  const causticAX = positionWorld.x.mul(float(0.5)).add(tNode.mul(float(0.18)))
  const causticAY = positionWorld.z.mul(float(0.5)).add(tNode.mul(float(-0.13)))
  // Layer 2: anisotropic scale + opposite scroll direction so the two
  // grids slide past each other; the intersections that brighten form
  // the wandering caustic veining.
  const causticBX = positionWorld.x.mul(float(0.42)).add(tNode.mul(float(-0.22)))
  const causticBY = positionWorld.z.mul(float(0.58)).add(tNode.mul(float(0.16)))
  const causticLayer1 = abs(sin(causticAX).mul(sin(causticAY)))
  const causticLayer2 = abs(sin(causticBX).mul(sin(causticBY)))
  const causticPattern = pow(min(causticLayer1, causticLayer2), float(2.5))
  const causticDistFade = float(1).sub(smoothstep(float(20), float(70), camDist))
  const causticIntensity = isClassic
    ? float(0)
    : causticPattern.mul(shallowFactor).mul(ndotv).mul(causticDistFade).mul(float(0.55))
  // A cool aqua boost — same family as scatterColor but a touch lighter
  // so caustics read as "bright spots on the sand" rather than "more
  // surface color". Goes through the lighting model so shadow + night
  // dim it naturally.
  const causticColor = vec3(0.45, 0.85, 0.78)
  const baseColor = isClassic
    ? baseColorPreCaustic
    : baseColorPreCaustic.add(causticColor.mul(causticIntensity))

  // Sun glow emissive — additive on top of the scatter blend for the
  // unmistakable SoT "lit-from-behind" wave glow. Peaks on tall crests
  // (`heightFactor`) lit from behind (`sunBackscatter`), tinted with
  // scatterColor. Off in classic mode.
  const sunGlow = isClassic
    ? vec3(0, 0, 0)
    : scatterColor.mul(sunBackscatter.mul(heightFactor).mul(sunGlowUniform))

  // Wave-driven foam.
  //
  // v2 mode: two stacked layers via max():
  //   1. The vertex-stage accumulator (`foamAccumFrag`) — sampled at 4 past
  //      time steps, decayed exponentially, max-reduced. Gives foam a
  //      ~1 s lingering trail behind each passing crest. Sampled per-vertex
  //      and varying-interpolated, so adjacent vertices with very different
  //      slopes can produce visibly different foam values that bilinear
  //      interpolation reveals as "stair-stepping" bands on wave faces.
  //   2. A per-pixel current-time foam term (`pixelFoam`) computed from
  //      the per-pixel interpolated slope (which IS smooth across the
  //      triangle, since slopes are themselves varyings of smooth Gerstner
  //      math + the mip-filtered detail cascades). This layer fills in
  //      the smooth spatial gradient that the vertex sampling can't
  //      resolve, killing the stair-step artifact at wave-face peaks.
  //
  // max() lets each layer win where it's stronger — pixelFoam dominates
  // at active crests (smooth peaks, no banding), the accumulator
  // dominates in the trail behind passing crests (where slope is now
  // low but used to be high). Power curve (~slope^2 stretched) replaces
  // the hard-zero smoothstep so very small slopes still produce a
  // wisp of foam rather than snapping off — eliminates the
  // foam/no-foam threshold edge entirely.
  //
  // Classic mode: original physically-motivated foam (slope OR Jacobian
  // onset, height-gated) — no time accumulation, but still fixes the
  // pre-M9.29 height-driven trigger. The qSum branch evaluates to 0 when
  // steepness=0 so only slopeFoam contributes here.
  const slopeMag = sqrt(dydx.mul(dydx).add(dydz.mul(dydz)))
  const pixelSlope = sqrt(effDydx.mul(effDydx).add(effDydz.mul(effDydz)))
  const pixelFoam = pow(clamp(pixelSlope.mul(float(1.4)), float(0), float(1)), float(2.0))
  // A3 — Jacobian-driven foam on the FFT path. The kernel writes
  // `J = (1 + λ·Dxx)·(1 + λ·Dzz) − λ²·Dxz²` into displacementTexture.a;
  // J ≈ 1 on a calm surface, dips below 1 as the local horizontal
  // displacement gradient grows, crosses 0 when the surface starts
  // folding back on itself — Tessendorf's "wave breaking" criterion.
  // smoothstep maps that range to a [0, 1] foam intensity. The
  // 3-cascade spectrum sums Jacobians across cascades (we take the
  // MIN), so the foam signal fires more readily than a single-
  // cascade fold would — a chop-cascade crest pinching can drag the
  // composite J below threshold even if the main swell is calm.
  // Window: J < 0.5 → some foam, J < 0.0 → full. Tuned via Chrome
  // MCP A/B — wider thresholds (0.85, 0.15) painted foam across
  // every wave crest and made the surface look frosted instead of
  // wet. (0.5, 0.0) lands foam on the chop crests that actually
  // pinch toward folding without smearing.
  //
  // Replaces the old Tessendorf-via-Gerstner `foldFoam` (qSum-driven)
  // for the FFT path — qSum is the analytic-Gerstner fold signal and
  // evaluates to 0 with the FFT path's spectrum modes anyway.
  // Shared turbulent foam noise — world XZ + time scroll. Used to break
  // up the otherwise-too-clean foam edges of shoreline, wake, bow
  // spray, AND (post-A3) the FFT path's Jacobian-driven wave foam, so
  // they all read as living turbulence instead of stamped outlines.
  //
  // The same noise is sampled by:
  //   - shoreline foam range (lapping in/out by ±0.2m via `foamNoiseRaw`)
  //   - wake foam intensity (multiplicative `foamTurbulence`)
  //   - bow spray intensity (multiplicative `foamTurbulence`)
  //   - wave-crest foam fiber breakup (multiplicative `foamTurbulence`,
  //     FFT path only — the analytic Gerstner foam already has its own
  //     variation from the time-shifted accumulator, so we leave it
  //     alone there).
  // so all foam in the scene moves with a unified visual rhythm.
  const foamNoiseUV = positionWorld.xz.mul(0.35).add(vec2(tNode.mul(-0.18), tNode.mul(0.13)))
  const foamNoiseRawHF = fract(
    sin(foamNoiseUV.x.mul(12.9898).add(foamNoiseUV.y.mul(78.233))).mul(43758.5453),
  )
  // Distance-fade the hash toward its mean (0.5). The 2.86 m wavelength of
  // the hash aliases badly once one screen pixel covers >1 noise cell, which
  // happens between ~20 and ~70 m at typical FOV / 1080p. Past the fade
  // window the noise collapses to a constant — distant shoreline + wake
  // foam reads as a smooth bright band instead of pixel-speckle. Window
  // pulled in from (30, 80) since the detail-normal upgrade made it more
  // obvious that hash sites still flickered in the 20–30 m band.
  const foamNoiseAntialias = float(1).sub(smoothstep(float(20), float(70), camDist))
  const foamNoiseRaw = mix(float(0.5), foamNoiseRawHF, foamNoiseAntialias)
  const foamNoiseSmooth = smoothstep(float(0.2), float(0.85), foamNoiseRaw)
  // Multiplier in [0.5, 1.0] — never erases foam, just breaks up its
  // intensity into turbulent patches.
  const foamTurbulence = mix(float(0.5), float(1.0), foamNoiseSmooth)
  // Subtler variant for wave-crest foam fibers. The Jacobian-driven
  // foam is a smooth blob from the smoothstep; [0.6, 1.0] here gives
  // it visible structure (foam splotches with subtle brightness
  // variation) without speckling — wider ranges read as TV-static
  // when foam is widespread. Effective contrast factor 1.67×.
  const foamFiber = mix(float(0.6), float(1.0), foamNoiseSmooth)

  // A8 — Persistent foam feedback. When the foam-feedback handle is
  // available (FFT path on WebGPU with all three cascades wired), the
  // compute kernel maintains a world-space R32F foam buffer with a
  // temporal-decay max(prev·decay, smoothstep(0.5, 0.0, J)). Sampling
  // that buffer at worldXZ/foamTile gives us foam that LINGERS for
  // ~1s after a wave breaks instead of vanishing the moment the crest
  // moves on. Still multiplied by foamFiber so the smooth feedback
  // blob inherits the same fibrous-noise breakup the stateless
  // version had.
  //
  // Fall back to the legacy stateless foldFoam when the feedback
  // buffer isn't available (analytic Gerstner path → no per-pixel
  // Jacobian source, classic path → no FFT at all).
  const foldFoamFft = foamFeedbackHandle
    ? (() => {
        const foamUV = vec2(
          positionWorld.x.div(float(foamFeedbackHandle.tileSize)),
          positionWorld.z.div(float(foamFeedbackHandle.tileSize)),
        )
        // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
        const sampled = texture(foamFeedbackHandle.foamTexture, foamUV) as any
        return sampled.r.mul(foamFiber).clamp(0, 1)
      })()
    : useGpuDisplacement
      ? // biome-ignore lint/suspicious/noExplicitAny: varying-of-any propagates unknown into smoothstep arg
        smoothstep(float(0.5), float(0.0), jacobianFrag as any)
          .mul(foamFiber)
          .clamp(0, 1)
      : float(0)
  const waveFoam = isClassic
    ? (() => {
        const slopeFoam = smoothstep(float(0.4), float(0.9), slopeMag)
        const heightGate = smoothstep(float(-0.4), float(0.3), heightFrag)
        return slopeFoam.mul(heightGate)
      })()
    : useGpuDisplacement
      ? max(max(foamAccumFrag.mul(float(0.7)), pixelFoam), foldFoamFft)
      : max(foamAccumFrag.mul(float(0.7)), pixelFoam)

  // Per-bike foam: hull ring + V-wake stripe. We wrap the per-bike work in
  // a Fn() so we can use If(...) to early-out for slots whose bike is far
  // from this fragment — most fragments are far from every bike, so this
  // turns a constant per-fragment cost into a roughly O(1) one. Using `If`
  // also requires being inside Fn() since it relies on the assignment
  // stack.
  //
  // Inactive slots are parked at distance 1e6 by `tick()`, so their squared
  // distance is ≫ the cull radius and they short-circuit on the first cmp.
  //
  // The wake's perpendicular distance uses a 2D cross product
  // (|d.x*hat.y - d.y*hat.x|) rather than `length(d - hat * parallel)` —
  // one mul + one mul + one sub + one abs vs. a square + sqrt.
  const computeBikeFoam = Fn(() => {
    const sum = float(0).toVar()
    for (let i = 0; i < MAX_BIKES; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle proxy
      const slot = bikesUniform.element(i) as any
      // biome-ignore lint/suspicious/noExplicitAny: TSL types lose precision here
      const dxRel = positionWorld.x.sub(slot.x) as any
      // biome-ignore lint/suspicious/noExplicitAny: TSL types lose precision here
      const dzRel = positionWorld.z.sub(slot.y) as any
      const r2 = dxRel.mul(dxRel).add(dzRel.mul(dzRel))
      If(r2.lessThan(float(BIKE_INFLUENCE_R_SQ)), () => {
        const r = sqrt(r2)
        // biome-ignore lint/suspicious/noExplicitAny: TSL UniformArrayElementNode lacks float-typing in TS
        const weight = weightsUniform.element(i) as any

        // V-wake foam stripe behind the bike.
        // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle proxy
        const vx = slot.z as any
        // biome-ignore lint/suspicious/noExplicitAny: TSL swizzle proxy
        const vz = slot.w as any
        const speed = sqrt(vx.mul(vx).add(vz.mul(vz)))
        const safeSpeed = max(speed, float(0.001))
        const hatX = vx.div(safeSpeed)
        const hatZ = vz.div(safeSpeed)
        const parallel = dxRel.mul(hatX).add(dzRel.mul(hatZ))
        const behind = max(parallel.negate(), float(0))
        const ahead = max(parallel, float(0))
        // 2D perpendicular distance via cross-product magnitude (cheaper
        // than `length(d - hat * parallel)`).
        const perp = abs(dxRel.mul(hatZ).sub(dzRel.mul(hatX)))
        const speedGate = smoothstep(float(WAKE_SPEED_LOW), float(WAKE_SPEED_HIGH), speed)

        // Hull foam ring: bright at the dimple's outer edge, fading
        // inward and outward over a small band. Speed-modulated so it
        // reads more dramatically at race pace — at full speed the ring
        // is ~1.6× brighter than at idle, communicating the hull's
        // active interaction with the water.
        const ringInner = smoothstep(float(BIKE_DIMPLE_R - 1.0), float(BIKE_DIMPLE_R - 0.2), r)
        const ringOuter = smoothstep(float(BIKE_DIMPLE_R + 0.6), float(BIKE_DIMPLE_R - 0.2), r)
        const ringSpeedBoost = float(1).add(speedGate.mul(0.6))
        const ring = ringInner.mul(ringOuter).mul(weight).mul(0.55).mul(ringSpeedBoost)

        // V-wake foam stripe behind the bike. Multiplied by `foamTurbulence`
        // so the edges break up into patches instead of a clean Kelvin-V
        // outline — that's what made the prior wake feel "stamped".
        const wakeWidth = behind.mul(WAKE_HALF_ANGLE_TAN).add(float(WAKE_BASE_WIDTH))
        const behindGate = smoothstep(float(0.0), float(0.3), behind)
        const decay = exp(behind.mul(-WAKE_LONG_DECAY))
        const edgeBlur = smoothstep(wakeWidth.add(0.4), wakeWidth.sub(0.5), perp)
        const wake = behindGate
          .mul(speedGate)
          .mul(decay)
          .mul(edgeBlur)
          .mul(weight)
          .mul(0.7)
          .mul(foamTurbulence)

        // Stern propwash (M9.33): bright concentrated foam directly behind
        // the bike (peaks at ~0.3m, fades to 0 by ~2.5m). Centered on the
        // wake axis (perp ≈ 0). What gives the wake its kinetic "boat is
        // here" feel rather than a pure V outline. NOT noise-modulated —
        // the propwash is a solid mass of foam that the bike actively
        // generates, distinct from the turbulent edges trailing behind.
        const propwashFalloff = exp(behind.mul(-1.0))
        const propwashLateral = float(1).sub(smoothstep(float(0), float(0.7), perp))
        const propwashGate = smoothstep(float(0.0), float(0.2), behind)
        const propwash = propwashGate
          .mul(speedGate)
          .mul(propwashFalloff)
          .mul(propwashLateral)
          .mul(weight)
          .mul(0.65)

        // Bow spray: forward foam "moustache" in front of the bike,
        // peaking just ahead and fading to 0 by ~1.5m forward. Same
        // Kelvin-V geometry as the wake but FORWARD-facing with a
        // tighter half-angle, so the spray reads as a sharp arc rather
        // than a long trail. Speed-gated so a parked bike doesn't spray.
        // The bike's hull pushes water forward at race pace; this is
        // the visual cue for that interaction. Noise-modulated for the
        // same turbulent character as the wake.
        const splashHalfAngle = 0.35
        const splashWidth = ahead.mul(splashHalfAngle).add(float(0.35))
        const aheadGate = smoothstep(float(0.0), float(0.25), ahead)
        const aheadFalloff = exp(ahead.mul(-1.6))
        const splashEdge = smoothstep(splashWidth.add(0.3), splashWidth.sub(0.4), perp)
        const bowSpray = aheadGate
          .mul(speedGate)
          .mul(aheadFalloff)
          .mul(splashEdge)
          .mul(weight)
          .mul(0.85)
          .mul(foamTurbulence)

        sum.addAssign(ring.add(wake).add(propwash).add(bowSpray))
      })
    }
    return sum
  })
  const bikeFoam = computeBikeFoam()

  // Shoreline foam: white foam where terrain is just below the water
  // surface. Reads from the shared `closeness` / `closenessSigned`
  // values lifted to the top of the fragment composition (originally
  // local to this block) so the shallow-water color tint in `baseColor`
  // can read the same depth signal. `behindGate` keeps foam from firing
  // where opaque objects (e.g. a bike) occlude the water plane between
  // camera and the actual water surface — without it, those samples
  // would read negative closeness and falsely trigger foam. Off in
  // classic mode for clean A/B.
  const intersectionFoam = isClassic
    ? float(0)
    : (() => {
        // Wide band of soft foam that reaches 3 m off-shore + a tight
        // bright peak right at the water-line. Two layers maxed together:
        //   - `bandFoam`   — 0..1 over a 3 m breathing depth range, with
        //                    the falloff biased so the half-mark is still
        //                    quite bright (sqrt curve). Reads as a
        //                    surf zone rather than a thin ribbon.
        //   - `peakFoam`   — narrow bright lip in the first ~0.5 m of
        //                    submersion. This is the unmistakable "foam at
        //                    the geometry edge" beat.
        // Wider, brighter than v2. Recent shoreline-cone work made the
        // terrain drop steeply at the water-line, which compressed the
        // 3 m band to a sub-pixel sliver. Reaching out to 6 m gives the
        // surf zone room to breathe in screen space, and the peak band
        // (now 1.0 m) makes the actual waterline lip read as a solid
        // belt rather than a thin highlight you have to hunt for.
        const FOAM_BAND_BASE = 6.0
        const PEAK_RANGE = 1.0
        const behindGate = smoothstep(float(-0.05), float(0.05), closenessSigned)
        // Lapping shoreline: the depth threshold breathes ±1.0 m around
        // the 6.0 m base as the shared foam noise scrolls. Bumped from
        // ±0.7 m so the surf "tongue" extends further at peaks of the
        // turbulence — reads as a more lively shoreline. `closeness` is
        // the shared view-ray water-column path from the top of the file.
        const noiseRangeOffset = foamNoiseRaw.sub(float(0.5)).mul(float(2.0))
        const bandRangeNow = float(FOAM_BAND_BASE).add(noiseRangeOffset)
        // Pow-0.4 falloff: fuller-bright across more of the band than the
        // sqrt curve. At half the band depth, foam still reads at ~0.76
        // brightness (sqrt put it at 0.71). Combined with the wider base,
        // the surf zone reads as a solid sand-edge band rather than a
        // gradient that fades to nothing.
        const bandLinear = float(1).sub(clamp(closeness.div(bandRangeNow), float(0), float(1)))
        const bandFoam = pow(bandLinear, float(0.4))
        // Tight bright peak right at the intersection — the unmistakable
        // waterline lip on top of the wider band. Wider PEAK_RANGE (was
        // 0.6) so the lip survives steep shorelines where terrain drops
        // sub-meter into the water within a few pixels of the surface.
        const peakLinear = float(1).sub(smoothstep(float(0), float(PEAK_RANGE), closeness))
        const peakFoam = peakLinear.mul(float(1.15))
        // Intensity modulation: 0.9..1.2 — slightly punchier than v2's
        // 0.85..1.15 so turbulent peaks saturate the final clamp.
        const intensityModulator = mix(float(0.9), float(1.2), foamNoiseSmooth)
        return behindGate.mul(max(bandFoam, peakFoam)).mul(intensityModulator)
      })()

  // Shoreline surf — pulsing breakers driven by true vertical water
  // depth + incoming wave crests. Complements `intersectionFoam` above
  // (which is screen-space depth, great visual cue at grazing angles) by
  // adding geometrically-correct surf that fires per-pixel on the
  // terrain-shoaled cells. The pulse is what makes the coastline feel
  // alive: each ambient swell crest gets brighter as it sweeps into
  // shallow water (real-world shoaling: waves slow + steepen + break),
  // so the surf line breathes with the wave field instead of sitting as
  // a static foam ring. Off in classic mode and when no heightmap is
  // installed (waterDepthFrag stays ≈ +10000 → shoreBand ≈ 0).
  const shorelineSurf = isClassic
    ? float(0)
    : (() => {
        // Strong only in the last ~3 m of depth — same envelope as the
        // vertex shoaling so foam and damped geometry align.
        const SURF_BAND_DEPTH = 3.0
        const shoreBand = float(1).sub(smoothstep(float(0), float(SURF_BAND_DEPTH), waterDepthFrag))
        // Crest signal: the un-attenuated ambient wave height. Positive
        // values are wave faces marching toward shore — exactly what we
        // want to "break" into surf. Using the pre-attenuation height
        // means the pulse cadence stays locked to the natural wave
        // period even where the geometry is being damped, so the surf
        // visibly follows incoming crests rather than going static.
        const crestSignal = clamp(ambientHeightFrag, float(0), float(1.5))
        // Ramp from "no foam" at crest=0 to "full breaker" by ~0.6 m of
        // crest height. Pow-1.6 biases the response: small crests
        // produce faint surf; once a real crest arrives, the foam
        // saturates fast — the characteristic "wave broke" punctuation.
        const crestBreaker = pow(smoothstep(float(0.05), float(0.6), crestSignal), float(1.6))
        // Persistent waterline lip — always-on faint band at the
        // shoreline edge (≤ 0.5 m depth) so the visible boundary never
        // disappears between crests, even on calm seas.
        const waterlineBase = float(1)
          .sub(smoothstep(float(0), float(0.5), waterDepthFrag))
          .mul(float(0.35))
        // Reuse the shared foam turbulence noise so this surf line breaks
        // into the same lapping shapes as the wave / bike foam layers
        // instead of reading as a clean band.
        const turbulence = mix(float(0.7), float(1.15), foamNoiseSmooth)
        // The pulsing breaker contribution: scoped to the shore band,
        // pulsed by crest, lightly turbulated.
        const breaker = shoreBand.mul(crestBreaker).mul(turbulence).mul(float(1.25))
        return max(breaker, waterlineBase.mul(shoreBand))
      })()

  // Intersection foam is full-opaque white where it fires (we want the
  // shoreline edge to read clearly against the water), so we max-combine
  // it with the (waveFoam + bikeFoam) sum rather than adding — additive
  // would create unnaturally over-bright zones at gate posts where the
  // ramp hits water. Final clamp raised from 0.95 to 1.0 so the bright
  // peak at the water-line can reach pure white. The new `shorelineSurf`
  // (depth-driven pulsing breakers) folds in via max so its bright
  // crest-strike pulses can paint over the static intersection band.
  const foamMask = clamp(
    max(max(waveFoam.add(bikeFoam), intersectionFoam), shorelineSurf),
    float(0),
    float(1),
  )
  // Slightly warmer / brighter than v2's (0.92, 0.96, 1.0). Real surf
  // foam reads near-white-with-a-warm-tilt under sunlight; the previous
  // cool tint was getting tugged blue by the deep-water albedo it sat on
  // top of, especially while the alpha was 0.78.
  const foamColor = vec3(0.97, 0.99, 1.0)

  // Fresnel: standard Schlick approximation. Used both as a strength
  // weight for the planar reflection (below) and as the fallback sky-tint
  // emissive when reflections are off (classic mode / `?reflect=0`).
  // (viewDir + ndotv computed earlier and shared with the scatter blend.)
  const f0 = float(0.02)
  const fresnel = f0.add(
    float(1)
      .sub(f0)
      .mul(pow(float(1).sub(ndotv), 5)),
  )

  // Planar reflection (M9.38). The TSL `reflector()` node manages a
  // virtual mirror camera + render-target, samples them via screenUV. The
  // call returns a TextureNode whose .rgb gives the reflected scene color.
  //
  // We distort the reflection UV by the wave-normal slopes (dydx, dydz)
  // so the reflection ripples with the surface — without distortion the
  // mirror image looks glassy and the wave geometry feels disconnected
  // from what's painted on it. Distortion magnitude tapers with
  // view-distance so distant waves don't smear the reflection across the
  // screen (typical mirror-distortion trick: closer = more refraction).
  //
  // The reflection is mixed into the base water color via Fresnel — at
  // grazing angles the surface reflects strongly (sky/horizon hits the
  // eye), at the zenith the diffuse scatter color dominates. The fresnel
  // sky-tint emissive that previously approximated this is dropped when
  // reflections are on (the actual reflected sky subsumes it); classic
  // mode and `?reflect=0` preserve the cheap fake.
  //
  // Cost: a full additional render pass at half-res per frame. Rendered
  // scene includes sky + bikes + terrain + props but excludes the water
  // itself (the reflector toggles `material.visible = false` during its
  // pass). At 0.5 resolutionScale on a 1080p framebuffer that's 540p, a
  // few hundred k pixels — trivial on real GPUs, fine on WebGPU + WebGL2.
  const reflectFlag = !isClassic && params?.get('reflect') !== '0'
  let reflectionRgb: ReturnType<typeof vec3> | null = null
  let reflectorTarget: THREE.Object3D | null = null
  if (reflectFlag) {
    const mirror = reflector({
      resolutionScale: 0.5,
      bounces: false,
      generateMipmaps: false,
    })
    // Distortion: scale wave-normal gradients by an inverse-distance
    // factor so the close-in 1–2 m of water in front of the camera
    // distorts visibly while horizon samples stay nearly mirror-flat.
    // The 0.04 base is the gentlest setting that still reads as "moving
    // water" rather than "glass"; bump if the reflection feels too
    // perfect, drop if it smears.
    const distortAmt = float(0.02).add(float(0.6).div(camDist.add(float(2.0))))
    // Use the combined (analytic + detail) slopes so the reflection ripples
    // with the fine wave chop the detail-normal cascades add. Without this,
    // close-range reflections look glassy under the visibly-bumpy surface.
    const distortion = vec2(effDydx, effDydz).mul(distortAmt)
    // biome-ignore lint/suspicious/noExplicitAny: TSL ReflectorNode TS surface lacks .uvNode/.rgb/.target getters
    const m = mirror as any
    m.uvNode = m.uvNode.add(distortion)
    reflectionRgb = m.rgb
    reflectorTarget = m.target
  }

  // Albedo composition: deep/scatter blend → planar reflection (Fresnel-
  // weighted) → aerial perspective haze → foam paints over the result.
  // Foam comes LAST so it still reads as opaque white where it fires
  // (foam is water particles, not the surface — it shouldn't reflect
  // and shouldn't get blue-shifted by aerial perspective).
  const reflectedOrBase = reflectionRgb
    ? mix(baseColor, reflectionRgb, fresnel.mul(reflStrengthUniform))
    : baseColor

  // Aerial perspective: distant water reads denser. Real ocean past
  // ~150 m takes on a flattened, hazier tone as the atmosphere absorbs /
  // scatters along the long view path. Without this, the horizon water
  // reads as the same color as foreground water and the scene loses its
  // sense of scale. The horizon color is driven from the sky palette via
  // `horizonHazeUniform` (see `setHorizonColor` + the sky module's tick),
  // so sunset water picks up warmth, twilight reads cool blue, etc. Same
  // color the scene fog uses — water and sky horizon stay tonally aligned.
  // Capped at 0.5 mix so the horizon water still reads as water-coloured
  // beneath the haze, not solid sky. Off in classic.
  const aerialMix = isClassic
    ? float(0)
    : smoothstep(float(120), float(280), camDist).mul(float(0.5))
  const surfaceColor = isClassic
    ? reflectedOrBase
    : mix(reflectedOrBase, horizonHazeUniform, aerialMix)

  const albedo = mix(surfaceColor, foamColor, foamMask)

  // Sky-tint emissive: only used as a fallback when reflections are off
  // (classic mode or `?reflect=0`). When the reflection is active, the
  // actual reflected sky already paints the grazing-angle bright band
  // and stacking a fake sky tint on top reads as chrome.
  const skyTint = vec3(0.55, 0.72, 0.95)
  const fresnelEmissive = reflectionRgb
    ? vec3(0, 0, 0)
    : skyTint.mul(fresnel.mul(isClassic ? 0.5 : 0.32))

  // Sparkle: low-frequency hash on world XZ + animated UV scroll, gated to
  // crests. Drops the local roughness so the PBR specular lobe tightens
  // INTO sparkle bursts where the sun catches the surface — that's the
  // SoT-style glistening, realised entirely through the lighting model
  // rather than additive emissive.
  //
  // We deliberately do NOT stack a high-frequency per-pixel emissive on
  // top: that pin-prick layer alias-flickers as TV-static at any distance
  // the camera can't pixel-resolve the noise cell, and even tightly
  // distance-faded it reads as noise rather than glint on the close-in
  // band. The roughness modulation alone gives the wandering-glint
  // character without sampling a hash per fragment.
  //
  // Distance-fade the broad hash toward its mean (0.5) past ~35 m so the
  // sparkle patches stop firing/clearing at sub-pixel rates on the horizon
  // — past the fade window only the base roughness (and the Toksvig AA
  // boost below) decide the specular tightness.
  const broadSeed = positionWorld.xz.mul(0.18).add(vec2(tNode.mul(-0.11), tNode.mul(0.08)))
  const broadNoiseHash = fract(
    sin(broadSeed.x.mul(12.9898).add(broadSeed.y.mul(78.233))).mul(43758.5453),
  )
  const broadNoiseAA = float(1).sub(smoothstep(float(35), float(110), camDist))
  const broadNoise = mix(float(0.5), broadNoiseHash, broadNoiseAA)
  const sparkleHeightGate = smoothstep(float(0.45), float(0.85), heightNorm)
  const broadMask = smoothstep(float(0.55), float(0.85), broadNoise).mul(sparkleHeightGate)

  const mat = new MeshStandardNodeMaterial({
    transparent: true,
    // Water is a dielectric, so metalness must be 0 — F0 stays at the PBR
    // dielectric default (~0.04) and Schlick correctly drives specular
    // toward white at grazing angles. The previous 0.45 was blending F0
    // toward the deep-teal baseColor, which tinted near-zenith sun glints
    // a dark blue and made the surface look like blued steel from above.
    // From below the surface, ndotv was already clamped to 0 (Fresnel = 1),
    // so the wrong F0 was hidden — which is why the above-water view read
    // worse than the below-water view despite using the same material.
    metalness: 0,
    // roughness is now driven by `roughnessNode` below; this constant is the
    // base value (used when `roughnessNode` evaluates to 1.0 — i.e. away
    // from sparkle patches).
    roughness: 0.18,
    envMapIntensity: 0.9,
  })
  mat.name = 'water'
  mat.positionNode = positionNode
  mat.normalNode = normalNode
  mat.colorNode = albedo
  // Foam needs a constant emissive lift. Real foam scatters sky light
  // independently of the direct sun, so it stays readably bright even
  // when the surface is in shadow (cliff side, behind a bike) — without
  // this, foam in shadowed shoreline reads as grey. Bumped from 0.28 →
  // 0.5 in the SoT-research pass: the original was meant to read
  // against the warm sunset haze but ended up too subtle even on
  // pinched breaking crests; foam should pop visibly bright since it's
  // the "this wave is actually breaking" signal a player relies on for
  // arcade water reads.
  const foamEmissive = foamColor.mul(foamMask).mul(float(0.5))
  mat.emissiveNode = fresnelEmissive.add(sunGlow).add(foamEmissive)
  // View-angle-dependent base opacity. Beer-Lambert: the optical path
  // length through water along the view ray scales as ~1/ndotv, so
  // grazing samples accumulate ~5–10× more absorption than samples
  // looking straight down. Reading this as alpha:
  //   - ndotv → 1 (looking down): drop alpha to 0.55, so the seabed
  //     directly below the camera reads through clearly. This is the
  //     "perpendicular" half of Matt's request — water feels clearer.
  //   - ndotv → 0 (grazing): lift alpha to 0.96, so the horizon water
  //     reads as a continuous opaque mass and the surface doesn't feel
  //     like a glass plate laid over the terrain. This is the "thicker
  //     when horizontal" half.
  // Then foam stamps full opacity on top so the surf zone still reads
  // as solid scattered air regardless of view angle.
  const baseAlpha = mix(float(0.55), float(0.96), float(1).sub(ndotv))
  // Depth-gate opacity. `closeness` is the view-ray path through water to
  // the next opaque surface; small in shallows (seabed within ~6 m of the
  // water-line), large in deep water (or at grazing angles where there's
  // a lot of water between the surface and any seabed). Both deep-water
  // and grazing samples should be effectively opaque — without this, you
  // can see wave fronts THROUGH the wave in front of them, which was the
  // single biggest "this doesn't look like a real ocean" tell after
  // comparing to SoT. Shallows retain the view-angle-driven base alpha
  // so the seabed colour still reads through directly-overhead samples.
  const depthOpacity = smoothstep(float(0), float(6), closeness)
  const depthGatedAlpha = mix(baseAlpha, float(0.98), depthOpacity)
  mat.opacityNode = mix(depthGatedAlpha, float(0.98), foamMask)
  // Noise-modulated roughness. In sparkle patches roughness drops from 0.18
  // to ~0.04, tightening the specular lobe and producing crisp highlights.
  // Classic mode keeps the constant 0.18 so the A/B comparison is clean.
  // Both base + sparkle ends are uniforms so the debug menu can scrub them.
  //
  // Toksvig-style specular AA on top: fwidth(normalNode) reports how much
  // the normal swings per screen pixel. Where that's large — typically wave
  // crests projected at a glancing angle, where the wave's own slope flips
  // across a single pixel — the PBR specular lobe is wider than the normal
  // it's reflecting around, and the highlight aliases to single-pixel pin
  // pricks. Push roughness up proportionally so the lobe stays wider than
  // the screen-space normal variance, and the highlight smears into a
  // stable line of glints instead of flickering noise.
  //
  // 0.18 max boost is enough to fully shut down the worst-case sparkle while
  // leaving sub-pixel-stable areas untouched. Works for both v2 and classic
  // (classic still benefits — it just keeps its constant base + boost).
  if (!isClassic) {
    const normalScreenDelta = fwidth(normalNode).length()
    const aaBoost = smoothstep(float(0.05), float(0.5), normalScreenDelta).mul(float(0.18))
    const sparkleRough = mix(roughBaseUniform, roughSparkleUniform, broadMask)
    mat.roughnessNode = clamp(sparkleRough.add(aaBoost), float(0), float(1))
  }

  // Debug knob surface (water-debug-menu.ts talks to this). All setters
  // clamp inputs and apply to the relevant uniform / mesh state. The amp
  // scales also mutate `field.waves[i].amplitude` so the CPU buoyancy
  // sampler stays in lockstep with the GPU shader.
  // Initial choppiness / sea-state intensity match the construction-
  // time values used by `createGpuOceanDisplacement` (see gpu-bake.ts
  // defaults). RESET in the menu restores these.
  // 0.7 default matches `gpu-bake.ts`'s constructor default; the
  // higher value lets the Tessendorf horizontal pinch + Jacobian
  // foam path actually fire on near-breaking crests at the
  // calibrated spectrum.
  const CHOPPINESS_DEFAULT = 0.7
  const SEA_STATE_DEFAULT = 1
  // Wind speed default mirrors `field.spectrumParams.windSpeed` at
  // construction (defaults to 9.5 from `defaultSpectrumParams()`).
  // Falls back to a sane open-ocean speed on the Gerstner path so the
  // slider has a non-zero starting value if a user flips on the FFT
  // mode mid-session.
  const WIND_SPEED_DEFAULT = field.kind === 'spectrum' ? field.spectrumParams.windSpeed : 9.5
  // Wind direction default: derive from spectrumParams as
  // `atan2(dirZ, dirX)` in degrees. The default
  // `(dirX, dirZ) = (0.6, 0.8)` from `defaultSpectrumParams` lands
  // at ~53° (NNE-style wind), so the spectrum reads as wind blowing
  // from upper-left. Off-FFT path: surface a sensible default that's
  // visually consistent with the spectrum tune so flipping mode
  // mid-session doesn't introduce a discontinuity.
  const WIND_DIRECTION_DEFAULT =
    field.kind === 'spectrum'
      ? (Math.atan2(field.spectrumParams.windDirZ, field.spectrumParams.windDirX) * 180) / Math.PI
      : (Math.atan2(0.8, 0.6) * 180) / Math.PI
  // Phillips small-wavelength cutoff (m). `defaultSpectrumParams`
  // ships 1.2 m — sub-1.2-meter modes are pruned. The slider lets
  // the user trade chop detail for surface smoothness on the fly.
  const WIND_CUTOFF_DEFAULT =
    field.kind === 'spectrum' ? field.spectrumParams.smallWavelengthCutoff : 1.2
  // A8 foam-feedback persistence (0..1). Construction-time decay is
  // 0.93 (hardcoded in foam-feedback.ts DEFAULTS); inverse-lerp on
  // the [0.7, 0.99] mapping puts that at (0.93-0.7)/(0.99-0.7) ≈
  // 0.79. RESET in the menu restores this.
  const FOAM_PERSISTENCE_DEFAULT = 0.79
  const defaults: WaterDebugDefaults = {
    steepness: initialSteepness,
    swellScale: 1,
    chopScale: 1,
    timeScale: 1,
    reflectionStrength: REFLECTION_STRENGTH_DEFAULT,
    sunGlow: SUN_GLOW_DEFAULT,
    roughBase: ROUGH_BASE_DEFAULT,
    roughSparkle: ROUGH_SPARKLE_DEFAULT,
    detailStrength: detailFlag ? DETAIL_STRENGTH_DEFAULT : 0,
    choppiness: CHOPPINESS_DEFAULT,
    seaStateIntensity: SEA_STATE_DEFAULT,
    windSpeed: WIND_SPEED_DEFAULT,
    windDirection: WIND_DIRECTION_DEFAULT,
    windCutoff: WIND_CUTOFF_DEFAULT,
    foamPersistence: FOAM_PERSISTENCE_DEFAULT,
    wireframe: wireFlag,
  }
  // Orchestrates a live spectrum rebuild: builds the new Phillips
  // grid on CPU, swaps the field's top-K modes (CPU buoyancy stays in
  // sync), uploads the new h0/ω into the GPU spectrum texture. Cheap
  // enough for slider drag — ~1 ms at N=32, well under a single
  // frame budget. No-op outside the spectrum + GPU-displacement path.
  // Also re-syncs the A8 foam-feedback advection drift so foam
  // continues to flow in cascade 0's current wind direction after a
  // wind-direction or wind-speed slider drag.
  function applySpectrumParams(params: PhillipsParams): void {
    if (field.kind !== 'spectrum') return
    const grid = buildPhillipsSpectrum(params)
    field.spectrum = selectTopKModes(grid, { topK: field.spectrum.length })
    field.spectrumParams = params
    gpuDisplacementHandle?.uploadSpectrum(grid)
    if (foamFeedbackHandle) {
      const driftSpeed = params.windSpeed * FOAM_DRIFT_FRACTION_OF_WIND
      foamFeedbackHandle.setDrift(params.windDirX * driftSpeed, params.windDirZ * driftSpeed)
    }
  }
  const clamp01 = (n: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo))
  function applySwellScale(s: number): void {
    const v = clamp01(s, 0, 3)
    swellScaleUniform.value = v
    // Spectrum mode: the swell/chop split doesn't exist (continuous
    // spectrum), so the uniform still tracks the slider value for
    // visual continuity in the debug UI but the per-wave amplitude
    // mutation is skipped. Phase A5 replaces these knobs with wind
    // speed / cutoff which DO drive the spectrum meaningfully.
    if (field.kind !== 'gerstner') return
    for (let i = 0; i < field.waves.length; i++) {
      if (SWELL_INDICES.has(i)) field.waves[i]!.amplitude = baseAmplitudes[i]! * v
    }
  }
  function applyChopScale(s: number): void {
    const v = clamp01(s, 0, 3)
    chopScaleUniform.value = v
    if (field.kind !== 'gerstner') return
    for (let i = 0; i < field.waves.length; i++) {
      if (!SWELL_INDICES.has(i)) field.waves[i]!.amplitude = baseAmplitudes[i]! * v
    }
  }
  const debug: WaterMesh['debug'] = {
    defaults,
    setSteepness(s) {
      steepnessUniform.value = clamp01(s, 0, 1.5)
    },
    setSwellScale: applySwellScale,
    setChopScale: applyChopScale,
    setTimeScale(s) {
      timeScale = clamp01(s, 0, 5)
    },
    getTimeScale: () => timeScale,
    setReflectionStrength(s) {
      reflStrengthUniform.value = clamp01(s, 0, 1)
    },
    setSunGlow(s) {
      sunGlowUniform.value = clamp01(s, 0, 3)
    },
    setRoughBase(s) {
      roughBaseUniform.value = clamp01(s, 0, 1)
    },
    setRoughSparkle(s) {
      roughSparkleUniform.value = clamp01(s, 0, 1)
    },
    setDetailStrength(s) {
      detailStrengthUniform.value = clamp01(s, 0, 2)
    },
    setChoppiness(s) {
      // No-op on the analytic path — the kernel only exists on the
      // FFT/spectrum branch. Clamp range matches the slider [0, 2].
      gpuDisplacementHandle?.setChoppiness(clamp01(s, 0, 2))
    },
    setSeaStateIntensity(s) {
      // Same no-op rule. Range [0, 4] gives headroom from glassy to
      // stormy without making the kernel produce NaN-grade peaks.
      gpuDisplacementHandle?.setRenderScale(clamp01(s, 0, 4))
    },
    setWindSpeed(s) {
      // No-op on the analytic path. Range [1, 20] m/s — 1 = glassy,
      // 20 = storm. Higher windSpeed → longer dominant wavelength
      // (L = V²/g grows quadratically), so the visible character
      // shifts from short choppy ripples toward long rolling swell.
      if (field.kind !== 'spectrum') return
      const v = clamp01(s, 1, 20)
      applySpectrumParams({ ...field.spectrumParams, windSpeed: v })
    },
    setWindDirection(deg) {
      // Convert deg → (dirX, dirZ) unit vector, then rebuild the
      // spectrum. Range [-180, 180] degrees CCW from world +X.
      // Mitsuyasu spread reads through the new direction in lockstep.
      // No-op on the analytic / Gerstner path — its direction comes
      // from per-wave hard-coded directions, not from a spectrum.
      if (field.kind !== 'spectrum') return
      const clamped = clamp01(deg, -180, 180)
      const rad = (clamped * Math.PI) / 180
      applySpectrumParams({
        ...field.spectrumParams,
        windDirX: Math.cos(rad),
        windDirZ: Math.sin(rad),
      })
    },
    setWindCutoff(m) {
      // Phillips smallWavelengthCutoff (m). Range [0.1, 5.0].
      // Lower = finer chop modes survive (more high-k content),
      // higher = aggressive pruning (smoother surface, fewer
      // contributing modes). The same `applySpectrumParams`
      // orchestration handles the CPU top-K + GPU h0 upload.
      if (field.kind !== 'spectrum') return
      const v = clamp01(m, 0.1, 5)
      applySpectrumParams({ ...field.spectrumParams, smallWavelengthCutoff: v })
    },
    setFoamPersistence(s) {
      // 0..1 slider → decay in [0.7, 0.99]. Fast fade at 0,
      // long trails at 1. No-op when the foam-feedback handle
      // is absent (analytic path, classic path, or ?foamfb=0).
      const v = clamp01(s, 0, 1)
      const decay = 0.7 + (0.99 - 0.7) * v
      foamFeedbackHandle?.setDecay(decay)
    },
    setWireframe(on) {
      mat.wireframe = !!on
    },
  }

  // Debug: ?water=wire renders the water mesh as wireframe so you can see
  // the actual vertex displacement (vs. just shaded color). Useful when
  // tuning the wake / dimple / wave amplitudes — turn it on, drive the
  // bike, see the actual ridges in the geometry.
  if (typeof window !== 'undefined') {
    if (wireFlag) {
      mat.wireframe = true
      mat.transparent = false
      mat.opacityNode = float(1)
    }
    // Live tuning hook for playtest: in the dev console, call
    //   __waterSteepness(0.9)
    // to scrub the global Q multiplier without reloading. Returns the
    // clamped value actually applied. 0 = vertical-only blobs, 0.7 = SoT
    // default, 1+ = ridge-y / chop-heavy. Past ~1.3 the sum may form loops
    // (vertices crossing) — visually jagged but not crashing.
    // biome-ignore lint/suspicious/noExplicitAny: dev-only debug hook
    ;(window as any).__waterSteepness = (s: number) => {
      debug.setSteepness(s)
      return steepnessUniform.value
    }
    // Sub-Gerstner detail-normal strength. 0 = bypass detail (analytic-only),
    // 1 = default cascade contribution, 2 = punchy / overdriven for tuning.
    // biome-ignore lint/suspicious/noExplicitAny: dev-only debug hook
    ;(window as any).__waterDetail = (s: number) => {
      debug.setDetailStrength(s)
      return detailStrengthUniform.value
    }
  }

  const mesh = new THREE.Mesh(geom, mat as unknown as THREE.Material)
  mesh.name = 'water'
  mesh.position.y = 0
  // Receive shadows from bikes / props / terrain. The node-material's
  // colorNode is treated as albedo by the standard lighting model, so
  // shadow attenuation darkens the deep-blue/cyan diffuse while the
  // emissiveNode (sun glow, fresnel sky tint, foam, sparkle) stays
  // bright — highlights still pop in shadow. We deliberately don't set
  // `castShadow` on water: bumpy wave normals would alias the shadow
  // map and self-shadow ugly.
  mesh.receiveShadow = true

  // Reflector target: the Object3D that anchors the mirror plane. Its
  // local +Z axis is the plane normal, so we rotate -90° around X to
  // align local +Z with world +Y for a horizontal water mirror. Parented
  // to the (camera-locked) water mesh — the plane reference position
  // moves in X/Z but reflection across an infinite horizontal plane is
  // independent of the in-plane offset, so the math still holds. Without
  // this wiring the reflector falls back to `_defaultRT` (a 1x1 cleared
  // texture) and renders nothing.
  if (reflectorTarget) {
    reflectorTarget.rotation.x = -Math.PI / 2
    mesh.add(reflectorTarget)
  }

  // Pre-water depth snapshot. Three.js calls `onBeforeRender` per object
  // right before its draw is encoded — by the time water (transparent)
  // gets here, all opaques have been encoded into the same pass, so a
  // copy of the framebuffer's depth attachment at this point captures
  // post-opaque depth. `copyFramebufferToTexture` ends the active render
  // pass on the encoder, copies the depth, then begins a new pass with
  // `loadOp = Load` so the depth values survive. The shoreline foam in the
  // shader samples `sceneDepthTexture` at `screenUV` and compares to the
  // water fragment's view-Z; without this manual snapshot, the equivalent
  // `viewportDepthTexture()` helper captures a cleared depth buffer too
  // early in the frame and the comparison reads the scene as "all at the
  // far plane" — no foam ever fires.
  const _sceneDepthSize = new THREE.Vector2()
  // Track sim time between frames so the foam-feedback advection
  // can convert its world-m/s drift uniform into a per-frame texel
  // offset. NaN sentinel → first frame uses dt=0 (no advection
  // step before there's a baseline time).
  let foamLastFieldTime = Number.NaN
  // FFT-cascade dispatch counter. `frameIdx % fftSkip === 0` gates the
  // expensive cascade ticks (and the foam-feedback step that reads
  // their Jacobians) to run every Nth frame. Surface holds its previous
  // displacement texture in between; vertex/fragment shaders keep
  // sampling, so the user sees a 30Hz wave update inside a 60Hz draw
  // loop — no perceptible change at racing speed.
  let fftFrameIdx = 0
  mesh.onBeforeRender = (renderer) => {
    // biome-ignore lint/suspicious/noExplicitAny: WebGPURenderer cast
    const r = renderer as any
    const fftThisFrame = fftFrameIdx % fftSkip === 0
    fftFrameIdx++
    // GPU ocean FFT (when ?water=fft + WebGPU backend). Dispatches the
    // compute kernel that re-bakes the slope texture for the current
    // sim time. Fire-and-forget — WebGPU's barrier guarantees the
    // subsequent water draw reads the freshly-written texels. Runs
    // BEFORE the scene-depth snapshot below since they're independent.
    if (gpuFftHandle && fftThisFrame) {
      void gpuFftHandle.tick(field.time, renderer)
    }
    // A2 displacement kernels — fed the same sim clock so all IFFT
    // outputs advance in lockstep. Two independent dispatches, one
    // per cascade (swell + chop). The detail-cascade `gpuFftHandle`
    // is a SEPARATE thing — it produces the high-frequency normal
    // map for the fragment, not vertex displacement.
    if (gpuDisplacementHandle && fftThisFrame) {
      void gpuDisplacementHandle.tick(field.time, renderer)
    }
    if (gpuChopHandle && fftThisFrame) {
      void gpuChopHandle.tick(field.time, renderer)
    }
    if (gpuSwellHandle && fftThisFrame) {
      void gpuSwellHandle.tick(field.time, renderer)
    }
    // A8 — Advance the foam-feedback buffer. Must come AFTER the
    // cascade kernels above so the Jacobian textures it reads are
    // current for this frame. WebGPU compute-to-compute reads are
    // implicitly barriered between dispatches in the same queue, so
    // the foam kernel sees the freshly-written cascade alphas. Gated
    // on the same skip cadence as the cascades — the foam buffer's
    // decay+max step is dt-driven (we accumulate the elapsed sim time
    // between runs and feed the longer dt when we do run), so the
    // temporal-decay profile is preserved across skipped frames.
    if (foamFeedbackHandle && fftThisFrame) {
      const dt = Number.isFinite(foamLastFieldTime)
        ? Math.max(0, field.time - foamLastFieldTime)
        : 0
      foamLastFieldTime = field.time
      void foamFeedbackHandle.tick(dt, renderer)
    }
    // A9 smoke test: dispatch the standalone FFT pipeline if
    // enabled. Output is unused; this just exercises the
    // kernel-build + dispatch path so we catch any errors in the
    // browser console before full integration lands.
    if (fft2dHandle) {
      void fft2dHandle.dispatch(renderer)
    }
    r.getDrawingBufferSize(_sceneDepthSize)
    const w = _sceneDepthSize.x | 0
    const h = _sceneDepthSize.y | 0
    if (w <= 0 || h <= 0) return
    if (sceneDepthTexture.image.width !== w || sceneDepthTexture.image.height !== h) {
      sceneDepthTexture.image.width = w
      sceneDepthTexture.image.height = h
      sceneDepthTexture.needsUpdate = true
    }
    if (typeof r.copyFramebufferToTexture === 'function') {
      r.copyFramebufferToTexture(sceneDepthTexture)
    }
  }

  function tick(impacts?: readonly BikeImpact[], originXZ?: { x: number; z: number }): void {
    tNode.value = field.time
    // Sync the world water-surface Y from the mesh so the shoaling /
    // surf shader reads the right "what's the sea level" value even
    // when callers mutate `mesh.position.y` directly (e.g. tracks with
    // a non-zero `water.height`). Cheap scalar copy per frame.
    waterYUniform.value = mesh.position.y
    if (originXZ) {
      // Snap to integer-meter grid so the mesh doesn't crawl under high-
      // frequency camera jitter — keeps wave phase visually stable when
      // the camera bobbles by < 1 m. The shader still samples world
      // coords so larger camera moves slide the mesh smoothly.
      const ox = Math.round(originXZ.x)
      const oz = Math.round(originXZ.z)
      meshOriginX.value = ox
      meshOriginZ.value = oz
      mesh.position.x = ox
      mesh.position.z = oz
    }
    for (let i = 0; i < MAX_BIKES; i++) {
      const slot = bikeSlots[i]!
      const im = impacts?.[i]
      if (im && im.weight > 0.05) {
        slot.set(im.x, im.z, im.vx, im.vz)
        bikeWeights[i] = im.weight
      } else {
        slot.set(INACTIVE_FAR, INACTIVE_FAR, 0, 0)
        bikeWeights[i] = 0
      }
    }
  }

  function setSunDirection(x: number, y: number, z: number): void {
    const len = Math.hypot(x, y, z) || 1
    sunDirUniform.value.set(x / len, y / len, z / len)
  }

  function setHorizonColor(r: number, g: number, b: number): void {
    horizonHazeUniform.value.set(r, g, b)
  }

  function setTerrainHeightmap(heightmap: import('./terrain-heightmap').TerrainHeightmap): void {
    // Copy the baked heightmap data into the pre-allocated GPU texture
    // so the binding the shader compiled against stays stable. Locked
    // to TERRAIN_HEIGHTMAP_RES on both ends — `buildTerrainHeightmap`
    // emits at the same resolution constant.
    const src = heightmap.texture.image.data as Uint16Array
    if (heightmap.resolution !== TERRAIN_HEIGHTMAP_RES || src.length !== heightmapData.length) {
      // Should never trip — both sides import the same constant — but
      // log loudly if it does so the desync is visible rather than
      // silently producing garbled depth.
      // eslint-disable-next-line no-console
      console.warn(
        `[water] terrain heightmap resolution mismatch: got ${heightmap.resolution}, expected ${TERRAIN_HEIGHTMAP_RES}; ignoring`,
      )
      return
    }
    heightmapData.set(src)
    terrainHeightTex.needsUpdate = true
    terrainMinUniform.value.copy(heightmap.worldMin)
    terrainMaxUniform.value.copy(heightmap.worldMax)
    terrainEnabledUniform.value = 1
  }

  function dispose() {
    geom.dispose()
    mat.dispose()
    terrainHeightTex.dispose()
    gpuFftHandle?.dispose()
    gpuDisplacementHandle?.dispose()
    gpuChopHandle?.dispose()
    gpuSwellHandle?.dispose()
    foamFeedbackHandle?.dispose()
    fft2dHandle?.dispose()
  }

  return {
    mesh,
    tick,
    setSunDirection,
    setHorizonColor,
    setTerrainHeightmap,
    debug,
    dispose,
  }
}

/**
 * Underwater-fog override. Call once per frame AFTER the sky system has
 * updated `scene.fog` for the day-night palette. When the camera is
 * clearly below the resting water surface, this overwrites the fog with
 * a dense water-tinted version — distant terrain disappears into the
 * abyss, nearby geometry gets a teal cast. Above water it restores the
 * sky module's near/far so the per-tick color update reads as air again.
 *
 * Subnautica-style: the dense water fog is what sells "you are underwater"
 * more than any single visual on its own. Bonus: the fog respects the
 * existing receiveShadow / lighting flow, so it just works for terrain,
 * bikes, and props without per-material plumbing.
 *
 * Hysteresis: enter underwater at `cameraY < -0.5`, exit at `cameraY > 0`,
 * so camera bob through the wave crest line doesn't flicker between modes.
 */
const airFogRanges = new WeakMap<THREE.Fog, { near: number; far: number }>()

export function updateUnderwaterFog(scene: THREE.Scene, cameraY: number): void {
  const fog = scene.fog
  if (!(fog instanceof THREE.Fog)) return
  if (cameraY < -0.5) {
    if (!airFogRanges.has(fog)) {
      airFogRanges.set(fog, { near: fog.near, far: fog.far })
    }
    // Saturated underwater teal — slightly brighter than the deep-water
    // albedo so the fog reads as "fluid medium" rather than "black void".
    fog.color.setRGB(0.04, 0.2, 0.3)
    fog.near = 0
    fog.far = 28
  } else if (cameraY > 0) {
    const air = airFogRanges.get(fog)
    if (air) {
      fog.near = air.near
      fog.far = air.far
      airFogRanges.delete(fog)
    }
  }
}
