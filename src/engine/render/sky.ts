import * as THREE from 'three'
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
import type { SkyConfig } from '@/game/tracks/types'

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
 * The system also owns the day-night cycle: it moves the scene's
 * `DirectionalLight` along the deterministic wave-field clock (so replays
 * line up), updates the `Fog` colour and `HemisphereLight` to match the
 * current palette, and periodically bakes the dome to a PMREM cube which
 * is assigned as `scene.environment` for PBR materials and the planar-
 * reflected water surface.
 *
 * The sim layer never touches Three.js, so the system is purely render-side.
 */

const SUN_CYCLE_SECONDS = 360 // 6 minutes per full rotation
const SUN_DISTANCE = 220 // matches the legacy main.ts value; > shadow far/2 OK
const PMREM_INTERVAL = 1.0 // seconds of sim time between env-map bakes

const DEFAULT_SKY: Required<SkyConfig> = {
  tint: '#ffffff',
  cloudiness: 0.45,
  sunIntensity: 1.0,
  fogNear: 250,
  fogFar: 900,
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

export type SkySystem = {
  /** The inverted-sphere mesh added to the scene. */
  mesh: THREE.Mesh
  /**
   * Advance the day-night cycle. `time` is the deterministic wave-field
   * clock (in seconds) used everywhere else in the engine so replays line
   * up; `dt` is the frame delta in seconds. `focus` is the world-space XZ
   * point the shadow camera should follow (typically the player bike).
   */
  tick(time: number, dt: number, focus: { x: number; z: number }): void
  /** Read the current normalised sun direction (origin → sun). */
  getSunDirection(): THREE.Vector3
  /** Drop GPU resources. */
  dispose(): void
}

export type SkyDeps = {
  scene: THREE.Scene
  renderer: THREE.WebGLRenderer
  sun: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  /** Optional consumer kept in sync with the sun direction. */
  water?: { setSunDirection(x: number, y: number, z: number): void } | undefined
  /** Per-track overrides. */
  config?: SkyConfig | undefined
}

/**
 * Build the sky dome, install it in the scene, and return the system ticker.
 * Safe to call once per scene; no global state.
 */
export function createSkySystem(deps: SkyDeps): SkySystem {
  const { scene, renderer, sun, hemi, water, config } = deps

  // Resolve per-track config with defaults.
  const cfg: Required<SkyConfig> = { ...DEFAULT_SKY, ...config }
  const tintColor = new THREE.Color(cfg.tint)

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
  // tight (matches the original gradient). max(...,0) avoids negative
  // ramp below the horizon; we still render that band so fog hides the seam.
  const ramp = pow(max(worldDir.y, float(0)), 0.55)
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
  const finalColor = withClouds.add(sunDisc).add(stars).mul(uTint)

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

  // ── PMREM bake plumbing ────────────────────────────────────────────────
  // Dedicated tiny scene with a clone of the sky mesh sharing the same
  // material (so uniforms drive both). Cloning avoids re-parenting the
  // main-scene mesh between renders, which would skip a frame.
  // The engine carries the renderer as `WebGLRenderer` for shared call-site
  // ergonomics (see renderer.ts), but at runtime it's a `WebGPURenderer`
  // and PMREMGenerator from `three/webgpu` wants that concrete type.
  const pmremGen = new PMREMGenerator(renderer as unknown as Renderer)
  const pmremScene = new THREE.Scene()
  const pmremDome = new THREE.Mesh(geom, material as unknown as THREE.Material)
  pmremDome.frustumCulled = false
  pmremScene.add(pmremDome)
  let currentEnv: { dispose(): void; texture: THREE.Texture } | null = null
  // Guard so a single failure disables PMREM rather than spamming every tick.
  let pmremEnabled = true
  let pmremAccum = 0

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

  function tick(time: number, dt: number, focus: { x: number; z: number }): void {
    // ── Sun position along the deterministic cycle ────────────────────────
    // Elevation centred at +22.5° with ±47.5° swing → range [-25°..+70°],
    // i.e. proper night when below the horizon and a reasonable noon arc.
    // The 0.7 phase factor staggers elevation from azimuth so the sun
    // doesn't trace a flat circle.
    const phase = (time / SUN_CYCLE_SECONDS) * Math.PI * 2
    const elevRad = (22.5 + 47.5 * Math.sin(phase * 0.7)) * (Math.PI / 180)
    const azimuth = (45 * Math.PI) / 180 + phase
    const cosE = Math.cos(elevRad)
    const dirX = cosE * Math.cos(azimuth)
    const dirY = Math.sin(elevRad)
    const dirZ = cosE * Math.sin(azimuth)

    sunDirOut.set(dirX, dirY, dirZ)
    uSunDir.value.copy(sunDirOut)
    uTime.value = time

    // ── Palette eval ─────────────────────────────────────────────────────
    samplePalette(dirY, scratch)
    uZenith.value.set(scratch.zenith.r, scratch.zenith.g, scratch.zenith.b)
    uHorizon.value.set(scratch.horizon.r, scratch.horizon.g, scratch.horizon.b)
    uSunGlow.value.set(scratch.sunGlow.r, scratch.sunGlow.g, scratch.sunGlow.b)
    uStarOpacity.value = scratch.starOpacity

    // ── Fog + lights ─────────────────────────────────────────────────────
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
      sun.position.set(
        focus.x + dirX * SUN_DISTANCE,
        dirY * SUN_DISTANCE,
        focus.z + dirZ * SUN_DISTANCE,
      )
      sun.target.position.set(focus.x, 0, focus.z)
      sun.target.updateMatrixWorld()
      sun.color.copy(scratch.sunLight)
      sun.intensity = baseSunIntensity * scratch.sunMul * cfg.sunIntensity
    }

    if (water) water.setSunDirection(dirX, dirY, dirZ)

    // ── Periodic PMREM bake ──────────────────────────────────────────────
    pmremAccum += dt
    if (pmremEnabled && pmremAccum >= PMREM_INTERVAL) {
      pmremAccum = 0
      try {
        const next = pmremGen.fromScene(pmremScene, 0)
        if (currentEnv) currentEnv.dispose()
        currentEnv = next
        scene.environment = next.texture
      } catch (err) {
        // First failure: warn once and stop attempting. The scene still
        // renders; PBR materials fall back to whatever IBL Three provides
        // (usually none) while the gradient sky keeps driving the visuals.
        // eslint-disable-next-line no-console
        console.warn('[sky] PMREM bake failed; disabling env-map updates:', err)
        pmremEnabled = false
      }
    }
  }

  function getSunDirection(): THREE.Vector3 {
    return sunDirOut
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
  }

  // Seed the first frame so we don't pop from uniform defaults on tick 0.
  tick(0, 0, { x: 0, z: 0 })

  return { mesh, tick, getSunDirection, dispose }
}
