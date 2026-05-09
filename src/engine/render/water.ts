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
  sin,
  smoothstep,
  sqrt,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
  viewportDepthTexture,
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
  dispose(): void
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
const BIKE_DIMPLE_CULL_R_SQ = (BIKE_DIMPLE_R * 6) * (BIKE_DIMPLE_R * 6)
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
  const params =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
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
  // normal (cosine slopes). Waves are unrolled at build time.
  const gerstnerHeight = Fn(([x, z, t]: [unknown, unknown, unknown]) => {
    const xN = x as ReturnType<typeof float>
    const zN = z as ReturnType<typeof float>
    const tN = t as ReturnType<typeof float>
    const y = float(0).toVar()
    const dydx = float(0).toVar()
    const dydz = float(0).toVar()
    for (const w of waveConsts) {
      const phase = float(w.k * w.dirX)
        .mul(xN)
        .add(float(w.k * w.dirZ).mul(zN))
        .sub(tN.mul(w.omega))
        .add(float(w.phase))
      const s = sin(phase)
      const c = cos(phase)
      y.addAssign(s.mul(w.amp))
      dydx.addAssign(c.mul(w.amp * w.k * w.dirX))
      dydz.addAssign(c.mul(w.amp * w.k * w.dirZ))
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
    for (const w of waveConsts) {
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
      dx.addAssign(qScaled.mul(float(w.amp * w.dirX)).mul(c))
      dz.addAssign(qScaled.mul(float(w.amp * w.dirZ)).mul(c))
      // Normal y-component reduction: Σ Q · k · A · sin(phase)
      qSum.addAssign(qScaled.mul(float(w.k * w.amp)).mul(s))
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
          // biome-ignore lint/suspicious/noExplicitAny: TSL UniformArrayElementNode lacks float-typing in TS
          const weight = weightsUniform.element(i) as any
          const amp = float(WAKE_DISP_AMP)
            .mul(weight)
            .mul(speedGate)
            .mul(longRamp)
            .mul(longDecay)
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
  const normalNode = normalize(
    vec3(dydx.negate(), float(1).sub(qSumFrag), dydz.negate()),
  )

  // View vector + ndotv computed once and reused by both the scatter blend
  // (base color) and the fresnel sky-tint emissive below.
  const viewDir = normalize(cameraPosition.sub(positionWorld))
  const ndotv = max(dot(normalNode, viewDir), float(0))

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
  const heightFactor = isClassic
    ? heightNorm
    : smoothstep(float(-0.7), float(0.8), heightFrag)
  const deepColor = isClassic ? vec3(0.04, 0.18, 0.4) : vec3(0.02, 0.12, 0.22)
  const scatterColor = isClassic ? vec3(0.16, 0.55, 0.78) : vec3(0.22, 0.7, 0.65)

  // Sun-direction back-scatter. uSunDir matches the scene's
  // DirectionalLight (50, 70, 70) — see scene.ts. Stored normalized as a
  // uniform so a future day/night cycle can animate it. The dot is
  // viewDir.negate() · sunDir = (line-of-sight) · (toward-sun); peaks at
  // 1.0 when the camera is looking toward the sun, falls to 0 when
  // looking perpendicular, < 0 when looking away (clamped). Squared so
  // the boost is concentrated near the sun direction.
  const sunDirUniform = uniform(new THREE.Vector3(50, 70, 70).normalize())
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
  const baseColor = mix(deepColor, scatterColor, scatterAmount)

  // Sun glow emissive — additive on top of the scatter blend for the
  // unmistakable SoT "lit-from-behind" wave glow. Peaks on tall crests
  // (`heightFactor`) lit from behind (`sunBackscatter`), tinted with
  // scatterColor. Off in classic mode.
  const sunGlow = isClassic
    ? vec3(0, 0, 0)
    : scatterColor.mul(sunBackscatter.mul(heightFactor).mul(float(0.6)))

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
  const foamNoiseUV = positionWorld.xz
    .mul(0.35)
    .add(vec2(tNode.mul(-0.18), tNode.mul(0.13)))
  const foamNoiseRaw = fract(
    sin(foamNoiseUV.x.mul(12.9898).add(foamNoiseUV.y.mul(78.233))).mul(43758.5453),
  )
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

  // Shoreline foam (M9.32): white foam where terrain is just below the
  // water surface — the visual cue for "you're approaching land". Works
  // by reading the opaque scene depth buffer at this fragment's screen
  // position and comparing to the water fragment's own view-space Z. When
  // the difference is small (terrain top ~0–1.5m below water), foam shows;
  // farther down, foam fades to 0.
  //
  // Two gates handle the edge cases:
  //   - `behindGate`: only triggers when scene is BEHIND water (positive
  //     closeness). Without this, opaque objects rendered in front of the
  //     water (e.g. bikes between camera and water surface) would falsely
  //     trigger foam wherever they occlude the water plane.
  //   - `depthFade`: smooth fade from full foam at the intersection to 0
  //     at FOAM_INTERSECTION_RANGE meters depth.
  //
  // Off in classic mode (it's a v2 feature; classic preserves the original
  // single-foam path for clean A/B). The depth read is cheap on real GPU
  // (one texture sample + one viewZ conversion) — no per-vertex cost.
  const intersectionFoam = isClassic
    ? float(0)
    : (() => {
        const FOAM_INTERSECTION_BASE = 1.5
        // viewportDepthTexture() samples the opaque depth at this fragment.
        // .r is the non-linear depth in [0, 1].
        // biome-ignore lint/suspicious/noExplicitAny: TSL texture sample swizzle
        const sceneDepthRaw = (viewportDepthTexture() as any).r
        const sceneViewZ = perspectiveDepthToViewZ(sceneDepthRaw, cameraNear, cameraFar)
        const waterViewZ = positionView.z
        // closenessSigned > 0 means terrain is BEHIND water (deeper into
        // the scene from camera's POV). View-Z is negative for points in
        // front of camera, so waterViewZ − sceneViewZ is positive when
        // sceneViewZ is more negative (further away).
        const closenessSigned = waterViewZ.sub(sceneViewZ)
        const behindGate = smoothstep(float(-0.05), float(0.05), closenessSigned)
        // Lapping shoreline (M9.33): the depth threshold breathes ±0.4m
        // around the 1.5m base as the shared foam noise scrolls. Where
        // noise is high, the foam reaches further off-shore (1.9m); where
        // low, it pulls back (1.1m). Combined with the static depth
        // intersection, this reads as the surf "lapping" against the
        // shore rather than a static water-line.
        const noiseRangeOffset = foamNoiseRaw.sub(float(0.5)).mul(float(0.8))
        const foamRangeNow = float(FOAM_INTERSECTION_BASE).add(noiseRangeOffset)
        const depthFade = float(1).sub(
          smoothstep(float(0), foamRangeNow, max(float(0), closenessSigned)),
        )
        // Slight intensity modulation on top so the foam itself has
        // texture (not just a moving edge).
        const intensityModulator = mix(float(0.7), float(1.0), foamNoiseSmooth)
        return behindGate.mul(depthFade).mul(intensityModulator)
      })()

  // Intersection foam is full-opaque white where it fires (we want the
  // shoreline edge to read clearly against the water), so we max-combine
  // it with the (waveFoam + bikeFoam) sum rather than adding — additive
  // would create unnaturally over-bright zones at gate posts where the
  // ramp hits water.
  const foamMask = clamp(
    max(waveFoam.add(bikeFoam), intersectionFoam.mul(0.95)),
    float(0),
    float(0.95),
  )
  const foamColor = vec3(0.92, 0.96, 1.0)
  const albedo = mix(baseColor, foamColor, foamMask)

  // Fresnel: tint with sky color at grazing angles. We push this into the
  // emissive channel so it adds even where the sun isn't catching the wave.
  // (viewDir + ndotv computed earlier and shared with the scatter blend.)
  // Tone curve is gentler in v2 mode since the scatter blend already
  // brightens grazing-angle samples — too much fresnel on top reads as
  // chrome. Classic mode preserves the original 0.5 mix.
  const f0 = float(0.02)
  const fresnel = f0.add(
    float(1)
      .sub(f0)
      .mul(pow(float(1).sub(ndotv), 5)),
  )
  const skyTint = vec3(0.55, 0.72, 0.95)
  const fresnelEmissive = skyTint.mul(fresnel.mul(isClassic ? 0.5 : 0.32))

  // Sparkle: cheap hash on world XZ + animated UV scroll, gated to crests.
  // Two-layer mask so we get both broad "glistening areas" (low-frequency
  // bright patches) and pin-prick highlights (high-frequency hash). The
  // pin-pricks feed the additive emissive (the dancing white pixels you
  // see on the wave faces); the broad mask drops the local roughness so
  // the PBR specular lobe tightens INTO sparkle bursts where the sun
  // catches the surface — that's the SoT-style glistening. Without the
  // roughness modulation, sparkle was purely additive and read as
  // "fairy dust on top" rather than highlights breaking up.
  const sparkleSeed = positionWorld.xz.mul(0.6).add(vec2(tNode.mul(0.27), tNode.mul(-0.19)))
  const sparkleNoise = fract(
    sin(sparkleSeed.x.mul(12.9898).add(sparkleSeed.y.mul(78.233))).mul(43758.5453),
  )
  const sparkleHeightGate = smoothstep(float(0.45), float(0.85), heightNorm)
  const sparkleMask = smoothstep(float(0.985), float(1.0), sparkleNoise).mul(sparkleHeightGate)
  const sparkleEmissive = vec3(1.0, 1.0, 1.0).mul(sparkleMask)

  // Broader sparkle "patches" for the roughness modulation. Lower-frequency
  // seed, animated independently — produces wandering bright zones that
  // tighten the specular highlight rather than discrete pixels.
  const broadSeed = positionWorld.xz.mul(0.18).add(vec2(tNode.mul(-0.11), tNode.mul(0.08)))
  const broadNoise = fract(
    sin(broadSeed.x.mul(12.9898).add(broadSeed.y.mul(78.233))).mul(43758.5453),
  )
  const broadMask = smoothstep(float(0.55), float(0.85), broadNoise).mul(sparkleHeightGate)

  const mat = new MeshStandardNodeMaterial({
    transparent: true,
    metalness: 0.45,
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
  mat.emissiveNode = fresnelEmissive.add(sparkleEmissive).add(sunGlow)
  mat.opacityNode = float(0.78)
  // Noise-modulated roughness. In sparkle patches roughness drops from 0.18
  // to ~0.04, tightening the specular lobe and producing crisp highlights.
  // Classic mode keeps the constant 0.18 so the A/B comparison is clean.
  if (!isClassic) {
    mat.roughnessNode = mix(float(0.18), float(0.04), broadMask)
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
      const clamped = Math.max(0, Math.min(1.5, Number(s) || 0))
      steepnessUniform.value = clamped
      return clamped
    }
  }

  const mesh = new THREE.Mesh(geom, mat as unknown as THREE.Material)
  mesh.name = 'water'
  mesh.position.y = 0

  function tick(
    impacts?: readonly BikeImpact[],
    originXZ?: { x: number; z: number },
  ): void {
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

  function dispose() {
    geom.dispose()
    mat.dispose()
  }

  return { mesh, tick, setSunDirection, dispose }
}
