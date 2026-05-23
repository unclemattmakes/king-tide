import * as THREE from 'three'
import type Node from 'three/src/nodes/core/Node.js'
import {
  abs,
  clamp,
  dot,
  Fn,
  float,
  floor,
  fract,
  max,
  mix,
  normalize,
  positionWorld,
  pow,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'
import { MeshBasicNodeMaterial, PMREMGenerator, type Renderer } from 'three/webgpu'
import type { SkyColorGrade, SkyConfig, SkyToneMapping } from '@/game/tracks/types'
import { createPostPipeline, type PostPipeline } from './post-pipeline'
import { setActivePostPipeline } from './renderer-service'

/**
 * Sky / atmosphere system.
 *
 * A large inverted sphere (2 km radius) painted by a TSL fragment program:
 *  - vertical palette ramp (zenith → horizon) keyed off sun elevation, so
 *    dawn / noon / dusk / night all look different without swapping assets,
 *  - tight sun disc with a soft halo,
 *  - one FBM cloud layer projected cylindrically and scrolled by wind,
 *  - a sparse hash-based starfield that fades in after dusk.
 *
 * Everything lives in TSL so the shader compiles to WGSL under WebGPU and
 * GLSL under the WebGL2 fallback — the same pipeline the water mesh uses.
 *
 * The system picks one time of day at construction (from `config.timeOfDay`,
 * a position along the 360 s cycle) and freezes it for the lifetime of the
 * scene: the `DirectionalLight` colour/intensity, `Fog` colour, `HemisphereLight`
 * palette, and the PMREM env-map are all computed once and held. Previously
 * we re-baked the cube every 4 s to track the moving sun; that bake (cube
 * render + roughness pre-filter + render-target alloc) was the main source
 * of mid-race hitches, and the visual delta across a single race was small
 * enough that no one noticed it was gone. `tick()` still runs each frame to
 * keep the shadow-camera target on the player and scroll cloud noise.
 *
 * The sim layer never touches Three.js, so the system is purely render-side.
 */

const SUN_CYCLE_SECONDS = 360 // 6 minutes per full rotation
const SUN_DISTANCE = 220 // matches the legacy main.ts value; > shadow far/2 OK

const DEFAULT_SKY: Required<SkyConfig> = {
  tint: '#ffffff',
  cloudiness: 0.45,
  sunIntensity: 1.0,
  // Distances are sized to the 512 m authored track footprint plus the
  // 1700 m horizon-ring silhouette: geometry stays sharp through the play
  // area, then dissolves into the haze that sells the horizon's depth.
  // The horizon ring sits ~75 % through this range, so it reads as a
  // tinted silhouette rather than a hard distant edge.
  fogNear: 500,
  fogFar: 2200,
  // 0 lands at azimuth 45°, elevation 22.5° — a clean mid-morning sun,
  // matching the historical first-tick look before we froze the cycle.
  timeOfDay: 0,
  // 'neutral' is a no-op grade (identity mix on the dome shader).
  colorGrade: 'neutral',
  // 0 = bloom contributes nothing. The post-pipeline still runs the chain
  // but the additive bloom contribution is muted, so this is "off" from
  // the player's POV at near-zero cost.
  bloom: 0,
  // Beaufort 4 (gentle to moderate breeze) is the historical default look
  // the wave list was authored against — leaving the field at 4 makes
  // boot a no-op on tracks that haven't dialled the knob.
  seaStateBeaufort: 4,
  // 'aces_filmic' is Three's default — punchy, high-contrast. Tracks
  // can override per palette (AgX for golden-hour, neutral for crisp
  // daylight, etc.).
  toneMapping: 'aces_filmic',
}

/** Map a SkyToneMapping name → Three.js constant. */
function resolveToneMapping(name: SkyToneMapping): THREE.ToneMapping {
  switch (name) {
    case 'neutral':
      return THREE.NeutralToneMapping
    case 'aces_filmic':
      return THREE.ACESFilmicToneMapping
    case 'agx':
      return THREE.AgXToneMapping
    case 'reinhard':
      return THREE.ReinhardToneMapping
    case 'cineon':
      return THREE.CineonToneMapping
  }
}

/**
 * Per-grade `(tintMul, saturation, contrast)` triple applied as a final
 * post step on the dome shader's composed colour. Kept as a tight CPU
 * table so the runtime cost is one vec3 + two scalars of uniform writes
 * per scene (not a texture sample per fragment).
 *
 * `tintMul` multiplies the composed colour (warming or cooling the
 * whole dome); `saturation` re-mixes around luminance (0 = greyscale,
 * 1 = neutral, >1 = punchier); `contrast` scales (colour - 0.5) so
 * mid-greys widen toward the endpoints. Numbers are art-targets keyed
 * off `docs/track-themes.md` palette notes.
 */
type SkyGradeTone = {
  tintMul: THREE.Color
  saturation: number
  contrast: number
}

const SKY_GRADE_TABLE: Record<SkyColorGrade, SkyGradeTone> = {
  neutral: {
    tintMul: new THREE.Color(1, 1, 1),
    saturation: 1.0,
    contrast: 1.0,
  },
  miami_pastel: {
    // Soft warm-pink lift; lower saturation + lower contrast = sunset haze.
    tintMul: new THREE.Color(1.05, 0.96, 0.98),
    saturation: 0.85,
    contrast: 0.92,
  },
  tokyo_neon: {
    // Cool magenta-cyan lean; punch up saturation + contrast for hot night.
    tintMul: new THREE.Color(0.96, 0.94, 1.08),
    saturation: 1.25,
    contrast: 1.12,
  },
  big_sur_golden: {
    // Golden-hour warmth; mid saturation, slight contrast lift.
    tintMul: new THREE.Color(1.08, 1.0, 0.9),
    saturation: 1.05,
    contrast: 1.05,
  },
  venice_warm: {
    // Adriatic warm-stone palette; soft amber, neutral contrast.
    tintMul: new THREE.Color(1.05, 1.0, 0.94),
    saturation: 0.95,
    contrast: 1.0,
  },
  nyc_sunset: {
    // Liberty's finale — strong warm tint, more contrast for silhouettes.
    tintMul: new THREE.Color(1.12, 0.95, 0.88),
    saturation: 1.1,
    contrast: 1.1,
  },
  cape_town_blue: {
    // Atlantic cool blue; slightly desaturated to read like haze.
    tintMul: new THREE.Color(0.92, 0.98, 1.06),
    saturation: 0.9,
    contrast: 1.0,
  },
  kilauea_volcanic: {
    // Deep ash + lava red lift; punchy saturation, high contrast.
    tintMul: new THREE.Color(1.08, 0.92, 0.86),
    saturation: 1.15,
    contrast: 1.15,
  },
}

/**
 * Beaufort wind scale → wave-amplitude multiplier. The wave list in
 * `defaultWaves()` was authored at roughly Beaufort 4 (moderate breeze,
 * 1-2 m seas), so `4 → 1.0×`. Endpoints are art-targeted at
 * `0 → 0.15×` (glass-calm) and `12 → 2.5×` (hurricane), with a smooth
 * piecewise-linear ramp through the in-between scale steps.
 *
 * Used at boot to scale every `Wave.amplitude` in the default wave list
 * before construction; runtime wave-zones still layer on top via
 * `heightMult`. Exported so tests and the editor can preview the
 * mapping without re-implementing it.
 */
export function beaufortToAmplitudeScale(beaufort: number): number {
  const b = Math.max(0, Math.min(12, beaufort))
  // Anchor points: (beaufort, multiplier). Piecewise linear interp.
  const table: ReadonlyArray<readonly [number, number]> = [
    [0, 0.15],
    [1, 0.3],
    [2, 0.5],
    [3, 0.75],
    [4, 1.0],
    [5, 1.25],
    [6, 1.5],
    [7, 1.75],
    [8, 2.0],
    [10, 2.25],
    [12, 2.5],
  ]
  for (let i = 0; i < table.length - 1; i++) {
    const [lo, vLo] = table[i]!
    const [hi, vHi] = table[i + 1]!
    if (b >= lo && b <= hi) {
      const t = (b - lo) / (hi - lo)
      return vLo + (vHi - vLo) * t
    }
  }
  return table[table.length - 1]![1]
}

/**
 * Per-elevation palette. Sun elevation runs from -0.4 (deep night) through
 * 0.0 (horizon, dawn/dusk warm tones) to ~+0.95 (overhead noon, deep blue
 * zenith with bright sun and washed-out horizon). Colours are blended
 * piecewise; see `samplePalette()` below.
 */
type PaletteSample = {
  /** Sun's normalized Y component at this keyframe (-1..1). */
  elev: number
  zenith: THREE.Color
  horizon: THREE.Color
  /** Warm tint that overlays near the sun direction. */
  sunGlow: THREE.Color
  /** Tint for the directional sun light itself. */
  sunLight: THREE.Color
  /** HemisphereLight sky / ground colours. */
  hemiSky: THREE.Color
  hemiGround: THREE.Color
  /** Multipliers on sun + hemi base intensities. */
  sunMul: number
  hemiMul: number
  /** Star opacity contribution (0 = none, 1 = full). */
  starOpacity: number
}

// Keyframes ordered by elevation. The palette ramp samples between them.
const PALETTE: PaletteSample[] = [
  {
    elev: -0.35, // deep night
    zenith: new THREE.Color(0x02030a),
    horizon: new THREE.Color(0x0a1228),
    sunGlow: new THREE.Color(0x14182a),
    sunLight: new THREE.Color(0x223044),
    hemiSky: new THREE.Color(0x0a1830),
    hemiGround: new THREE.Color(0x05060c),
    sunMul: 0.0,
    hemiMul: 0.18,
    starOpacity: 1.0,
  },
  {
    elev: -0.05, // pre-dawn / post-dusk band
    zenith: new THREE.Color(0x0a1430),
    horizon: new THREE.Color(0xc26840),
    sunGlow: new THREE.Color(0xffa060),
    sunLight: new THREE.Color(0xffb070),
    hemiSky: new THREE.Color(0x6a4060),
    hemiGround: new THREE.Color(0x1a1218),
    sunMul: 0.25,
    hemiMul: 0.5,
    starOpacity: 0.45,
  },
  {
    elev: 0.15, // golden hour
    zenith: new THREE.Color(0x132c5a),
    horizon: new THREE.Color(0xf5b070),
    sunGlow: new THREE.Color(0xffcc88),
    sunLight: new THREE.Color(0xfff0c8),
    hemiSky: new THREE.Color(0xc8a890),
    hemiGround: new THREE.Color(0x3a2e26),
    sunMul: 1.1,
    hemiMul: 0.85,
    starOpacity: 0.0,
  },
  {
    elev: 0.95, // overhead noon
    zenith: new THREE.Color(0x0a1a30),
    horizon: new THREE.Color(0xa6c8e8),
    sunGlow: new THREE.Color(0xffd9a8),
    sunLight: new THREE.Color(0xfff2dc),
    hemiSky: new THREE.Color(0xa6c8e8),
    hemiGround: new THREE.Color(0x223040),
    sunMul: 1.4,
    hemiMul: 0.85,
    starOpacity: 0.0,
  },
]

/**
 * TSL uniforms the sky owns and updates from its palette. Other render
 * systems (horizon ring, cloud shadows on terrain, future post-fx) read
 * these directly so their look stays tonally aligned with the dome
 * without redundant CPU pushes from main.ts.
 */
export type SkyShared = {
  /** Normalised origin→sun direction. Frozen for the race. */
  sunDir: Node<'vec3'>
  /** Active palette horizon colour (RGB linear). */
  horizonColor: Node<'vec3'>
  /** Warm sun-glow colour from the active palette. */
  sunGlow: Node<'vec3'>
  /** Seconds clock, advanced each tick. Wraps cleanly via fract() in shaders. */
  time: Node<'float'>
  /** 0..1 cloud cover, frozen per track. */
  cloudiness: Node<'float'>
}

export type SkySystem = {
  /** The inverted-sphere mesh added to the scene. */
  mesh: THREE.Mesh
  /**
   * Per-frame update. Sun position, palette, and env-map are frozen at
   * construction, so this only:
   *   - keeps the directional-sun shadow camera centred on `focus` (the
   *     player bike's XZ), so the shadow cascade tracks the racer;
   *   - advances the cloud-shader time uniform by `dt` so wind still moves; and
   *   - re-tints `scene.fog.color` toward the warm sun-glow when the
   *     camera is looking toward the sun, away from the cool horizon tone
   *     when it's looking away. Cheap CPU lerp; sells aerial-perspective
   *     "the air is warmer near the sun" without touching any material.
   *
   * `time` is accepted for call-site compatibility with the live and replay
   * loops but is no longer used to drive the sun. Pass any seconds value.
   */
  tick(time: number, dt: number, focus: { x: number; z: number }): void
  /** Read the current normalised sun direction (origin → sun). */
  getSunDirection(): THREE.Vector3
  /** Live-set cloudiness ∈ [0,1]. Drives both the dome shader's cloud
   *  cover and the terrain cloud-shadow multiplier (both read the same
   *  shared uniform). Used by the per-lap weather system to ramp the
   *  cloud field during a race ("storm rolling in"). */
  setCloudiness(c: number): void
  /** Live-set sun-disc + directional-light intensity scalar.
   *  Multiplies the palette's baseline at the active elevation; pass
   *  values < 1 for "the storm covered the sun", > 1 for "the clouds
   *  parted". */
  setSunIntensity(s: number): void
  /** Shared TSL uniforms (read-only consumers: horizon ring, cloud shadows). */
  shared: SkyShared
  /** Drop GPU resources. */
  dispose(): void
}

export type SkyDeps = {
  scene: THREE.Scene
  renderer: THREE.WebGLRenderer
  /** Active perspective camera. The sky reads `getWorldDirection` each
   *  tick to tint scene fog toward the sun when the player looks at it. */
  camera: THREE.PerspectiveCamera
  sun: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  /** Optional consumer kept in sync with the sun direction and the
   *  current palette horizon color. Both are pushed every tick. */
  water?:
    | {
        setSunDirection(x: number, y: number, z: number): void
        setHorizonColor(r: number, g: number, b: number): void
      }
    | undefined
  /** Per-track overrides. */
  config?: SkyConfig | undefined
}

/**
 * Build the sky dome, install it in the scene, and return the system ticker.
 * Safe to call once per scene; no global state.
 */
export function createSkySystem(deps: SkyDeps): SkySystem {
  const { scene, renderer, camera, sun, hemi, water, config } = deps

  // Resolve per-track config with defaults.
  const cfg: Required<SkyConfig> = { ...DEFAULT_SKY, ...config }
  const tintColor = new THREE.Color(cfg.tint)
  const grade = SKY_GRADE_TABLE[cfg.colorGrade] ?? SKY_GRADE_TABLE.neutral
  // Per-track tone-mapping. Three.js exposes one global setter on the
  // renderer; we push the per-track value here at construction. There's
  // no setter to "restore" — successive tracks just overwrite. The
  // RenderPipeline picks the value up at material build time (its
  // outputColorTransform composes a RenderOutputNode internally).
  renderer.toneMapping = resolveToneMapping(cfg.toneMapping)

  // Bloom post-pass — wired through `renderFrame()` in `renderer-service`.
  // `cfg.bloom` is the per-track strength multiplier (0..2). Building the
  // pipeline is cheap when strength is 0 (the chain still composes, but
  // bloom contributes nothing). Track JSON authors leave it 0 by default.
  // The pipeline's PassNode renders the scene into its own HalfFloat RT;
  // the shader pre-warm in `main.ts` calls back through
  // `postPipeline.compileAsync()` so the scene's GPU pipelines exist for
  // that RT format. Compiling against the canvas alone leaves the
  // PassNode RT with no usable pipelines and the framebuffer renders
  // solid black with no validation error.
  let postPipeline: PostPipeline | null = null
  try {
    postPipeline = createPostPipeline({
      renderer,
      scene,
      camera,
      bloomStrength: cfg.bloom,
    })
    setActivePostPipeline(postPipeline)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[sky] failed to build post-pipeline; rendering without bloom', e)
  }

  // ── Shader uniforms (mutated each tick from CPU palette eval) ───────────
  const uZenith = uniform(vec3(0, 0, 0))
  const uHorizon = uniform(vec3(0, 0, 0))
  const uSunGlow = uniform(vec3(0, 0, 0))
  const uTint = uniform(vec3(tintColor.r, tintColor.g, tintColor.b))
  const uSunDir = uniform(new THREE.Vector3(0.5, 0.6, 0.7).normalize())
  const uTime = uniform(0)
  const uCloudiness = uniform(cfg.cloudiness)
  const uSunIntensity = uniform(cfg.sunIntensity)
  const uStarOpacity = uniform(0)
  // Per-grade tone uniforms — kept on the shader so future runtime
  // grade swaps (e.g. cup-final cinematic) are a uniform write rather
  // than a material rebuild.
  const uGradeTint = uniform(vec3(grade.tintMul.r, grade.tintMul.g, grade.tintMul.b))
  const uGradeSaturation = uniform(grade.saturation)
  const uGradeContrast = uniform(grade.contrast)

  // ── TSL helpers ────────────────────────────────────────────────────────
  // 2D hash, value noise, 3-octave FBM. All cheap; FBM is sampled twice
  // per fragment (once for clouds), so total cost is ~24 sin/dot/fract pairs.
  const hash21 = Fn(([p]: [unknown]) => {
    const pN = p as ReturnType<typeof vec2>
    return fract(sin(dot(pN, vec2(127.1, 311.7))).mul(43758.5453))
  })

  const valueNoise = Fn(([p]: [unknown]) => {
    const pN = p as ReturnType<typeof vec2>
    const i = vec2(floor(pN.x), floor(pN.y))
    const f = vec2(fract(pN.x), fract(pN.y))
    const u = f.mul(f).mul(f.mul(float(-2)).add(float(3))) // smoothstep weights
    const a = hash21(i)
    const b = hash21(i.add(vec2(1, 0)))
    const c = hash21(i.add(vec2(0, 1)))
    const d = hash21(i.add(vec2(1, 1)))
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y)
  })

  const fbm3 = Fn(([p]: [unknown]) => {
    const p0 = p as ReturnType<typeof vec2>
    const p1 = p0.mul(2.03).add(vec2(17.1, 9.2))
    const p2 = p0.mul(4.07).add(vec2(31.4, 5.7))
    return valueNoise(p0).mul(0.5).add(valueNoise(p1).mul(0.25)).add(valueNoise(p2).mul(0.125))
  })

  // ── TSL shader ─────────────────────────────────────────────────────────
  // worldDir is the unit view direction from origin to this fragment on the
  // dome. The dome has identity rotation and is centered at the origin so
  // positionWorld doubles as a 2000 m-radius point on the sphere.
  const worldDir = normalize(positionWorld)

  // Vertical palette ramp — pow keeps the horizon band wide and the zenith
  // tight. max(...,0) avoids negative ramp below the horizon; we still
  // render that band so fog hides the seam. Exponent 0.4 pulls zenith
  // influence down into the lower half of the dome so the sky reads as
  // an atmospheric gradient (cool aloft, warm at the rim) rather than a
  // uniform horizon wash at typical racing camera pitches — a steeper
  // curve (e.g. 0.55) leaves the horizon colour dominant across most of
  // the visible sky and makes the dome read as fog rather than sky.
  const ramp = pow(max(worldDir.y, float(0)), 0.4)
  const baseSky = mix(uHorizon, uZenith, ramp)

  // Sun direction dot.
  const sunDot = dot(worldDir, uSunDir)
  const sunDotPos = max(sunDot, float(0))

  // Soft halo around the sun — broad, weak, tints the surrounding sky warm.
  const halo = pow(sunDotPos, 6.0).mul(0.55)

  // Sun disc — narrow, near-1.0 dot. Smoothstep gives a soft edge instead of
  // a hard mathematical circle so it survives the PMREM downsample without
  // ringing. Width tuned for ~1° angular radius.
  const disc = smoothstep(float(0.9985), float(0.99975), sunDot)

  // Clouds — project worldDir cylindrically (xz / |y|) so clouds tile above
  // the camera and stretch into the horizon. Scroll with uTime for wind.
  const cloudCoord = vec2(
    worldDir.x.div(max(abs(worldDir.y), float(0.18))),
    worldDir.z.div(max(abs(worldDir.y), float(0.18))),
  )
    .mul(0.6)
    .add(vec2(uTime.mul(0.012), uTime.mul(0.007)))
  const cloudN = fbm3(cloudCoord)
  // cloudiness in [0,1] shifts the threshold: 0 → very clear, 1 → solid.
  // The horizon mask hides clouds below ~5° elevation (avoids the seam where
  // sky meets fog) and softens to ~25° so the front edge isn't a hard line.
  const horizonMask = smoothstep(float(0.06), float(0.35), worldDir.y)
  const cloudCover = clamp(
    smoothstep(float(0.55).sub(uCloudiness.mul(0.4)), float(0.9), cloudN),
    float(0),
    float(1),
  ).mul(horizonMask)
  // Cloud colour: bright sun-side bottom (lit by warm glow), darker top.
  const cloudShade = mix(uHorizon.mul(0.85), uSunGlow.mul(1.2), pow(sunDotPos, 1.5))
  const cloudColor = mix(uHorizon.mul(0.9), cloudShade, float(0.7))

  // Starfield — sparse 2D hash points on the sky dome. Sample worldDir at
  // high frequency, threshold steeply for sparsity. Faded by uStarOpacity.
  const starCoord = vec2(
    worldDir.x.mul(220).add(worldDir.z.mul(63)),
    worldDir.y.mul(220).add(worldDir.z.mul(141)),
  )
  const starHash = hash21(vec2(floor(starCoord.x), floor(starCoord.y)))
  const starMask = smoothstep(float(0.9965), float(0.999), starHash).mul(uStarOpacity)
  const stars = vec3(starMask, starMask, starMask)

  // Compose: base + halo glow toward sun + clouds (alpha-over) + stars + tint.
  const lit = baseSky.add(uSunGlow.mul(halo))
  const withClouds = mix(lit, cloudColor, cloudCover)
  // Sun disc: bright additive, gated by being above the horizon AND not
  // being occluded by a cloud (1 - cloudCover lerp). uSunIntensity dims it
  // per-track without disturbing the rest of the shader.
  const sunAboveHorizon = smoothstep(float(-0.02), float(0.04), worldDir.y)
  const sunDisc = uSunGlow
    .mul(disc.mul(float(8.0)).mul(uSunIntensity))
    .mul(sunAboveHorizon)
    .mul(float(1).sub(cloudCover.mul(0.85)))
  // Pre-grade composite (matches the historical look when the grade is
  // the 'neutral' preset).
  const composed = withClouds.add(sunDisc).add(stars).mul(uTint)
  // ── Color grade ────────────────────────────────────────────────────────
  // Cheap shader-uniform tweak. tint multiplies; saturation re-mixes
  // around perceived luminance (Rec.709 weights); contrast scales around
  // 0.5. 'neutral' preset is the identity (tint=1,1,1, sat=1, ctr=1).
  const tinted = composed.mul(uGradeTint)
  const luma = tinted.x.mul(0.2126).add(tinted.y.mul(0.7152)).add(tinted.z.mul(0.0722))
  const saturated = mix(vec3(luma, luma, luma), tinted, uGradeSaturation)
  const finalColor = saturated.sub(vec3(0.5, 0.5, 0.5)).mul(uGradeContrast).add(vec3(0.5, 0.5, 0.5))

  // ── Material + mesh ────────────────────────────────────────────────────
  const material = new MeshBasicNodeMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false, // sky is the background; fog applies to scene geometry, not the dome
  })
  material.colorNode = finalColor

  const geom = new THREE.SphereGeometry(2000, 48, 24)
  const mesh = new THREE.Mesh(geom, material as unknown as THREE.Material)
  mesh.name = 'sky'
  mesh.frustumCulled = false
  // Render order -1 forces the dome to draw before opaque scene geometry,
  // letting depth-prepassed bikes/terrain occlude the cheaper sky shader.
  mesh.renderOrder = -1
  scene.add(mesh)

  // Capture base intensities so palette `*Mul` values are relative scalings
  // rather than absolutes — keeps balance stable across track overrides.
  const baseSunIntensity = sun.intensity
  const baseHemiIntensity = hemi.intensity
  const fog = scene.fog instanceof THREE.Fog ? scene.fog : null
  if (fog) {
    fog.near = cfg.fogNear
    fog.far = cfg.fogFar
  }

  // Aerial-perspective fog state. The palette's `horizon` colour is the
  // cool/neutral "facing away from sun" tone; `sunGlow` is the warm "facing
  // toward sun" tone. Per tick we lerp between them by the camera's
  // forward-vs-sun dot, so the same scene fog reads warmer when the player
  // looks at the sun and cooler when they look the other way — the cheapest
  // approximation of Mie forward scattering that still feels physical.
  // Stored as separate fields so `applyStaticState` can refresh the
  // endpoints once per palette change and `tick()` only does the lerp.
  const fogHorizonColor = new THREE.Color(0x9ec1e0)
  const fogSunGlowColor = new THREE.Color(0xffd9a8)
  const fogScratch = new THREE.Color()
  const camForward = new THREE.Vector3()

  // ── PMREM bake plumbing ────────────────────────────────────────────────
  // Dedicated tiny scene with a clone of the sky mesh sharing the same
  // material (so the same uniforms drive both). We bake exactly once below,
  // after the static palette is applied; the cube is held for the rest of
  // the scene's lifetime and disposed alongside the system.
  // The engine carries the renderer as `WebGLRenderer` for shared call-site
  // ergonomics (see renderer.ts), but at runtime it's a `WebGPURenderer`
  // and PMREMGenerator from `three/webgpu` wants that concrete type.
  const pmremGen = new PMREMGenerator(renderer as unknown as Renderer)
  const pmremScene = new THREE.Scene()
  const pmremDome = new THREE.Mesh(geom, material as unknown as THREE.Material)
  pmremDome.frustumCulled = false
  pmremScene.add(pmremDome)
  let currentEnv: { dispose(): void; texture: THREE.Texture } | null = null

  // ── Sun direction read-out vector (kept in sync with uniform) ───────────
  const sunDirOut = new THREE.Vector3()

  // Scratch palette object reused each tick.
  const scratch: PaletteSample = {
    elev: 0,
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    sunGlow: new THREE.Color(),
    sunLight: new THREE.Color(),
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    sunMul: 1,
    hemiMul: 1,
    starOpacity: 0,
  }

  function samplePalette(elev: number, out: PaletteSample): void {
    // Find the bracketing keyframes; clamp at ends.
    let lo = PALETTE[0]!
    let hi = PALETTE[PALETTE.length - 1]!
    if (elev <= lo.elev) {
      hi = lo
    } else if (elev >= hi.elev) {
      lo = hi
    } else {
      for (let i = 0; i < PALETTE.length - 1; i++) {
        const a = PALETTE[i]!
        const b = PALETTE[i + 1]!
        if (elev >= a.elev && elev <= b.elev) {
          lo = a
          hi = b
          break
        }
      }
    }
    const span = hi.elev - lo.elev
    const tRaw = span > 1e-6 ? (elev - lo.elev) / span : 0
    // Smoothstep eases the transition so dawn/dusk slide rather than crossfade.
    const k = tRaw * tRaw * (3 - 2 * tRaw)
    out.zenith.copy(lo.zenith).lerp(hi.zenith, k)
    out.horizon.copy(lo.horizon).lerp(hi.horizon, k)
    out.sunGlow.copy(lo.sunGlow).lerp(hi.sunGlow, k)
    out.sunLight.copy(lo.sunLight).lerp(hi.sunLight, k)
    out.hemiSky.copy(lo.hemiSky).lerp(hi.hemiSky, k)
    out.hemiGround.copy(lo.hemiGround).lerp(hi.hemiGround, k)
    out.sunMul = lo.sunMul + (hi.sunMul - lo.sunMul) * k
    out.hemiMul = lo.hemiMul + (hi.hemiMul - lo.hemiMul) * k
    out.starOpacity = lo.starOpacity + (hi.starOpacity - lo.starOpacity) * k
    out.elev = elev
  }

  /**
   * One-shot setup that positions the sun at the configured time-of-day,
   * evaluates the palette, and pushes the result into every consumer
   * (shader uniforms, fog, hemi/sun lights, water shader, PMREM env-map).
   * Called once during construction; nothing here runs per frame.
   */
  function applyStaticState(time: number): void {
    // ── Sun position along the (frozen) day-night cycle ──────────────────
    // Elevation centred at +22.5° with ±47.5° swing → range [-25°..+70°],
    // i.e. proper night when below the horizon and a reasonable noon arc.
    // The 0.7 phase factor staggers elevation from azimuth so the sun
    // doesn't trace a flat circle as `timeOfDay` is varied per track.
    const phase = (time / SUN_CYCLE_SECONDS) * Math.PI * 2
    const elevRad = (22.5 + 47.5 * Math.sin(phase * 0.7)) * (Math.PI / 180)
    const azimuth = (45 * Math.PI) / 180 + phase
    const cosE = Math.cos(elevRad)
    const dirX = cosE * Math.cos(azimuth)
    const dirY = Math.sin(elevRad)
    const dirZ = cosE * Math.sin(azimuth)

    sunDirOut.set(dirX, dirY, dirZ)
    uSunDir.value.copy(sunDirOut)

    // ── Palette eval ─────────────────────────────────────────────────────
    samplePalette(dirY, scratch)
    uZenith.value.set(scratch.zenith.r, scratch.zenith.g, scratch.zenith.b)
    uHorizon.value.set(scratch.horizon.r, scratch.horizon.g, scratch.horizon.b)
    uSunGlow.value.set(scratch.sunGlow.r, scratch.sunGlow.g, scratch.sunGlow.b)
    uStarOpacity.value = scratch.starOpacity

    // ── Fog + lights ─────────────────────────────────────────────────────
    // Store palette endpoints for the per-frame aerial-perspective lerp in
    // tick(). The initial fog.color write covers the first frame before
    // tick() runs (e.g. loading-screen handoff).
    fogHorizonColor.copy(scratch.horizon)
    fogSunGlowColor.copy(scratch.sunGlow)
    if (fog) fog.color.copy(scratch.horizon)
    hemi.color.copy(scratch.hemiSky)
    hemi.groundColor.copy(scratch.hemiGround)
    hemi.intensity = baseHemiIntensity * scratch.hemiMul

    // Skip the directional sun entirely below the horizon — saves a shadow
    // pass and avoids the light pointing up out of the ground. The
    // HemisphereLight (boosted to "moonlight" intensity by the night
    // palette key) keeps the scene visible at night.
    const aboveHorizon = dirY > 0.02
    sun.visible = aboveHorizon
    if (aboveHorizon) {
      // Initial placement around the origin; `tick()` re-aims the shadow
      // camera at the player each frame so the cascade tracks the racer.
      sun.position.set(dirX * SUN_DISTANCE, dirY * SUN_DISTANCE, dirZ * SUN_DISTANCE)
      sun.target.position.set(0, 0, 0)
      sun.target.updateMatrixWorld()
      sun.color.copy(scratch.sunLight)
      sun.intensity = baseSunIntensity * scratch.sunMul * cfg.sunIntensity
    }

    if (water) {
      water.setSunDirection(dirX, dirY, dirZ)
      // Hand the palette horizon color to the water shader so the aerial-
      // perspective haze on distant water tracks the sky's mood (sunset
      // warmth, dawn pink, twilight blue, midday teal) instead of sitting
      // on a fixed cool tone. Same color the scene fog uses, so distant
      // water and the sky behind it stay tonally aligned.
      water.setHorizonColor(scratch.horizon.r, scratch.horizon.g, scratch.horizon.b)
    }

    // ── One-shot PMREM bake ──────────────────────────────────────────────
    // Bakes the dome shader (with the static palette already applied) into
    // a roughness-prefiltered cube and installs it as `scene.environment`.
    // PBR materials and the planar-reflected water surface sample this for
    // IBL. Previously we re-baked every 4 s to chase the moving sun; the
    // cube render + prefilter caused a noticeable hitch and is no longer
    // needed now that the sun is frozen.
    try {
      currentEnv = pmremGen.fromScene(pmremScene, 0)
      scene.environment = currentEnv.texture
    } catch (err) {
      // PBR materials fall back to whatever IBL Three provides (usually
      // none); the gradient sky keeps driving the visuals either way.
      // eslint-disable-next-line no-console
      console.warn('[sky] PMREM bake failed; scene.environment left unset:', err)
    }
  }

  function tick(_time: number, dt: number, focus: { x: number; z: number }): void {
    // Keep wind moving even with the sun frozen — uniform writes are free
    // and a fully static cloud field reads as "paused game".
    uTime.value += dt

    // Re-aim the directional sun so its shadow camera centres on the player;
    // direction (and therefore lighting) is fixed by applyStaticState().
    if (sun.visible) {
      sun.position.set(
        focus.x + sunDirOut.x * SUN_DISTANCE,
        sunDirOut.y * SUN_DISTANCE,
        focus.z + sunDirOut.z * SUN_DISTANCE,
      )
      sun.target.position.set(focus.x, 0, focus.z)
      sun.target.updateMatrixWorld()
    }

    // Aerial-perspective fog tint. Lerp scene fog between the palette
    // horizon (cool/neutral) and the sun-glow (warm) by how aligned the
    // camera's forward is with the sun direction. Squared dot peaks near
    // the sun and falls off broadly; scaled by 0.55 so the warm endpoint
    // never fully takes over — the fog should look like air, not paint.
    if (fog) {
      camera.getWorldDirection(camForward)
      const align = Math.max(camForward.dot(sunDirOut), 0)
      const warmth = align * align * 0.55
      fogScratch.copy(fogHorizonColor).lerp(fogSunGlowColor, warmth)
      fog.color.copy(fogScratch)
    }
  }

  function getSunDirection(): THREE.Vector3 {
    return sunDirOut
  }

  function setCloudiness(c: number): void {
    uCloudiness.value = Math.max(0, Math.min(1, c))
  }

  function setSunIntensity(s: number): void {
    const clamped = Math.max(0, s)
    uSunIntensity.value = clamped
    if (sun.visible) {
      sun.intensity = baseSunIntensity * scratch.sunMul * clamped
    }
  }

  function dispose(): void {
    scene.remove(mesh)
    geom.dispose()
    material.dispose()
    if (currentEnv) {
      currentEnv.dispose()
      currentEnv = null
    }
    scene.environment = null
    pmremGen.dispose()
    if (postPipeline) {
      setActivePostPipeline(null)
      postPipeline.dispose()
      postPipeline = null
    }
  }

  // Sun, palette, lights, fog, water uniforms, and the PMREM env-map are
  // all computed once here and held for the lifetime of the system.
  applyStaticState(cfg.timeOfDay)

  const shared: SkyShared = {
    sunDir: uSunDir as unknown as Node<'vec3'>,
    horizonColor: uHorizon as unknown as Node<'vec3'>,
    sunGlow: uSunGlow as unknown as Node<'vec3'>,
    time: uTime as unknown as Node<'float'>,
    cloudiness: uCloudiness as unknown as Node<'float'>,
  }

  return { mesh, tick, getSunDirection, setCloudiness, setSunIntensity, shared, dispose }
}
