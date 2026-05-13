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
  opts?: { size?: number; subdivisions?: number },
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
  const reflStrengthUniform = uniform(REFLECTION_STRENGTH_DEFAULT)
  const sunGlowUniform = uniform(SUN_GLOW_DEFAULT)
  const roughBaseUniform = uniform(ROUGH_BASE_DEFAULT)
  const roughSparkleUniform = uniform(ROUGH_SPARKLE_DEFAULT)
  // Per-group amplitude scales — one for swells (waves 0–1), one for chops
  // (waves 2–5). Both default to 1.0 (no scale). The shader multiplies the
  // baked per-wave constants by these uniforms; the CPU buoyancy mirrors
  // by mutating `field.waves[i].amplitude` directly so the two paths stay
  // in lockstep. Baseline amplitudes are captured here so toggling the
  // scales preserves the relative balance of the wave preset.
  const SWELL_INDICES = new Set([0, 1])
  const swellScaleUniform = uniform(1)
  const chopScaleUniform = uniform(1)
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
  const vertexHeight = gerstnerHeight(worldX, worldZ, tNode)
  const vertexDisp = gerstnerDisp(worldX, worldZ, tNode)
  const vertexBike = bikeSurfaceContrib(worldX, worldZ, tNode)
  // vertexHeight = vec3(y, dy/dx, dy/dz)
  // vertexDisp   = vec3(dx, dz, qSum)
  // vertexBike   = vec3(deltaY, ddelta/dx, ddelta/dz)
  const totalHeight = vertexHeight.x.add(vertexBike.x)
  const totalDydx = vertexHeight.y.add(vertexBike.y)
  const totalDydz = vertexHeight.z.add(vertexBike.z)

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
      const slopeFoam = smoothstep(float(0.4), float(0.9), slope)
      const foldFoam = smoothstep(float(0.12), float(0.35), d.z)
      const localFoam = max(slopeFoam, foldFoam)
      const decay = float(Math.exp(-dt * DECAY_RATE))
      maxFoam.assign(max(maxFoam, localFoam.mul(decay)))
    }
    return maxFoam
  })
  const vertexFoamAccum = isClassic ? float(0) : foamAccumulator(worldX, worldZ, tNode)

  // positionNode is in mesh-local space; the mesh translation
  // (mesh.position.x/z = camera XZ) carries the vertex out to world.
  // Adding the Gerstner horizontal displacement to positionLocal.x/z applies
  // the pinching in mesh-local space — equivalent to world-space because
  // the mesh transform is a pure translation.
  const positionNode = vec3(
    positionLocal.x.add(vertexDisp.x),
    totalHeight,
    positionLocal.z.add(vertexDisp.y),
  )

  // Forward height + gradient + qSum + accumulated foam to fragment via
  // varyings. The framework marks these as vertex-stage and inserts the
  // interpolated reads.
  const heightFrag = varying(totalHeight)
  const dydx = varying(totalDydx)
  const dydz = varying(totalDydz)
  const qSumFrag = varying(vertexDisp.z)
  const foamAccumFrag = varying(vertexFoamAccum)

  // GPU Gems eq.13 normal: (-Σdy/dx, 1 - Σ Q·k·A·sin, -Σdy/dz).
  // The wake's gradients are folded into dydx/dydz; the wake has no
  // horizontal-displacement term so it doesn't contribute to qSum.
  const rawNormal = normalize(vec3(dydx.negate(), float(1).sub(qSumFrag), dydz.negate()))

  // View vector + ndotv computed once and reused by both the scatter blend
  // (base color) and the fresnel sky-tint emissive below.
  const viewDir = normalize(cameraPosition.sub(positionWorld))

  // Camera-to-fragment distance. Used in four places:
  //  - to fade high-frequency hash noise toward its mean at long range
  //    (kills pixel-speckle aliasing on the foam and shoreline patches),
  //  - to flatten the wave normal toward (0, 1, 0) on the horizon
  //    (kills specular sparkle aliasing where wave gradients run sub-pixel),
  //  - to distance-attenuate the planar-reflection distortion (the existing
  //    use, now sharing this single length() instead of recomputing),
  //  - to soften the wave-driven foam threshold at distance so the
  //    crest-foam edge doesn't shimmer on receding waves.
  const camDist = cameraPosition.sub(positionWorld).length()

  // Lerp the per-pixel wave normal toward the flat surface normal as the
  // fragment recedes. The Gerstner gradient is high-frequency relative to
  // the camera-space wavelength at the horizon, so the PBR specular lobe
  // catches single-pixel glints that flicker frame-to-frame. Past ~120 m
  // the normal is essentially flat and only the wave color modulation
  // carries the surface shape. Reflection distortion still uses the raw
  // dydx/dydz (already faded by camDist there).
  const normalFlatten = smoothstep(float(40), float(180), camDist)
  const normalNode = normalize(mix(rawNormal, vec3(0, 1, 0), normalFlatten))
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
  const heightFactor = isClassic ? heightNorm : smoothstep(float(-0.7), float(0.8), heightFrag)
  // v2 deep was (0.02, 0.12, 0.22) — readable as "dark blue water" but a
  // bit muddy and unsaturated. Pushed toward a punchier deep teal that
  // reads as a real ocean color when stacked with the new aerial
  // perspective + shallow-tint layers below.
  const deepColor = isClassic ? vec3(0.04, 0.18, 0.4) : vec3(0.012, 0.1, 0.18)
  const scatterColor = isClassic ? vec3(0.16, 0.55, 0.78) : vec3(0.22, 0.7, 0.65)

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

  const scatterAmount = isClassic
    ? heightNorm
    : (() => {
        // Crest scatter ramps with height; grazing view bumps it; sun
        // backlight bumps it further. Combined boost can exceed 1.0 (we
        // clamp at the end so deep troughs stay dark even with sun
        // alignment).
        const viewFactor = float(1).sub(ndotv)
        const baseBoost = mix(float(0.55), float(1.0), viewFactor)
        const sunBoost = sunBackscatter.mul(0.55)
        return clamp(heightFactor.mul(baseBoost.add(sunBoost)), float(0), float(1))
      })()
  const baseColorPreCaustic = mix(tintedDeepColor, scatterColor, scatterAmount)

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
  // v2 mode: pre-baked at the vertex stage by the foam accumulator (see
  // comment block above the Fn definition) — sampled at 4 time steps in
  // the recent past, decayed exponentially, max-reduced. Foam lingers
  // ~1s behind passing crests, which is what gives ocean foam its trail
  // character. We DON'T apply a height gate to the accumulator output:
  // foam should persist on what's now a trough if it WAS a crest a
  // moment ago.
  //
  // Classic mode: original physically-motivated foam (slope OR Jacobian
  // onset, height-gated) — no time accumulation, but still fixes the
  // pre-M9.29 height-driven trigger. The qSum branch evaluates to 0 when
  // steepness=0 so only slopeFoam contributes here.
  const slopeMag = sqrt(dydx.mul(dydx).add(dydz.mul(dydz)))
  const waveFoam = isClassic
    ? (() => {
        const slopeFoam = smoothstep(float(0.4), float(0.9), slopeMag)
        const heightGate = smoothstep(float(-0.4), float(0.3), heightFrag)
        return slopeFoam.mul(heightGate)
      })()
    : foamAccumFrag

  // Shared turbulent foam noise — world XZ + time scroll. Used to break
  // up the otherwise-too-clean foam edges of shoreline, wake, and bow
  // spray so they read as living turbulence instead of stamped outlines.
  // NOT applied to wave-driven foam (slope / Jacobian / accumulator),
  // since natural whitecap foam already has its own variation from the
  // wave field — adding more noise on top reads as TV-static.
  //
  // The same noise is sampled by:
  //   - shoreline foam range (lapping in/out by ±0.2m via `foamNoiseRaw`)
  //   - wake foam intensity (multiplicative `foamTurbulence`)
  //   - bow spray intensity (multiplicative `foamTurbulence`)
  // so all interactive foam moves with a unified visual rhythm.
  const foamNoiseUV = positionWorld.xz.mul(0.35).add(vec2(tNode.mul(-0.18), tNode.mul(0.13)))
  const foamNoiseRawHF = fract(
    sin(foamNoiseUV.x.mul(12.9898).add(foamNoiseUV.y.mul(78.233))).mul(43758.5453),
  )
  // Distance-fade the hash toward its mean (0.5). The 2.86 m wavelength of
  // the hash aliases badly once one screen pixel covers >1 noise cell, which
  // happens between ~30 and ~80 m at typical FOV / 1080p. Past the fade
  // window the noise collapses to a constant — distant shoreline + wake
  // foam reads as a smooth bright band instead of pixel-speckle.
  const foamNoiseAntialias = float(1).sub(smoothstep(float(30), float(80), camDist))
  const foamNoiseRaw = mix(float(0.5), foamNoiseRawHF, foamNoiseAntialias)
  const foamNoiseSmooth = smoothstep(float(0.2), float(0.85), foamNoiseRaw)
  // Multiplier in [0.5, 1.0] — never erases foam, just breaks up its
  // intensity into turbulent patches.
  const foamTurbulence = mix(float(0.5), float(1.0), foamNoiseSmooth)

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

  // Intersection foam is full-opaque white where it fires (we want the
  // shoreline edge to read clearly against the water), so we max-combine
  // it with the (waveFoam + bikeFoam) sum rather than adding — additive
  // would create unnaturally over-bright zones at gate posts where the
  // ramp hits water. Final clamp raised from 0.95 to 1.0 so the bright
  // peak at the water-line can reach pure white.
  const foamMask = clamp(max(waveFoam.add(bikeFoam), intersectionFoam), float(0), float(1))
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
    const distortion = vec2(dydx, dydz).mul(distortAmt)
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
  const broadSeed = positionWorld.xz.mul(0.18).add(vec2(tNode.mul(-0.11), tNode.mul(0.08)))
  const broadNoise = fract(
    sin(broadSeed.x.mul(12.9898).add(broadSeed.y.mul(78.233))).mul(43758.5453),
  )
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
  // Foam needs a small constant emissive lift. Real foam scatters sky
  // light independently of the direct sun, so it stays readably bright
  // even when the surface is in shadow (cliff side, behind a bike) —
  // without this, foam in shadowed shoreline reads as grey, which was
  // half of the "looks very transparent" feeling.
  const foamEmissive = foamColor.mul(foamMask).mul(float(0.18))
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
  mat.opacityNode = mix(baseAlpha, float(0.98), foamMask)
  // Noise-modulated roughness. In sparkle patches roughness drops from 0.18
  // to ~0.04, tightening the specular lobe and producing crisp highlights.
  // Classic mode keeps the constant 0.18 so the A/B comparison is clean.
  // Both base + sparkle ends are uniforms so the debug menu can scrub them.
  if (!isClassic) {
    mat.roughnessNode = mix(roughBaseUniform, roughSparkleUniform, broadMask)
  }

  // Debug knob surface (water-debug-menu.ts talks to this). All setters
  // clamp inputs and apply to the relevant uniform / mesh state. The amp
  // scales also mutate `field.waves[i].amplitude` so the CPU buoyancy
  // sampler stays in lockstep with the GPU shader.
  const defaults: WaterDebugDefaults = {
    steepness: initialSteepness,
    swellScale: 1,
    chopScale: 1,
    timeScale: 1,
    reflectionStrength: REFLECTION_STRENGTH_DEFAULT,
    sunGlow: SUN_GLOW_DEFAULT,
    roughBase: ROUGH_BASE_DEFAULT,
    roughSparkle: ROUGH_SPARKLE_DEFAULT,
    wireframe: wireFlag,
  }
  const clamp01 = (n: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo))
  function applySwellScale(s: number): void {
    const v = clamp01(s, 0, 3)
    swellScaleUniform.value = v
    for (let i = 0; i < field.waves.length; i++) {
      if (SWELL_INDICES.has(i)) field.waves[i]!.amplitude = baseAmplitudes[i]! * v
    }
  }
  function applyChopScale(s: number): void {
    const v = clamp01(s, 0, 3)
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

  function tick(impacts?: readonly BikeImpact[], originXZ?: { x: number; z: number }): void {
    tNode.value = field.time
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

  function dispose() {
    geom.dispose()
    mat.dispose()
  }

  return { mesh, tick, setSunDirection, setHorizonColor, debug, dispose }
}

/**
 * Underwater-fog override. Call once per frame AFTER the sky system has
 * updated `scene.fog` for the day-night palette. When the camera is
 * clearly below the resting water surface, this overwrites the fog with
 * a dense water-tinted version — distant terrain disappears into the
 * abyss, nearby geometry gets a teal cast. Above water it leaves the fog
 * alone so the sky module's per-tick color update stands.
 *
 * Subnautica-style: the dense water fog is what sells "you are underwater"
 * more than any single visual on its own. Bonus: the fog respects the
 * existing receiveShadow / lighting flow, so it just works for terrain,
 * bikes, and props without per-material plumbing.
 *
 * Hysteresis: triggers at `cameraY < -0.5` so the camera bobbing through
 * the wave crest line doesn't flicker between modes.
 */
export function updateUnderwaterFog(scene: THREE.Scene, cameraY: number): void {
  const fog = scene.fog
  if (!(fog instanceof THREE.Fog)) return
  if (cameraY < -0.5) {
    // Saturated underwater teal — slightly brighter than the deep-water
    // albedo so the fog reads as "fluid medium" rather than "black void".
    fog.color.setRGB(0.04, 0.2, 0.3)
    fog.near = 0
    fog.far = 28
  }
}
