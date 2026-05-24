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
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { TERRAIN_HEIGHTMAP_RESOLUTION } from '@/engine/render/terrain-heightmap'
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
    /** Beer-Lambert body absorption rate. Scales the per-channel σ
     *  triplet that converts view-ray path-length into transmission.
     *  1.0 = the calibrated default (cyan body reads out to ~10 m of
     *  path). 0 = no absorption (whole body reads as seabedColor,
     *  even in open ocean). 3 = very fast absorption (shallow water
     *  darkens to near-deepColor within 2 m). */
    setBodyAbsorption(s: number): void
    /** Karis sun-disc emissive strength. 0 = no disc, 1 = baseline,
     *  3 = blown-out. Driven by the same horizon-haze tint as the
     *  fresnel emissive, so disc color follows time-of-day. */
    setSunDiscStrength(s: number): void
    /** Anisotropic sun-streak emissive strength. 0 = pure Karis
     *  disc; higher values elongate the highlight along the wave-
     *  front tangent for the SoT "low-sun streak across choppy
     *  water" look. */
    setSunStreakStrength(s: number): void
    /** Streak elongation (σ_along of the 2D Gaussian). Higher =
     *  longer streak; lower = more disc-like. Default 0.4. */
    setStreakElongation(s: number): void
    /** Pinch direction in degrees, 0..90. Rotates the Gerstner
     *  horizontal-displacement vector relative to the per-wave
     *  travel direction. 0° = standard Gerstner (particles bulge
     *  along the wave direction, sharpening crest LINES in the
     *  direction of travel). 90° = particles bulge ALONG the
     *  crest-line axis (perpendicular to wave travel), producing
     *  ridges elongated in the wave-travel direction instead of
     *  short across-axis pinches. */
    setPinchDirection(deg: number): void
    /** Wave-field bearing in degrees, -180..180. Rotates the WHOLE
     *  swell train globally so the user can re-aim the wave
     *  direction (e.g. "waves should be coming toward shore").
     *  Render + CPU buoyancy stay locked — the bearing rotates both
     *  the GPU sample coords and the CPU sampleSurface/sampleHeight
     *  via the shared `field.waveBearing` scalar. */
    setWaveBearing(deg: number): void
    /** Render the wave geometry as wireframe. Useful for tuning wave /
     *  wake amplitudes against the actual displacement. */
    setWireframe(on: boolean): void
    /** Paint each water layer in a distinct flat color (center=red,
     *  outer=green, skirt=blue) so the LOD boundaries between the
     *  three meshes are visible. Used with the water-test track's
     *  camera-locked transition markers to diagnose where seams sit.
     *  No material rebuild — flips a uniform mix factor. */
    setColorize(on: boolean): void
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
  /** Beer-Lambert body absorption rate. 1 = calibrated default. */
  bodyAbsorption: number
  /** Karis sun-disc emissive strength. 1.4 = baseline. */
  sunDiscStrength: number
  /** Anisotropic sun-streak emissive strength. 0.8 = baseline. */
  sunStreakStrength: number
  /** Streak elongation σ_along. 0.4 = baseline. */
  streakElongation: number
  /** Gerstner pinch direction in degrees, 0..90. */
  pinchDirection: number
  /** Wave-field bearing in degrees, -180..180. */
  waveBearing: number
  wireframe: boolean
  /** When true, each water layer paints in a distinct flat color so
   *  LOD seams are visible. Off by default. */
  colorize: boolean
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

/** Cached procedural detail-normal texture — RGBA8 / REPEAT / mipmapped. */
let sharedWaveDetailNormal: THREE.DataTexture | null = null

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

function getWaveDetailNormalTexture(): THREE.DataTexture {
  if (!sharedWaveDetailNormal) {
    sharedWaveDetailNormal = buildWaveDetailNormalTexture()
  }
  return sharedWaveDetailNormal
}

// ---------------------------------------------------------------------------
// Procedural foam-bubble texture.
//
// The SoT SIGGRAPH 2018 paper credits its foam look to "blending the foam
// mask with artist-authored textures." We don't have authored foam art,
// so this builder bakes a tileable two-octave Worley-noise field that
// reads as overlapping bubble clusters. Sampled per-pixel by the foam
// composition; multiplies into `foamMask` so every foam source (wake,
// bow spray, shoreline surf, breaking-wave fold-foam) inherits the same
// bubble structure for free, breaking up the previous smooth-blob foam
// edges into a scrubby cluster look.
//
// Two octaves at different cell densities (16² big bubbles + 32² fine
// bubbles), composited via summed quadratic-falloff distance fields per
// cell. Toroidal cell-index wrap keeps the texture tileable under
// REPEAT sampling. Output is a grayscale R8 packed into RGBA8 (the
// shader reads the .r channel only).
// ---------------------------------------------------------------------------

let sharedFoamBubbleTexture: THREE.DataTexture | null = null

function buildFoamBubbleTexture(): THREE.DataTexture {
  const N = 512
  const data = new Uint8Array(N * N * 4)

  // Deterministic per-cell hash → jittered cell-center offset in [0,1]².
  function hash2(cx: number, cy: number, salt: number): [number, number] {
    const s1 = Math.sin(cx * 12.9898 + cy * 78.233 + salt * 53.123) * 43758.5453
    const s2 = Math.sin(cx * 39.346 + cy * 11.135 + salt * 17.421) * 91234.7891
    return [s1 - Math.floor(s1), s2 - Math.floor(s2)]
  }

  type Octave = { cells: number; weight: number; salt: number; bubbleRadius: number }
  const octaves: Octave[] = [
    // Big bubbles — 16 cells × 16 cells across the 512-pixel tile so each
    // bubble is ~32 px ≈ 1/16 of tile. Reads as the "main bubble cluster"
    // pattern under typical sampling.
    { cells: 16, weight: 0.7, salt: 0, bubbleRadius: 0.55 },
    // Fine bubbles — 32 cells, ~16-px bubbles. Adds the small-bubble
    // grain that catches light when sampled close to the camera.
    { cells: 32, weight: 0.4, salt: 1, bubbleRadius: 0.5 },
  ]

  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      let totalIntensity = 0

      for (const oct of octaves) {
        const cellSize = N / oct.cells
        const cx = Math.floor(px / cellSize)
        const cy = Math.floor(py / cellSize)

        let minDistNorm = Number.POSITIVE_INFINITY
        // 3×3 neighbor cells (with toroidal wrap) so the bubble field is
        // seamless across the tile edge.
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ncx = (((cx + dx) % oct.cells) + oct.cells) % oct.cells
            const ncy = (((cy + dy) % oct.cells) + oct.cells) % oct.cells
            const [hx, hy] = hash2(ncx, ncy, oct.salt)
            const centerPx = (cx + dx + hx) * cellSize
            const centerPy = (cy + dy + hy) * cellSize
            const ddx = px - centerPx
            const ddy = py - centerPy
            const distNorm = Math.hypot(ddx, ddy) / cellSize
            if (distNorm < minDistNorm) minDistNorm = distNorm
          }
        }

        // Bubble: bright at center, falls off to zero by bubbleRadius.
        // Quadratic falloff (`x²`) gives a soft inner highlight + crisp
        // edge that reads like the bright dome of an air bubble rather
        // than a uniform spot.
        const f = Math.max(0, 1 - minDistNorm / oct.bubbleRadius)
        totalIntensity += oct.weight * f * f
      }

      // Slight gamma lift so the texture's perceptual range hits [0,1].
      const v = Math.min(1, totalIntensity ** 0.85)
      const byte = Math.round(v * 255)
      const idx = (py * N + px) * 4
      data[idx + 0] = byte
      data[idx + 1] = byte
      data[idx + 2] = byte
      data[idx + 3] = 255
    }
  }

  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.name = 'water:foamBubbles'
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

function getFoamBubbleTexture(): THREE.DataTexture {
  if (!sharedFoamBubbleTexture) {
    sharedFoamBubbleTexture = buildFoamBubbleTexture()
  }
  return sharedFoamBubbleTexture
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
  const size = opts?.size ?? 960
  // 768 subs × 960 m ≈ 1.25 m vertex spacing. The mesh follows the
  // camera (see `tick`'s `originXZ` arg + the meshOrigin uniform), so the
  // 960 m of mesh stays centered on the visible patch instead of being
  // anchored at world origin (with the player at z ≈ 90 sitting near the
  // edge). 960 m half-extent (480 m to each side, ~680 m at the corners)
  // pushes the geometric edge well below the bike-POV horizon line, so
  // the center→outer cross-fade band (see `centerEdgeFade` below) lands
  // where it reads as a continuous tone shift rather than a sharp seam.
  // At 1.25 m spacing the 4 m wake wavelength still gets ~3.2 verts per
  // crest — ridges read as geometry, not single-vertex shimmer. 768²
  // ≈ 590 k verts stays sub-millisecond on a real GPU.
  const subs = opts?.subdivisions ?? 768

  // ---- Debug toggles ----------------------------------------------------
  // Analytic-Gerstner displacement + procedural detail-normal map +
  // SoT-style fragment shading (Beer-Lambert depth, Karis sun disc,
  // anisotropic streak, bubble foam, height whitecaps, three-color
  // blend) is the only path. `?wire=1` renders the displaced mesh as
  // wireframe; `?steep=<n>` overrides the initial steepness scale;
  // `?reflect=0` disables the planar reflection pass for perf tests;
  // `?aa=off` drops MSAA so the scene-depth copy (and its shoreline
  // foam) can run on WebGPU.
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null

  // Scene-depth copy is forbidden when the framebuffer is multisampled —
  // `copyFramebufferToTexture` would try to copy a 4-sample depth attachment
  // into our 1-sample `sceneDepthTexture` and WebGPU invalidates the entire
  // command buffer at submit time, blanking the frame. MSAA is on by default
  // on WebGPU (renderer.ts antialias=true), so we skip the copy in that case
  // and accept the visual cost: shoreline foam from scene-depth comparison
  // is suppressed (the shader keeps a sane default), but the rest of the
  // surface renders normally. Players who want the shoreline foam back can
  // pass `?aa=off` to drop MSAA — the copy then succeeds.
  // WebGL2 + WebGPU-with-`?aa=off` both keep the copy.
  const aaOn = params?.get('aa') !== 'off'
  const disableSceneDepthCopy = opts?.backend === 'webgpu' && aaOn
  const wireFlag = params?.get('wire') === '1'

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
  const initialSteepness = Math.max(0, Math.min(1.5, Number(params?.get('steep') ?? '0.7')))
  const steepnessUniform = uniform(initialSteepness)

  // Pinch direction (degrees, 0..90). Rotates the Gerstner horizontal-
  // displacement vector relative to wave direction. 0° = standard
  // (along wave, sharpens crest LINES in direction of travel); 90° =
  // perpendicular (along crest-line axis, elongates ridges in the
  // direction the wave is moving). Stored as pre-computed cos/sin
  // pair so the rotation lives on the GPU side as two multiplies.
  const PINCH_DIRECTION_DEFAULT = 0
  const pinchDirectionUniform = uniform(PINCH_DIRECTION_DEFAULT)
  const pinchCosUniform = uniform(Math.cos((PINCH_DIRECTION_DEFAULT * Math.PI) / 180))
  const pinchSinUniform = uniform(Math.sin((PINCH_DIRECTION_DEFAULT * Math.PI) / 180))

  // Wave bearing (degrees, -180..180). Rotates the WHOLE wave field's
  // travel direction in world XZ so the user can re-aim the swell
  // train (e.g. "waves should be coming toward the island"). Applied
  // as a 2D rotation on the sample (x, z) before the phase calc —
  // mathematically equivalent to rotating every wave's (dirX, dirZ)
  // by +bearing without mutating the per-wave consts. Slopes that
  // come out of the phase calc are in the ROTATED frame and rotated
  // back to world XZ via the inverse rotation before being used by
  // the normal / shading pipeline (see `worldDydx`, `worldDydz`
  // below). CPU buoyancy mirrors this in `wave-field.ts::sampleSurface`
  // so render and physics stay locked.
  const WAVE_BEARING_DEFAULT = 0
  const waveBearingDegUniform = uniform(WAVE_BEARING_DEFAULT)
  const waveBearingCosUniform = uniform(Math.cos((WAVE_BEARING_DEFAULT * Math.PI) / 180))
  const waveBearingSinUniform = uniform(Math.sin((WAVE_BEARING_DEFAULT * Math.PI) / 180))

  // ---- Tunable scalars (water debug menu) -------------------------------
  // Each is a uniform so the menu can scrub it live without rebuilding the
  // material. Defaults match the values the v2 shader was authored against;
  // RESET in the menu restores them via `waterMesh.debug.defaults`.
  // Reflection cap pulled down from 0.85 → 0.55 so the deep turquoise
  // water body actually reads through the surface — at 0.85 fresnel at
  // race-camera-low view angles painted nearly the whole surface with
  // reflected horizon, hiding the wave color. 0.55 lets the body color
  // dominate troughs and reflection take over only at the truly grazing
  // edges where Schlick fresnel already saturates.
  const REFLECTION_STRENGTH_DEFAULT = 0.55
  const SUN_GLOW_DEFAULT = 0.6
  // Roughness base bumped back up — the previous 0.12 lit every chop
  // wavelet with a tight specular dot which the close-in band rendered
  // as a "sparkle storm" across the surface. 0.22 fuzzes the lobe so
  // close-in highlights blur into broader glints; sparkle patches
  // still tighten roughness toward `ROUGH_SPARKLE_DEFAULT` for the
  // wandering bright-glint character.
  const ROUGH_BASE_DEFAULT = 0.22
  const ROUGH_SPARKLE_DEFAULT = 0.06
  // Sub-Gerstner detail-normal strength. Pulled down from 1.4 → 0.5.
  // The previous value piled slopes onto every surface fragment and
  // pushed pixelFoam → 1 everywhere there was any chop, blowing the
  // surface out to white. The reference target wants clean glassy
  // wave faces (turquoise body visible through the surface) with
  // detail only providing texture, not silhouette. 0.5 keeps the
  // mip-filtered close-in chop reading as surface texture but doesn't
  // hijack the big-wave silhouette. `?detail=0` parks this at 0 for
  // A/B; `?detail=hi` (handled below) re-enables the punchier 1.4
  // for tracks that want the busier surface.
  const DETAIL_STRENGTH_DEFAULT = 0.5
  const reflStrengthUniform = uniform(REFLECTION_STRENGTH_DEFAULT)
  const sunGlowUniform = uniform(SUN_GLOW_DEFAULT)
  const roughBaseUniform = uniform(ROUGH_BASE_DEFAULT)
  const roughSparkleUniform = uniform(ROUGH_SPARKLE_DEFAULT)
  const detailStrengthUniform = uniform(DETAIL_STRENGTH_DEFAULT)
  // Debug colorize. When `debugColorizeMixUniform` is 1 each of the three
  // water layers is painted in a distinct flat color so the boundaries
  // between center mesh / outer LOD tile / horizon skirt are obvious —
  // pairs with the camera-locked transition markers used by the
  // water-test track to make the LOD architecture visible. The center
  // mesh's emissive (foam, sun glow, sun disc/streak) is faded by the
  // same factor so the colored zone reads clean rather than being
  // washed out by highlights.
  const CENTER_DEBUG_COLOR_DEFAULT = new THREE.Color(0.95, 0.18, 0.18)
  const OUTER_DEBUG_COLOR_DEFAULT = new THREE.Color(0.18, 0.85, 0.32)
  const SKIRT_DEBUG_COLOR_DEFAULT = new THREE.Color(0.22, 0.45, 0.98)
  const centerDebugColorUniform = uniform(CENTER_DEBUG_COLOR_DEFAULT)
  const outerDebugColorUniform = uniform(OUTER_DEBUG_COLOR_DEFAULT)
  const skirtDebugColorUniform = uniform(SKIRT_DEBUG_COLOR_DEFAULT)
  const debugColorizeMixUniform = uniform(0)
  // Per-group amplitude scales — one for swells (waves 0–1), one for chops
  // (waves 2–5). Both default to 1.0 (no scale). The shader multiplies the
  // baked per-wave constants by these uniforms; the CPU buoyancy mirrors
  // by mutating `field.waves[i].amplitude` directly so the two paths stay
  // in lockstep. Baseline amplitudes are captured here so toggling the
  // scales preserves the relative balance of the wave preset.
  const SWELL_INDICES = new Set([0, 1])
  const swellScaleUniform = uniform(1)
  const chopScaleUniform = uniform(1)
  // Per-wave baseline amplitudes — captured here so the swell/chop
  // scale sliders can restore the original balance after scrubbing.
  const baseAmplitudes = field.waves.map((w) => w.amplitude)
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
  const waveConsts: WaveConst[] = field.waves.map((w, i) => {
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
    // Apply the global wave-bearing rotation to the sample coords —
    // equivalent to rotating every wave's (dirX, dirZ) by +bearing.
    // Slopes accumulate in the rotated frame and get rotated back to
    // world frame after the per-wave loop (chain rule).
    const xRot = xN.mul(waveBearingCosUniform).add(zN.mul(waveBearingSinUniform))
    const zRot = xN.mul(waveBearingSinUniform.negate()).add(zN.mul(waveBearingCosUniform))
    const y = float(0).toVar()
    const rotDydx = float(0).toVar()
    const rotDydz = float(0).toVar()
    for (let i = 0; i < waveConsts.length; i++) {
      const w = waveConsts[i]!
      const ampScale = SWELL_INDICES.has(i) ? swellScaleUniform : chopScaleUniform
      const phase = float(w.k * w.dirX)
        .mul(xRot)
        .add(float(w.k * w.dirZ).mul(zRot))
        .sub(tN.mul(w.omega))
        .add(float(w.phase))
      const s = sin(phase)
      const c = cos(phase)
      y.addAssign(s.mul(w.amp).mul(ampScale))
      rotDydx.addAssign(c.mul(w.amp * w.k * w.dirX).mul(ampScale))
      rotDydz.addAssign(c.mul(w.amp * w.k * w.dirZ).mul(ampScale))
    }
    // Rotate the rotated-frame slopes back to world XZ.
    const dydx = rotDydx.mul(waveBearingCosUniform).sub(rotDydz.mul(waveBearingSinUniform))
    const dydz = rotDydx.mul(waveBearingSinUniform).add(rotDydz.mul(waveBearingCosUniform))
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
    // Bearing-rotated sample coords (same convention as gerstnerHeight).
    const xRot = xN.mul(waveBearingCosUniform).add(zN.mul(waveBearingSinUniform))
    const zRot = xN.mul(waveBearingSinUniform.negate()).add(zN.mul(waveBearingCosUniform))
    // dx, dz accumulate in the rotated frame; we rotate back to world
    // XZ at the end so the horizontal displacement applied to the
    // vertex position uses world coordinates.
    const dxRot = float(0).toVar()
    const dzRot = float(0).toVar()
    const qSum = float(0).toVar()
    for (let i = 0; i < waveConsts.length; i++) {
      const w = waveConsts[i]!
      const ampScale = SWELL_INDICES.has(i) ? swellScaleUniform : chopScaleUniform
      const phase = float(w.k * w.dirX)
        .mul(xRot)
        .add(float(w.k * w.dirZ).mul(zRot))
        .sub(tN.mul(w.omega))
        .add(float(w.phase))
      const s = sin(phase)
      const c = cos(phase)
      const qScaled = steepnessUniform.mul(float(w.qBase))
      // Horizontal displacement: P.x += Q·A·D.x · cos(phase),
      //                          P.z += Q·A·D.z · cos(phase)
      //
      // The displacement DIRECTION is rotated by `pinchDirection`
      // (a uniform-driven 2D rotation) from the wave direction
      // (dirX, dirZ). At 0° the displacement runs along the wave,
      // particles bulge forward, and crest LINES sharpen in the
      // direction of travel — standard Gerstner. At 90° the
      // displacement runs along the crest-line axis (the
      // perpendicular: (-dirZ, dirX)), so particles bulge along
      // the crest and the wave reads as elongated ridges running
      // in the direction of travel instead of short across-axis
      // bumps. CPU buoyancy samples a heightfield (no horizontal
      // displacement read) so this is render-only — the bike sits
      // at the same y(x,z) regardless of pinch direction.
      const rotDirX = float(w.dirX).mul(pinchCosUniform).sub(float(w.dirZ).mul(pinchSinUniform))
      const rotDirZ = float(w.dirX).mul(pinchSinUniform).add(float(w.dirZ).mul(pinchCosUniform))
      dxRot.addAssign(qScaled.mul(rotDirX).mul(float(w.amp)).mul(c).mul(ampScale))
      dzRot.addAssign(qScaled.mul(rotDirZ).mul(float(w.amp)).mul(c).mul(ampScale))
      // Normal y-component reduction: Σ Q · k · A · sin(phase)
      qSum.addAssign(
        qScaled
          .mul(float(w.k * w.amp))
          .mul(s)
          .mul(ampScale),
      )
    }
    // Rotate the rotated-frame horizontal displacement back to
    // world XZ so the vertex shader can add it to positionLocal.xz
    // in world coords.
    const dx = dxRot.mul(waveBearingCosUniform).sub(dzRot.mul(waveBearingSinUniform))
    const dz = dxRot.mul(waveBearingSinUniform).add(dzRot.mul(waveBearingCosUniform))
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
  // Big-wave source: sums the unrolled `waveConsts` array analytically
  // per vertex. Returns vec3(y, dy/dx, dy/dz) for the heightfield part
  // and vec3(dx, dz, qSum) for the Tessendorf horizontal-displacement
  // part; `qSum` is the GPU-Gems-eq.13 normal-Y reduction from
  // horizontal pinching, used downstream by the SoT-style peak-mask
  // SSS path.
  const vertexHeight = gerstnerHeight(worldX, worldZ, tNode)
  const vertexDisp = gerstnerDisp(worldX, worldZ, tNode)
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
  const vertexFoamAccum = foamAccumulator(worldX, worldZ, tNode).mul(shoalFactor)

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
  // Wave-peak mask — the magnitude of the horizontal Tessendorf
  // displacement (λ·Dx, λ·Dz) already in `attenDispX`/`attenDispZ`.
  // Sea of Thieves' SIGGRAPH 2018 talk credits this signal as the
  // gate for their subsurface-scattering color blend: choppy peaks
  // pinch large displacements, and those are the spots where light
  // travels a short path through the wave, so they read as bright
  // scatter. We expose it as a varying so the fragment can use it
  // to push scatter on pinched crests independent of raw height
  // (a flat-but-pinching wave face is a peak too).
  //
  // attenDispX/Z are the closed-form Tessendorf horizontal pinch
  // (qSum·Dx, qSum·Dz) summed across the 6 waves.
  const peakSignal = attenDispX.mul(attenDispX).add(attenDispZ.mul(attenDispZ)).sqrt()
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
  // Detail-cascade texture — the procedural 22-sine analytic bake.
  // RGBA8 / REPEAT / mipmapped, sampled below at two world-XZ scales.
  const detailTex: THREE.Texture = getWaveDetailNormalTexture()
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
  // Color-ramp ranges widened to (-2, 2) — at the bumped amplitude the
  // visible wave heightFrag often saturated the previous tight (-0.5,
  // 0.5) window across most of a single wave face, which produced
  // visible HEIGHT ISOLINES (banded color stripes along the surface
  // that traced contours of constant height). Stretching the input
  // range lets the smoothstep transition over the full natural wave
  // amplitude so the deep→scatter gradient reads as smooth shading
  // instead of contour lines.
  const heightNorm = smoothstep(float(-2.0), float(2.0), heightFrag)
  const heightFactor = smoothstep(float(-1.5), float(1.5), heightFrag)
  // Deep ocean body color. Pushed from a nearly-black navy
  // (0.01, 0.09, 0.20) to a visibly turquoise-cyan so the body of
  // the water reads as ocean instead of a void. Reference: clear
  // tropical seawater transmits 470–500 nm (cyan) up to ~10 m
  // before absorption dominates, which is what gives reef water
  // its glowing aqua body. We're a deep open-water scene so we
  // keep red low (long-wavelength absorption is fast), but the
  // green+blue channels are raised so the surface paints a visible
  // turquoise even where the fresnel reflection would otherwise
  // dominate. Classic preset unchanged for A/B.
  const deepColor = vec3(0.02, 0.22, 0.32)
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
  // Mid-water scatter brightened toward saturated tropical turquoise.
  // Previous (0.18, 0.78, 0.78) was a flat teal that read as fabric
  // when sun-lit. The reference target's "tube glow" comes from light
  // travelling through the wave body and emerging cyan — we want
  // crests to PUNCH this color toward the camera, so a higher
  // green+blue (and a touch of red) gives a brighter perceived
  // brightness without losing the ocean hue.
  const scatterColor = vec3(0.22, 0.85, 0.92)
  // SSS — the SoT three-color recipe's "lit from within" glow on
  // pinched crests. Push toward bright tropical-tube turquoise rather
  // than yellow-green: a Pipeline surf-photo lip is white-cyan, not
  // chartreuse. Previous (0.20, 0.95, 0.50) read distractingly green.
  const sssColor = vec3(0.35, 0.95, 0.85)

  // Beer-Lambert depth absorption — the missing piece that was making
  // our water read as "perfectly clear" vs SoT's depth-varied body.
  //
  // Physics: each spectral channel of light attenuates exponentially
  // with path length through water, `T = exp(-σ · t)`. Red absorbs
  // fastest (long wavelength → high σ), green moderately, blue almost
  // not at all — that's why deep ocean reads navy and shallow reads
  // cyan-green. σ values are tuned for stylized clarity (real
  // open-ocean σ_R is closer to 0.7/m and would absorb to navy by
  // 5 m; we keep some color reach so the surf-photo cyan body reads
  // out to ~10 m of path, which is the visual target).
  //
  // Path length uses the FLAT vertical water depth (`waterDepthFrag`)
  // with a 1/ndotv grazing correction, NOT the view-ray closeness.
  // The view-ray version varied per-vertex with wave displacement
  // (crest vs trough), producing visible "contour-stripe" bands
  // along constant-height isolines of the wave surface — the user-
  // flagged wave-stripe artifact. Vertical depth is independent of
  // wave displacement, so the body color reads as smooth gradient
  // across each wave face instead of contour lines.
  //
  // "Sandy seabed" assumed bright cyan-white for the transmitted
  // term. Where there's no real seabed (open ocean past the
  // heightmap), waterDepthFrag is the DEEP_SENTINEL (very large
  // positive number) → transmission → 0 → body collapses to
  // deepColor, which is what we want for open ocean.
  // 0.7 (down from 1.0) — the per-channel σ triplet softens, so the
  // body colour holds onto more of the bright seabedColor across mid-
  // depths instead of collapsing to deepColor by 3 m of path. Paired
  // with the lower shallow-water alpha (see `seabedSeeThrough` below),
  // it means the seabed reads visibly through the water in shallow-to-
  // mid depths without the water layer adding a heavy cyan overcoat.
  const BODY_ABSORPTION_DEFAULT = 0.7
  const bodyAbsorptionUniform = uniform(BODY_ABSORPTION_DEFAULT)
  const sigmaR = float(0.35).mul(bodyAbsorptionUniform)
  const sigmaG = float(0.06).mul(bodyAbsorptionUniform)
  const sigmaB = float(0.015).mul(bodyAbsorptionUniform)
  // Approximate the view-ray path length through water as
  // (vertical depth) / cos(view angle from vertical), clamped so
  // grazing samples don't blow up to infinity. cos(view from
  // vertical) is the y-component of the view direction, which we
  // approximate from ndotv on the FLAT plane — using the normal
  // would re-introduce wave-displacement banding here too.
  const verticalViewForOpticalPath = max(viewDir.y, float(0.15))
  const opticalPath = max(waterDepthFrag, float(0)).div(verticalViewForOpticalPath)
  const transR = exp(sigmaR.mul(opticalPath).negate())
  const transG = exp(sigmaG.mul(opticalPath).negate())
  const transB = exp(sigmaB.mul(opticalPath).negate())
  const seabedColor = vec3(0.85, 0.92, 0.85)
  // "Do we have real depth data" gate. Without a terrain heightmap
  // installed, `vertexWaterDepth` returns the deep sentinel
  // (`waterY − -10000` = ~10004) — so a tiny depth reading means
  // either a pixel sitting right at the water-line OR no heightmap
  // is bound. Smooth over the first half-meter and resolve to "treat
  // as deep" for the no-data case so open ocean doesn't accidentally
  // get seabed transmission.
  const depthValidGate = smoothstep(float(0.25), float(0.75), waterDepthFrag)
  // Beer-Lambert: body = deepColor·(1−T) + seabedColor·T per channel.
  // Multiplying by depthValidGate folds in the validity check —
  // gate=0 collapses to deepColor regardless of T.
  const beerLambertBody = vec3(
    mix(
      deepColor.x,
      deepColor.x.mul(float(1).sub(transR)).add(seabedColor.x.mul(transR)),
      depthValidGate,
    ),
    mix(
      deepColor.y,
      deepColor.y.mul(float(1).sub(transG)).add(seabedColor.y.mul(transG)),
      depthValidGate,
    ),
    mix(
      deepColor.z,
      deepColor.z.mul(float(1).sub(transB)).add(seabedColor.z.mul(transB)),
      depthValidGate,
    ),
  )
  const tintedDeepColor = beerLambertBody
  // Shallow-gate (separate from the body color blend above) for the
  // caustic veining below — caustics fade out in deep water because
  // real seabed caustics dim with depth. 0..1 ramp over the first 8 m
  // of closeness.
  const shallowFactor = float(1).sub(smoothstep(float(0), float(8), closeness))

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
  const sunBackscatter = pow(max(float(0), dot(viewDir.negate(), sunDirUniform)), float(2))

  // SoT-style choppiness peak mask: `length(λ·Dx, λ·Dz) / scale`
  // saturated to [0, 1]. Where the Tessendorf horizontal pinch is
  // large (= near a crest about to break), light has a shorter path
  // through the wave body so subsurface scatter dominates. The scale
  // divisor sets where the mask saturates — peakSignal peaks around
  // ~0.4 m on choppy crests at our amplitudes, so dividing by 0.35
  // lands the mask at full strength on visible peaks without needing
  // extreme pinching.
  const peakMaskScaled = clamp(peakMaskFrag.div(float(0.35)), float(0), float(1))
  // Crest scatter ramps with height; grazing view bumps it; sun
  // backlight bumps it further. Combined boost can exceed 1.0 (we
  // clamp at the end so deep troughs stay dark even with sun
  // alignment). This drives the legacy scatter-color blend (cyan-
  // green) — the warmer SSS color is layered on top below via the
  // peak mask.
  const scatterAmount = (() => {
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
  const sssGate = clamp(peakMaskScaled.mul(sunBackscatter.add(float(0.35))), float(0), float(1))
  // SSS mix uncapped (was 0.55) so on perfect peaks with sun
  // backlighting, the subsurface color fully dominates — that's the
  // "tube glow" effect from the SoT recipe ("we blend between a deep
  // water colour and a sub-surface water colour"). The 0.55 cap was
  // a holdover from an earlier conservative tune; with the
  // brightened scatter + sss colors and proper peak masking, full
  // mix gives crests the lit-from-within cyan punch without
  // washing the rest of the surface (sssGate already restricts to
  // pinched crests × sun alignment).
  const baseColorPreCaustic = mix(scatterBlended, sssColor, sssGate)

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
  const causticIntensity = causticPattern
    .mul(shallowFactor)
    .mul(ndotv)
    .mul(causticDistFade)
    .mul(float(0.55))
  // A cool aqua boost — same family as scatterColor but a touch lighter
  // so caustics read as "bright spots on the sand" rather than "more
  // surface color". Goes through the lighting model so shadow + night
  // dim it naturally.
  const causticColor = vec3(0.45, 0.85, 0.78)
  const baseColor = baseColorPreCaustic.add(causticColor.mul(causticIntensity))

  // Sun glow emissive — additive on top of the scatter blend for the
  // unmistakable SoT "lit-from-behind" wave glow. Peaks on tall crests
  // (`heightFactor`) lit from behind (`sunBackscatter`), tinted with
  // scatterColor.
  const sunGlow = scatterColor.mul(sunBackscatter.mul(heightFactor).mul(sunGlowUniform))

  // Karis-style sun disc reflection (SoT SIGGRAPH 2018, citing UE4's
  // closest-point-on-sphere). Standard MeshStandardNodeMaterial
  // gives a tight pin-prick specular at sun position; SoT widens
  // that into a finite disc + halo so the "bright low-sun reflection
  // streak" reads as a real area light rather than a hot pixel.
  //
  // Per-pixel: reflect view through the surface normal, take the
  // dot product with the sun direction. A two-stop smoothstep
  // (tight inner core + wide softer halo) maps that to disc
  // intensity. Tinted by the horizon-haze color which is already
  // tracking the sky palette tick-by-tick, so a sunset disc is
  // peach-warm and a midday disc is cool-white automatically.
  //
  // Off in classic mode.
  const reflView = viewDir.negate()
  const reflRay = reflView.sub(normalNode.mul(dot(reflView, normalNode).mul(float(2))))
  const sunAlign = max(float(0), dot(reflRay, sunDirUniform))
  // Inner core: ~3° half-angle (cos(3°) ≈ 0.9986). Outer halo:
  // ~12° half-angle (cos(12°) ≈ 0.978). Lower-sun atmospheric
  // smear bumps the effective halo on top of this.
  const sunDiscCore = smoothstep(float(0.9986), float(0.9999), sunAlign)
  const sunDiscHalo = smoothstep(float(0.978), float(0.998), sunAlign).mul(float(0.45))
  const sunDiscIntensity = max(sunDiscCore, sunDiscHalo)
  const sunDiscColor = horizonHazeUniform
  // Sun-disc strength uniform so the debug menu can scrub the
  // bright low-sun reflection without rebuilding the material.
  const SUN_DISC_STRENGTH_DEFAULT = 1.4
  const sunDiscStrengthUniform = uniform(SUN_DISC_STRENGTH_DEFAULT)
  const sunDisc = sunDiscColor.mul(sunDiscIntensity).mul(sunDiscStrengthUniform)

  // Anisotropic specular streak along wave fronts. SoT's low-sun
  // reflection isn't a clean Karis disc — it elongates into a
  // streak along the wave-front tangent direction because each
  // wave's normal sweeps across a range of angles AS YOU MOVE
  // ALONG the wave front. Proper anisotropic PBR needs a custom
  // BSDF (MeshStandardNodeMaterial doesn't support an anisotropy
  // direction), so we approximate the look via an emissive
  // contribution that uses a Gaussian-like falloff with different
  // sigmas in (along-wave-front) vs (across-wave-front) — visually
  // identical for the bright-streak use case.
  //
  // We use the surface slope gradient (effDydx, effDydz) to find
  // the wave-front tangent direction in the horizontal plane.
  // Where the slope is small (flat water), this collapses to a
  // disc; where slope is large (steep wave face), the streak
  // dominates and aligns with the wave-front.
  const slopeXZ = vec2(effDydx, effDydz)
  const slopeMagXZ = max(slopeXZ.length(), float(0.0001))
  // Slope direction (uphill) + wave-front tangent (perpendicular).
  const slopeDirN = slopeXZ.div(slopeMagXZ)
  const waveFrontN = vec2(slopeDirN.y.negate(), slopeDirN.x)
  // Horizontal components of sun direction + reflection ray.
  const sunH = vec2(sunDirUniform.x, sunDirUniform.z)
  const reflH = vec2(reflRay.x, reflRay.z)
  const deltaH = sunH.sub(reflH)
  // Project onto wave-front tangent (along the streak) vs slope
  // direction (across the streak). Squared distances feed a 2D
  // Gaussian with anisotropic sigmas — wide along (0.40) lets the
  // streak elongate, tight across (0.06) keeps it visually thin.
  const along = dot(deltaH, waveFrontN)
  const across = dot(deltaH, slopeDirN)
  // Streak elongation = sigmaAlong (wider sigma => longer streak
  // along the wave-front tangent). Live-tunable via the debug menu.
  // sigmaAcross stays fixed at 0.06 — it's the "how thin is the
  // streak" knob that needs to stay tight for the look to read as
  // a streak vs a circular smear.
  const STREAK_ELONGATION_DEFAULT = 0.4
  const streakElongationUniform = uniform(STREAK_ELONGATION_DEFAULT)
  const sigmaAlong = streakElongationUniform
  const sigmaAcross = float(0.06)
  const streakArg = along
    .mul(along)
    .div(sigmaAlong.mul(sigmaAlong))
    .add(across.mul(across).div(sigmaAcross.mul(sigmaAcross)))
  // Streak only fires where the slope is non-trivial (waveFront
  // tangent is meaningful) AND the reflection aligns roughly with
  // the sun horizontally. Slope gate ramps in over 0.05–0.20 of
  // slope magnitude so calm patches don't get spurious streaks.
  const slopeGate = smoothstep(float(0.05), float(0.2), slopeMagXZ)
  const sunHGate = max(float(0), dot(reflH.normalize(), sunH.normalize()))
  const streakIntensity = exp(streakArg.negate()).mul(slopeGate).mul(sunHGate)
  // Sun-streak strength uniform so the debug menu can scrub the
  // anisotropic wave-front reflection streak independently of the
  // disc above. 0 = no streak (just the Karis disc); higher values
  // brighten the elongated highlight.
  const SUN_STREAK_STRENGTH_DEFAULT = 0.8
  const sunStreakStrengthUniform = uniform(SUN_STREAK_STRENGTH_DEFAULT)
  const sunStreak = sunDiscColor.mul(streakIntensity).mul(sunStreakStrengthUniform)

  // Wave-driven foam — two stacked layers via max():
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
  // the hard-zero smoothstep so very small slopes still produce a wisp
  // of foam rather than snapping off — eliminates the foam/no-foam
  // threshold edge entirely.
  const pixelSlope = sqrt(effDydx.mul(effDydx).add(effDydz.mul(effDydz)))
  // pow(.,3) keeps pixelFoam near 0 until the slope really spikes.
  const pixelFoam = pow(clamp(pixelSlope.mul(float(0.5)), float(0), float(1)), float(3.0))
  // Shared turbulent foam noise — world XZ + time scroll. Used to break
  // up the otherwise-too-clean foam edges of shoreline, wake, and bow
  // spray so they all read as living turbulence instead of stamped
  // outlines.
  //
  // The same noise is sampled by:
  //   - shoreline foam range (lapping in/out by ±0.2m via `foamNoiseRaw`)
  //   - wake foam intensity (multiplicative `foamTurbulence`)
  //   - bow spray intensity (multiplicative `foamTurbulence`)
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
  // Subtler variant for wave-crest foam fibers. [0.6, 1.0] gives whitecaps
  // visible structure (splotches with subtle brightness variation) without
  // speckling — wider ranges read as TV-static when foam is widespread.
  const foamFiber = mix(float(0.6), float(1.0), foamNoiseSmooth)

  // Height-driven whitecap foam — SoT's "foam at wave peaks" recipe.
  // heightWhitecap requires meaningful elevation; slopeWhitecap requires
  // chop pinching so a flat-but-tall swell stays glassy. `foamFiber`
  // modulates with the shared foam noise.
  const heightWhitecap = smoothstep(float(1.0), float(2.0), heightFrag)
  const slopeWhitecap = smoothstep(float(0.3), float(0.7), pixelSlope)
  const whitecapFoam = heightWhitecap.mul(slopeWhitecap).mul(foamFiber)
  // History-accumulated foam (the time-shifted Gerstner sampler builds
  // a lingering trail behind each passing crest, since the analytic
  // formula is bit-identical between past and present) plus softened
  // pixelFoam and whitecapFoam — the three combine to give crests both
  // an active highlight and a fading trail.
  const waveFoam = max(max(foamAccumFrag.mul(float(0.7)), pixelFoam), whitecapFoam)

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
  // would read negative closeness and falsely trigger foam.
  const intersectionFoam = (() => {
    // Wide band of soft foam that reaches 6 m off-shore + a tight
    // bright peak right at the water-line. Two layers maxed together:
    //   - `bandFoam`   — 0..1 over a breathing depth range, with the
    //                    falloff biased so the half-mark is still
    //                    quite bright. Reads as a surf zone rather
    //                    than a thin ribbon.
    //   - `peakFoam`   — narrow bright lip in the first ~1 m of
    //                    submersion. This is the unmistakable "foam
    //                    at the geometry edge" beat.
    const FOAM_BAND_BASE = 6.0
    const PEAK_RANGE = 1.0
    const behindGate = smoothstep(float(-0.05), float(0.05), closenessSigned)
    // Lapping shoreline: the depth threshold breathes ±1.0 m around
    // the 6.0 m base as the shared foam noise scrolls.
    const noiseRangeOffset = foamNoiseRaw.sub(float(0.5)).mul(float(2.0))
    const bandRangeNow = float(FOAM_BAND_BASE).add(noiseRangeOffset)
    // Pow-0.4 falloff: fuller-bright across more of the band. At half
    // the band depth, foam still reads at ~0.76 brightness.
    const bandLinear = float(1).sub(clamp(closeness.div(bandRangeNow), float(0), float(1)))
    const bandFoam = pow(bandLinear, float(0.4))
    // Tight bright peak right at the intersection — the unmistakable
    // waterline lip on top of the wider band.
    const peakLinear = float(1).sub(smoothstep(float(0), float(PEAK_RANGE), closeness))
    const peakFoam = peakLinear.mul(float(1.15))
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
  // so the surf line breathes with the wave field instead of sitting
  // as a static foam ring. Inactive when no heightmap is installed
  // (waterDepthFrag stays ≈ +10000 → shoreBand ≈ 0).
  const shorelineSurf = (() => {
    // Strong only in the last ~3 m of depth — same envelope as the
    // vertex shoaling so foam and damped geometry align.
    const SURF_BAND_DEPTH = 3.0
    const shoreBand = float(1).sub(smoothstep(float(0), float(SURF_BAND_DEPTH), waterDepthFrag))
    // Crest signal: the un-attenuated ambient wave height. Positive
    // values are wave faces marching toward shore — exactly what we
    // want to "break" into surf. Using the pre-attenuation height
    // means the pulse cadence stays locked to the natural wave period
    // even where the geometry is being damped.
    const crestSignal = clamp(ambientHeightFrag, float(0), float(1.5))
    // Pow-1.6 biases the response: small crests produce faint surf;
    // once a real crest arrives, foam saturates fast.
    const crestBreaker = pow(smoothstep(float(0.05), float(0.6), crestSignal), float(1.6))
    // Persistent waterline lip — always-on faint band at the shoreline
    // edge (≤ 0.5 m depth) so the boundary never disappears between
    // crests, even on calm seas.
    const waterlineBase = float(1)
      .sub(smoothstep(float(0), float(0.5), waterDepthFrag))
      .mul(float(0.35))
    const turbulence = mix(float(0.7), float(1.15), foamNoiseSmooth)
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
  const foamMaskRaw = clamp(
    max(max(waveFoam.add(bikeFoam), intersectionFoam), shorelineSurf),
    float(0),
    float(1),
  )
  // Foam bubble texture — the SoT "authored bubble" layer. Sampled at
  // world XZ so bubbles read as a property of the surface (they don't
  // move with the camera) but with a slow wind-aligned scroll so the
  // foam visually drifts with the air-foam buffer's advection. 4 m tile
  // → bubbles read ~25-50 cm in race-camera space. The R channel holds
  // the Worley-cluster pattern; G/B/A are unused.
  //
  // The bubble pattern modulates `foamMask` so every foam source —
  // wake, bow spray, shoreline surf, breaking-wave fold-foam — inherits
  // bubble structure. mix(0.35, 1.0, bubble) keeps strong-foam zones
  // bright while breaking dim-foam edges into discrete bubble blobs.
  const foamBubbleTex = getFoamBubbleTexture()
  const foamBubbleUV = positionWorld.xz
    .div(float(4.0))
    .add(vec2(tNode.mul(float(0.012)), tNode.mul(float(-0.008))))
  // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
  const foamBubbleSample = texture(foamBubbleTex, foamBubbleUV) as any
  const foamBubblePattern = foamBubbleSample.r
  const foamMask = foamMaskRaw.mul(mix(float(0.35), float(1.0), foamBubblePattern))
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
  const reflectFlag = params?.get('reflect') !== '0'
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
  // beneath the haze, not solid sky.
  const aerialMix = smoothstep(float(120), float(280), camDist).mul(float(0.5))
  const surfaceColor = mix(reflectedOrBase, horizonHazeUniform, aerialMix)

  const albedo = mix(
    mix(surfaceColor, foamColor, foamMask),
    centerDebugColorUniform,
    debugColorizeMixUniform,
  )

  // Sky-tint emissive: only used as a fallback when reflections are off
  // (`?reflect=0`). When the reflection is active, the actual reflected
  // sky already paints the grazing-angle bright band and stacking a
  // fake sky tint on top reads as chrome.
  const skyTint = vec3(0.55, 0.72, 0.95)
  const fresnelEmissive = reflectionRgb ? vec3(0, 0, 0) : skyTint.mul(fresnel.mul(0.32))

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
  // Sparkle gate tightened — was (0.45, 0.85) which fired sparkle on
  // most upper-half wave faces and produced a "speckle storm" once the
  // larger-amplitude long swell came online. (0.70, 0.95) restricts
  // sparkle to the actual crest peaks, which is where catching glints
  // make narrative sense anyway. The hash threshold is also raised
  // (0.65) so only the rarer "bright" patches paint sparkle, not every
  // mid-tone hash cell.
  const sparkleHeightGate = smoothstep(float(0.7), float(0.95), heightNorm)
  const broadMask = smoothstep(float(0.65), float(0.9), broadNoise).mul(sparkleHeightGate)

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
    // DoubleSide so the underside of the surface renders when the camera
    // dips below water. With the analytical normal pointing up regardless
    // of which face is drawn, ndotv is clamped to 0 from below — that's
    // intentional: it pegs Fresnel to 1 so the underside reads as a fully
    // reflective sky-tinted ceiling, the same effect Snell's-window views
    // produce in real underwater photography.
    side: THREE.DoubleSide,
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
  // Fade emissive contributions out when the debug colorize is on, so the
  // center mesh's red tint isn't washed out by foam / sun-disc highlights.
  const emissiveSum = fresnelEmissive.add(sunGlow).add(sunDisc).add(sunStreak).add(foamEmissive)
  mat.emissiveNode = emissiveSum.mul(float(1).sub(debugColorizeMixUniform))
  // View-angle-dependent shallow-seabed transparency. Only applies in
  // shallow water where there's real terrain underneath — gated by
  // `depthValidGate` (no heightmap data → open ocean → stay fully
  // opaque, so the void past the heightmap edge never bleeds through).
  //
  // Downward views in shallow water resolve to alpha ≈ 0.42 so the
  // seabed reads clearly through the water without losing the water's
  // own colour layer; grazing samples lift toward 0.88 because the
  // view ray travels through a much longer column of water and the
  // body absorption + reflection should dominate at those angles.
  // The depth range extends out to ~11 m so the see-through effect
  // doesn't snap to opaque the moment the player skims out of the
  // ankle-deep band — terrain stays partially visible through honest
  // mid-depth water too. Foam stamps full opacity on top.
  const seabedSeeThrough = mix(float(0.42), float(0.88), float(1).sub(ndotv))
  // Use flat vertical water depth (same as Beer-Lambert) so the
  // shallow-seabed transparency doesn't band along wave isolines.
  const shallowSeabedRange = float(1).sub(smoothstep(float(3), float(11), waterDepthFrag))
  const shallowTransparency = depthValidGate.mul(shallowSeabedRange)
  const depthGatedAlpha = mix(float(0.98), seabedSeeThrough, shallowTransparency)
  // Center mesh edge fade. The center geometry is a hard 960 × 960 m
  // square — its outer ±480 m edge sits exactly where (looking forward
  // from bike POV) the horizon line begins. Without a fade, the
  // PBR-lit center hard-stops at that edge and the (basic-shaded,
  // dimmer, hazier) outer LOD tile begins, painting a visible
  // horizontal line a few pixels below the horizon — the "water ends
  // early" seam users notice most. Cross-blending the two over a
  // wider band (380–480 m) hides the geometric edge: as center
  // opacity ramps 1 → 0, the outer ramps 0 → 1 over the same band
  // (set further down at `outerOpacityNode`), so summed coverage
  // stays at 1 throughout and the shading character softens
  // continuously instead of switching abruptly.
  //
  // Width: 100 m spans enough vertical pixels near the horizon (where
  // pixel density per metre is highest) to read as a smooth gradient
  // rather than a band. Anchored on the OUTSIDE edge (480 m) so the
  // center's full-detail water stays solid through the inner 380 m.
  const centerBoxCoord = max(positionLocal.x.abs(), positionLocal.z.abs())
  const centerEdgeFade = float(1).sub(smoothstep(float(380), float(480), centerBoxCoord))
  mat.opacityNode = mix(depthGatedAlpha, float(0.98), foamMask).mul(centerEdgeFade)
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
  // 0.18 max boost is enough to fully shut down the worst-case sparkle
  // while leaving sub-pixel-stable areas untouched.
  {
    const normalScreenDelta = fwidth(normalNode).length()
    const aaBoost = smoothstep(float(0.05), float(0.5), normalScreenDelta).mul(float(0.18))
    const sparkleRough = mix(roughBaseUniform, roughSparkleUniform, broadMask)
    mat.roughnessNode = clamp(sparkleRough.add(aaBoost), float(0), float(1))
  }

  // Debug knob surface (water-debug-menu.ts talks to this). All setters
  // clamp inputs and apply to the relevant uniform / mesh state. The
  // amp scales also mutate `field.waves[i].amplitude` so the CPU
  // buoyancy sampler stays in lockstep with the GPU shader.
  const defaults: WaterDebugDefaults = {
    steepness: initialSteepness,
    swellScale: 1,
    chopScale: 1,
    timeScale: 1,
    reflectionStrength: REFLECTION_STRENGTH_DEFAULT,
    sunGlow: SUN_GLOW_DEFAULT,
    roughBase: ROUGH_BASE_DEFAULT,
    roughSparkle: ROUGH_SPARKLE_DEFAULT,
    detailStrength: DETAIL_STRENGTH_DEFAULT,
    bodyAbsorption: BODY_ABSORPTION_DEFAULT,
    sunDiscStrength: SUN_DISC_STRENGTH_DEFAULT,
    sunStreakStrength: SUN_STREAK_STRENGTH_DEFAULT,
    streakElongation: STREAK_ELONGATION_DEFAULT,
    pinchDirection: PINCH_DIRECTION_DEFAULT,
    waveBearing: WAVE_BEARING_DEFAULT,
    wireframe: wireFlag,
    colorize: false,
  }
  const clamp01 = (n: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo))
  function applySwellScale(s: number): void {
    // Upper bound 8× matches the Water debug menu's slider ceiling so
    // the player can push proper open-ocean rollers if they want. The
    // shader's Gerstner sum has been validated past 5× without crest
    // folding at the default steepness of 0.7; beyond ~6× expect some
    // tip-over on the largest swells.
    const v = clamp01(s, 0, 8)
    swellScaleUniform.value = v
    for (let i = 0; i < field.waves.length; i++) {
      if (SWELL_INDICES.has(i)) field.waves[i]!.amplitude = baseAmplitudes[i]! * v
    }
  }
  function applyChopScale(s: number): void {
    // Upper bound 6× — chop is shorter-wavelength so it folds earlier
    // than swell; this still permits a stormy surface without
    // sustained crest flips.
    const v = clamp01(s, 0, 6)
    chopScaleUniform.value = v
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
    setBodyAbsorption(s) {
      // 0..3 — scales the per-channel Beer-Lambert sigmas. 1 =
      // calibrated default; lower → less absorption (water bodies
      // read brighter, seabed shows through deeper); higher →
      // more absorption (shallow water already reads deep).
      bodyAbsorptionUniform.value = clamp01(s, 0, 3)
    },
    setSunDiscStrength(s) {
      // 0..3 — scales the Karis sun-disc emissive.
      sunDiscStrengthUniform.value = clamp01(s, 0, 3)
    },
    setSunStreakStrength(s) {
      // 0..3 — scales the anisotropic wave-front streak emissive.
      sunStreakStrengthUniform.value = clamp01(s, 0, 3)
    },
    setStreakElongation(s) {
      // 0.1..1.5 — σ_along of the 2D Gaussian. Lower clamps
      // toward 0.1 (disc-like); higher elongates the streak.
      streakElongationUniform.value = clamp01(s, 0.1, 1.5)
    },
    setPinchDirection(deg) {
      // 0..90° — rotation of the Gerstner horizontal-displacement
      // vector from along-wave to across-wave. Pre-compute the
      // cos/sin once on slider drag so the GPU evaluates two
      // multiplies per wave rather than a trig pair per vertex.
      const v = clamp01(deg, 0, 90)
      pinchDirectionUniform.value = v
      const rad = (v * Math.PI) / 180
      pinchCosUniform.value = Math.cos(rad)
      pinchSinUniform.value = Math.sin(rad)
    },
    setWaveBearing(deg) {
      // -180..180° — rotate the whole wave field. Updates the
      // CPU-side field.waveBearing (so sampleSurface/sampleHeight
      // see it for buoyancy) AND the GPU uniforms (so the vertex
      // shader sees it for the visible mesh). The two paths
      // recompute their rotations from the same scalar, so they
      // stay locked.
      const v = clamp01(deg, -180, 180)
      waveBearingDegUniform.value = v
      const rad = (v * Math.PI) / 180
      waveBearingCosUniform.value = Math.cos(rad)
      waveBearingSinUniform.value = Math.sin(rad)
      field.waveBearing = rad
    },
    setWireframe(on) {
      mat.wireframe = !!on
      outerMat.wireframe = !!on
    },
    setColorize(on) {
      debugColorizeMixUniform.value = on ? 1 : 0
    },
  }

  // Debug: ?wire=1 renders the water mesh as wireframe so you can see
  // the actual vertex displacement (vs. just shaded color). Useful when
  // tuning the wake / dimple / wave amplitudes — turn it on, drive the
  // bike, see the actual ridges in the geometry.
  if (typeof window !== 'undefined') {
    if (wireFlag) {
      mat.wireframe = true
      mat.transparent = false
      mat.opacityNode = float(1)
      // The outer LOD tile's wireframe is mirrored after it's constructed
      // below — `outerMat` doesn't exist yet at this point.
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
  mesh.onBeforeRender = (renderer) => {
    if (disableSceneDepthCopy) return
    // biome-ignore lint/suspicious/noExplicitAny: WebGPURenderer cast
    const r = renderer as any
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

  // ── Outer LOD tile ──────────────────────────────────────────────────────
  // Lower-detail wave plane extending past the center mesh's reach, so the
  // visible wave geometry covers ~720 m to the sides (vs. 480 m on the
  // center alone). Pushes the boundary between displaced water and the
  // flat skirt well past the player's tilt-down view — at 720 m the seam
  // is also at ~13 % fog density on the way to dissolving into sky.
  //
  // Shares the wave-field uniforms (amplitudes, frequencies, time,
  // bearing, mesh origin, horizon haze) with the center mesh because the
  // material is built inside the same closure; both meshes animate in
  // lock-step with zero per-frame CPU pushes.
  //
  // Drops the expensive bits of the center shader:
  //  - planar reflection (one full-screen mirror pass — biggest single
  //    cost on the water; redundant at 280 m+ where the ripple detail
  //    that mirrors carry is already sub-pixel),
  //  - bike-wake displacement (the wake decays well within 40 m so it
  //    contributes nothing meaningful out here, and skipping the per-
  //    bike convolution saves both ALU and uniform bandwidth),
  //  - sub-Gerstner detail-normal cascades (texture samples; the chop
  //    they add is sub-pixel at this distance),
  //  - foam, caustics, sun-streak, sun-disc — all sub-pixel detail at
  //    the outer mesh's view range.
  //
  // Sun shading is reduced to a single ndotL term computed off the
  // analytic Gerstner normal — cheap, enough to keep wave silhouettes
  // legible without falling back to a flat-tinted plane that reads as
  // a stuck texture.
  //
  // Render order: outer (-1) sits under the center mesh (0, default) and
  // above the skirt (-2). Where the center overlaps the outer the
  // center's full-detail shading wins on top; where only the outer
  // overlaps the skirt the outer's wavy geometry wins; past the outer's
  // square footprint the skirt is the last reader before fog.
  //
  // Geometry: 1440 m × 1440 m at 256² subs ≈ 5.6 m / vertex. That's
  // coarse compared to the center's 0.6 m / vertex but still catches
  // the long-period swells (the Gerstner set's shortest wavelength is
  // 5.5 m), which is what reads at 300 m+ distance. The wake's 4 m
  // wavelength is undersampled here but we don't draw wake on this
  // tile anyway. ~66 k verts: roughly 1/9th of the center mesh, so the
  // outer's vertex pass adds well under a millisecond on any real GPU.
  const OUTER_SIZE = 1440
  const OUTER_SUBS = 256

  const outerGeom = new THREE.PlaneGeometry(OUTER_SIZE, OUTER_SIZE, OUTER_SUBS, OUTER_SUBS)
  outerGeom.rotateX(-Math.PI / 2)

  // The outer mesh is a child of the (camera-locked) center mesh, so its
  // local origin coincides with the center's `meshOrigin{X,Z}` snap. Same
  // formula as the center's `worldX/worldZ` — the Gerstner sum samples
  // world coordinates so phase stays continuous across the outer/center
  // boundary regardless of how the camera moves.
  const outerWorldX = positionLocal.x.add(meshOriginX)
  const outerWorldZ = positionLocal.z.add(meshOriginZ)
  const outerGerst = gerstnerHeight(outerWorldX, outerWorldZ, tNode)
  const outerDispVec = gerstnerDisp(outerWorldX, outerWorldZ, tNode)

  // Position: Gerstner vertical + horizontal pinch, no shoaling
  // attenuation (the shoaling sample would return DEEP_SENTINEL at most
  // outer-tile positions anyway since the heightmap doesn't extend out
  // this far) and no bike-wake contribution.
  const outerPositionNode = vec3(
    positionLocal.x.add(outerDispVec.x),
    outerGerst.x,
    positionLocal.z.add(outerDispVec.y),
  )

  // Camera-relative distance (radial, XZ-only) for aerial perspective.
  const outerCamDist = positionLocal.xz.length()

  // Aerial-perspective ramp: matches the center mesh's `aerialMix` cap of
  // 0.5 at 280 m so the colour is continuous where they meet, and holds
  // at 0.5 across the rest of the outer's extent — the outer should
  // read as water for its entire footprint, with the skirt picking up
  // the second-leg ramp toward full horizon haze past 1200 m. Capping
  // here (rather than ramping to 1.0 by 700 m) keeps the outer/skirt
  // boundary at ~720 m tonally close: both layers are ≈50 % water + 50 %
  // haze on either side of the edge.
  const outerAerialMix = clamp(
    smoothstep(float(120), float(280), outerCamDist).mul(float(0.5)),
    float(0),
    float(1),
  )

  // Subtle directional shading off the analytic Gerstner normal so the
  // outer reads as a lit surface rather than a stuck texture. ndotL on
  // a flat plane is sin(sunElev); the displacement modulates around
  // that so crests facing the sun pick up a touch more brightness than
  // troughs. Pulled in tight (0.85..1.0) so the outer never reads as
  // dramatically darker than the haze it dissolves into.
  const outerNormal = vec3(outerGerst.y.negate(), float(1), outerGerst.z.negate()).normalize()
  const outerNdotL = max(dot(outerNormal, sunDirUniform), float(0))
  const outerShade = float(0.85).add(outerNdotL.mul(float(0.15)))

  // Body colour: anchored on the same deep-trough colour the center
  // shader and the skirt both use, with a height-driven scatter lift on
  // crests. Same `vec3(0.02, 0.22, 0.32)` / `vec3(0.22, 0.85, 0.92)`
  // pair as the center; clamping the scatter weight at 0.4 keeps the
  // outer's brightness below the center's so the eye reads the center
  // as the foreground layer if any seam shows.
  const outerHeightVary = varying(outerGerst.x)
  const outerHeightFactor = smoothstep(float(-1.5), float(1.5), outerHeightVary)
  const outerDeep = vec3(0.02, 0.22, 0.32)
  const outerScatter = vec3(0.22, 0.85, 0.92)
  const outerBody = mix(outerDeep, outerScatter, outerHeightFactor.mul(float(0.4))).mul(outerShade)
  const outerColorNode = mix(
    mix(outerBody, horizonHazeUniform, outerAerialMix),
    outerDebugColorUniform,
    debugColorizeMixUniform,
  )

  // Hide the outer tile inside the center mesh's 960 m × 960 m footprint
  // and cross-fade with the center across its outer edge. The center is
  // a child plane at the same origin (parented through `mesh`), so both
  // meshes' `positionLocal` share the same camera-locked frame: the
  // center covers |x| ≤ 480, |z| ≤ 480. The 380→480 m fade-in window
  // mirrors the center's `centerEdgeFade` (set above) — as the center
  // ramps 1 → 0 across that band, the outer ramps 0 → 1, so summed
  // coverage stays at 1 and the eye sees a continuous tone shift from
  // PBR-lit center water to basic-shaded outer water rather than a hard
  // horizontal edge a few pixels below the horizon line.
  const outerBoxCoord = max(positionLocal.x.abs(), positionLocal.z.abs())
  const outerOpacityNode = smoothstep(float(380), float(480), outerBoxCoord)

  const outerMat = new MeshBasicNodeMaterial({
    // Scene fog still applies — between the outer's far rim (≈720 m
    // cardinal, ≈1018 m diagonal) and the fog-far at 2200 m the linear
    // ramp eats whatever tone mismatch survives the aerial-perspective
    // blend, so the outer dissolves into the same sky the horizon ring
    // and skirt dissolve into.
    fog: true,
    side: THREE.FrontSide,
    // See the `outerOpacityNode` comment above — transparent + depthWrite
    // off so the outer never wins a depth test against the higher-detail
    // center mesh in the overlap zone.
    transparent: true,
    depthWrite: false,
  })
  outerMat.name = 'water-outer'
  outerMat.positionNode = outerPositionNode
  outerMat.colorNode = outerColorNode
  outerMat.opacityNode = outerOpacityNode

  const outerMesh = new THREE.Mesh(outerGeom, outerMat as unknown as THREE.Material)
  outerMesh.name = 'water-outer'
  outerMesh.frustumCulled = false
  outerMesh.castShadow = false
  // The sun's shadow cascade is sized ±90 m around the player; at 720 m
  // out, the outer tile is well past anything that could cast a shadow
  // on it. Skip the cascade sample entirely.
  outerMesh.receiveShadow = false
  // Renders in the transparent pass (we made the material transparent so
  // it can fade out inside the center's footprint). Sits between the
  // skirt (-2) and the center (default 0) so back-to-front blending
  // produces skirt → outer → center in the donut where all three
  // overlap, and outer → center where only those two do.
  outerMesh.renderOrder = -1
  mesh.add(outerMesh)

  // Mirror the boot-time `?wire=1` wireframe state set on the center
  // material above. Live toggles via `debug.setWireframe` already update
  // both materials.
  if (wireFlag) outerMat.wireframe = true

  // ── Horizon skirt ──────────────────────────────────────────────────────
  // The main wave plane is 960 m square (camera-locked, ~480 m visible to
  // the sides, ~680 m at the corners). The horizon ring sits at ~1.4 km.
  // Without anything between them, the player sees a visible donut of sky
  // between the water plane's edge and the horizon — i.e. the water
  // bounds are obvious.
  //
  // The skirt is a flat ring extending from inside the main plane out past
  // the horizon ring. It's a child of the main mesh so it inherits the
  // camera-locked XZ and the track's water-height Y automatically.
  // Material is dirt-cheap: a haze-tinted unlit shader. No displacement,
  // no reflection, no foam — at this distance the main plane's wave
  // detail is already sub-pixel and the player's eye reads the skirt as
  // "more water out to the horizon", not as a separate object.
  //
  // The fragment shader anchors on the same `deepColor` the wave mesh
  // uses for its troughs so the skirt reads as water (not sky) across
  // most of its extent — wide-angle views of the wave plane are
  // trough-dominated, so matching that tone hides the boundary between
  // displaced geometry and the flat skirt. The far rim ramps into the
  // sky's `horizonHazeUniform` for aerial perspective; scene fog then
  // dissolves the outermost band into the sky just like everything else.
  // Alpha ramps in over the inner edge so any tiny tonal mismatch under
  // the main plane is hidden by the main plane drawing on top.
  const SKIRT_INNER_RADIUS = 120 // m — well inside the 480 m plane half-extent
  const SKIRT_OUTER_RADIUS = 1600 // m — past the default 1400 m horizon ring
  const SKIRT_ANGULAR_SEGMENTS = 128
  const SKIRT_RADIAL_SEGMENTS = 16
  const skirtGeom = new THREE.RingGeometry(
    SKIRT_INNER_RADIUS,
    SKIRT_OUTER_RADIUS,
    SKIRT_ANGULAR_SEGMENTS,
    SKIRT_RADIAL_SEGMENTS,
  )
  skirtGeom.rotateX(-Math.PI / 2)

  const skirtMat = new MeshBasicNodeMaterial({
    side: THREE.DoubleSide,
    fog: true, // dissolves into the sky at the far rim, same as the horizon ring
    transparent: true,
    depthWrite: false,
  })
  skirtMat.name = 'water-skirt'
  {
    // Distance from camera in world XZ. The skirt is camera-locked (it's
    // a child of `mesh`), so positionLocal.xz is exactly the radial
    // offset from the camera's XZ — no need to round-trip through
    // positionWorld / cameraPosition.
    const radial = positionLocal.xz.length()
    // Inner alpha ramp: 0 at the inner edge → 1 by 240 m, well inside
    // the 480 m plane half-extent. Picking 240 m (rather than the new
    // 480 m side-edge or the 680 m corner) means the skirt is fully
    // opaque long before the center→outer cross-blend band starts at
    // 380 m — without that head room, the band's reduced layer alpha
    // would let sky-clear leak through if the skirt were still
    // ramping in. The plane is fully opaque on top inside 380 m so
    // the early-opaque skirt doesn't tonally compete in the inner
    // region.
    const innerFadeIn = smoothstep(float(SKIRT_INNER_RADIUS), float(240), radial)
    // Aerial-perspective ramp in two legs. First leg (120 → 280 m) mirrors
    // the main plane's `aerialMix = smoothstep(120, 280, camDist) * 0.5`
    // so the tone is continuous across the wave-plane boundary. Then the
    // skirt HOLDS at 50 % water + 50 % haze across the middle band so
    // most of its visible area reads as water, not sky. Only the
    // outermost ~300 m ramps to full horizon haze, where scene fog
    // takes it the rest of the way into the sky. This is the band the
    // player perceives as "the actual horizon line."
    const nearHaze = smoothstep(float(120), float(280), radial).mul(float(0.5))
    const farHaze = smoothstep(float(1200), float(1550), radial).mul(float(0.5))
    const hazeMix = clamp(nearHaze.add(farHaze), float(0), float(1))
    // Anchor on the wave mesh's deep trough colour (same `vec3(0.02,
    // 0.22, 0.32)` constant used in the body-color blend above) so the
    // flat skirt and the wide-angle view of the wave plane share a tone.
    // The visible wave field is trough-dominated at grazing angles —
    // matching the trough colour hides the join. Far-rim haze gives back
    // the sky alignment for atmospheric perspective.
    const skirtDeepColor = vec3(0.02, 0.22, 0.32)
    skirtMat.colorNode = mix(
      mix(skirtDeepColor, horizonHazeUniform, hazeMix),
      skirtDebugColorUniform,
      debugColorizeMixUniform,
    )
    skirtMat.opacityNode = innerFadeIn
  }

  const skirtMesh = new THREE.Mesh(skirtGeom, skirtMat as unknown as THREE.Material)
  skirtMesh.name = 'water-skirt'
  skirtMesh.frustumCulled = false
  skirtMesh.castShadow = false
  skirtMesh.receiveShadow = false
  // Sits below both the center mesh (default 0) and the outer LOD tile
  // (-1) in draw order, so it's the back-most water layer and only
  // shows in the donut past the outer tile's square footprint (~720 m
  // cardinal, ~1018 m diagonal). The outer is opaque + writes depth, so
  // the skirt's transparent fragments behind it are correctly culled.
  skirtMesh.renderOrder = -2
  mesh.add(skirtMesh)

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
    skirtGeom.dispose()
    skirtMat.dispose()
    terrainHeightTex.dispose()
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
 * updated `scene.fog` for the day-night palette. Smoothly blends the
 * sky-driven air fog into a dense water-tinted version as the camera
 * crosses the actual water surface at its XZ — `waterY` should be the
 * wave-displaced surface height there (use `sampleHeight(waveField, …)`),
 * NOT the mean sea level, so the fog doesn't flip on/off behind wave
 * crests when the camera is bobbing through them.
 *
 * The previous implementation used hard hysteresis against a fixed
 * `cameraY < -0.5` threshold, which fired the fog before the camera was
 * visibly submerged (whenever the local wave trough sat below the camera)
 * and snapped off in a single frame on the way back up. Replacing that
 * with a thin smoothed band around the true surface gives a transition
 * that lines up with what the player actually sees.
 *
 * Subnautica-style: the dense water fog is what sells "you are underwater"
 * more than any single visual on its own. It piggybacks on every receive-
 * shadow / lit surface in the scene, so terrain, bikes, and props all dim
 * into the depths without per-material plumbing.
 */

/** Half-width of the surface blend band, in metres. The camera transitions
 *  through the full air→water blend over `2 * SURFACE_BAND_HALF` of vertical
 *  travel relative to the local wave-displaced surface. */
const SURFACE_BAND_HALF = 0.35
const UNDERWATER_FOG_COLOR = new THREE.Color(0.04, 0.2, 0.3)
const UNDERWATER_FOG_NEAR = 0
const UNDERWATER_FOG_FAR = 28

/** Sky writes `fog.near` / `fog.far` once at init and doesn't touch them
 *  per-tick, so we have to remember the air values ourselves — without
 *  this, the fog stays clamped to the underwater range after the player
 *  resurfaces. Re-captured whenever the camera is clearly above water so
 *  a palette / track change still propagates. Color is left to the sky
 *  module, which writes it every tick. */
const airFogRanges = new WeakMap<THREE.Fog, { near: number; far: number }>()

export function updateUnderwaterFog(scene: THREE.Scene, cameraY: number, waterY = 0): void {
  const fog = scene.fog
  if (!(fog instanceof THREE.Fog)) return
  // `depth` is positive when the camera is below the local surface.
  const depth = waterY - cameraY
  // Clearly above water — refresh the air-fog snapshot and leave the
  // sky-driven values alone.
  if (depth <= -SURFACE_BAND_HALF) {
    airFogRanges.set(fog, { near: fog.near, far: fog.far })
    return
  }
  // First frame in the surface band: seed the snapshot from whatever the
  // sky module just wrote. Without this the underwater values would never
  // have an "above water" endpoint to blend from on the first dip.
  let air = airFogRanges.get(fog)
  if (!air) {
    air = { near: fog.near, far: fog.far }
    airFogRanges.set(fog, air)
  }
  // Linear ramp 0..1 across the surface band; saturated at 1 below it.
  // Smoothstep on top so the edges of the band feather instead of
  // visibly kinking.
  const lin = depth >= SURFACE_BAND_HALF ? 1 : (depth + SURFACE_BAND_HALF) / (2 * SURFACE_BAND_HALF)
  const t = lin * lin * (3 - 2 * lin)
  fog.color.lerp(UNDERWATER_FOG_COLOR, t)
  fog.near = air.near + (UNDERWATER_FOG_NEAR - air.near) * t
  fog.far = air.far + (UNDERWATER_FOG_FAR - air.far) * t
}
