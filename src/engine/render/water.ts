import * as THREE from 'three'
import {
  abs,
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
  mix,
  normalize,
  positionLocal,
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
} from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { WaveFieldState } from '@/engine/sim/water/wave-field'

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
   * impact data into the shader's uniform array. Pass an empty / omitted
   * array (e.g. in editor mode) to leave the surface clean.
   */
  tick(impacts?: readonly BikeImpact[]): void
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
/** Speed (m/s) at which the wake stripe just starts to appear. */
const WAKE_SPEED_LOW = 1.5
/** Speed (m/s) at which the wake is at full strength. */
const WAKE_SPEED_HIGH = 8.0
/** How fast the wake fades behind the bike (1 / decay-distance in m). */
const WAKE_DECAY = 0.04
/** Half-angle slope of the V-wake — tan(half-angle). 0.4 ≈ 22°. */
const WAKE_HALF_ANGLE_TAN = 0.4
/** Width of the V-wake at the bike (meters), before it widens behind. */
const WAKE_BASE_WIDTH = 0.55

const INACTIVE_FAR = 1e6

/**
 * GPU-shader water built on Three.js's TSL node pipeline.
 *
 * The vertex shader Gerstner-displaces a flat plane and subtracts a per-bike
 * Gaussian "hull dimple" so the water visibly depresses where each bike sits.
 * The fragment shader recomputes the analytic normal per pixel — including
 * the dimple gradient — and adds:
 *
 *  - PBR-style albedo gradient (deep blue → cyan with crest height)
 *  - Crest foam from height + slope of the wave field
 *  - Hull foam ring around each bike
 *  - V-shaped wake stripe trailing behind each moving bike
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
  // 128 subs is plenty once Gerstner runs on the GPU per-vertex with
  // analytic normals interpolated to fragment. The CPU-driven version
  // needed 256 to keep wave detail crisp; the shader gets the same
  // visible smoothness with a quarter the vertex count, which keeps the
  // WebGL2 software-fallback path (used in headless Chromium e2e) usable.
  const subs = opts?.subdivisions ?? 128

  const geom = new THREE.PlaneGeometry(size, size, subs, subs)
  geom.rotateX(-Math.PI / 2)

  // Time uniform driven from the sim's `field.time`. Using the sim clock
  // (rather than wall-clock) keeps rendering deterministic and matches
  // buoyancy exactly across rewinds / fixed-step runs.
  const tNode = uniform(field.time)

  // Bike slot uniform array. Each vec4 = (px, pz, vx, vz). Inactive slots
  // are parked at INACTIVE_FAR so their Gaussian falls off to zero.
  const bikeSlots: THREE.Vector4[] = []
  for (let i = 0; i < MAX_BIKES; i++) {
    bikeSlots.push(new THREE.Vector4(INACTIVE_FAR, INACTIVE_FAR, 0, 0))
  }
  const bikesUniform = uniformArray(bikeSlots, 'vec4')

  type WaveConst = {
    k: number
    omega: number
    dirX: number
    dirZ: number
    amp: number
    phase: number
  }
  const waveConsts: WaveConst[] = field.waves.map((w) => {
    const k = (2 * Math.PI) / w.wavelength
    return {
      k,
      omega: w.speed * k,
      dirX: w.dirX,
      dirZ: w.dirZ,
      amp: w.amplitude,
      phase: w.phase,
    }
  })

  // Gerstner sum-of-sines, returned as vec3(height, dy/dx, dy/dz). Waves
  // are unrolled at build time so the resulting shader has no dynamic loop.
  const gerstner = Fn(([x, z, t]: [unknown, unknown, unknown]) => {
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

  // Sum the per-bike Gaussian dimples + (optionally) their analytic
  // gradients. Returns vec3(dimpleY, ddimple/dx, ddimple/dz). We use the
  // gradient to fold the depression into the surface normal so the dimple
  // shades correctly as a real basin under the bike, not just a Z hack.
  //
  // dimple_i = D · exp(-r²/R²)        where r² = (x-px)² + (z-pz)²
  // d/dx     = D · exp(-r²/R²) · (-2(x-px)/R²)
  // d/dz     = D · exp(-r²/R²) · (-2(z-pz)/R²)
  const dimpleSum = Fn(([x, z]: [unknown, unknown]) => {
    const xN = x as ReturnType<typeof float>
    const zN = z as ReturnType<typeof float>
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
      // Skip the exp() entirely for vertices outside the dimple's effective
      // range (where the Gaussian is < 1e-7 of peak). Most vertices on the
      // 800m water plane are far from any bike, so this turns a constant
      // per-vertex cost into ≈ O(1).
      If(r2.lessThan(float(BIKE_DIMPLE_CULL_R_SQ)), () => {
        const e = exp(r2.mul(-invR2))
        const depth = e.mul(BIKE_DIMPLE_DEPTH)
        y.addAssign(depth)
        // d(depth)/dx = depth * (-2 dx / R²)
        dydx.addAssign(depth.mul(dx).mul(-2 * invR2))
        dydz.addAssign(depth.mul(dz).mul(-2 * invR2))
      })
    }
    return vec3(y, dydx, dydz)
  })

  // Vertex stage: wave height minus the sum of bike hull dimples. We
  // compute the gradient here too and forward it through `varying(...)` so
  // the fragment can build the surface normal from interpolated values
  // instead of re-running the Gerstner sum per-pixel. Per-fragment Gerstner
  // is several sin/cos per wave per pixel, which tanks performance on the
  // WebGL2 software fallback used in headless test runs (and isn't free
  // even on a real GPU). Per-vertex + interp is visually indistinguishable
  // here because the mesh resolution is much finer than the wave gradient.
  const vertexWave = gerstner(positionLocal.x, positionLocal.z, tNode)
  const vertexDimple = dimpleSum(positionLocal.x, positionLocal.z)
  const totalHeight = vertexWave.x.sub(vertexDimple.x)
  const totalDydx = vertexWave.y.sub(vertexDimple.y)
  const totalDydz = vertexWave.z.sub(vertexDimple.z)

  const positionNode = vec3(positionLocal.x, totalHeight, positionLocal.z)

  // Forward height + gradient to fragment via varyings. The framework
  // marks these as vertex-stage and inserts the interpolated reads.
  const heightFrag = varying(totalHeight)
  const dydx = varying(totalDydx)
  const dydz = varying(totalDydz)

  // Surface normal of y = f(x, z) is (-dy/dx, 1, -dy/dz), normalized.
  const normalNode = normalize(vec3(dydx.negate(), float(1.0), dydz.negate()))

  // Albedo: deep blue in troughs, brighter cyan on crests.
  const heightNorm = smoothstep(float(-0.9), float(0.9), heightFrag)
  const deepColor = vec3(0.04, 0.18, 0.4)
  const shallowColor = vec3(0.16, 0.55, 0.78)
  const baseColor = mix(deepColor, shallowColor, heightNorm)

  // Wave-driven crest foam: high + steep crests break.
  const slopeMag = sqrt(dydx.mul(dydx).add(dydz.mul(dydz)))
  const waveFoam = smoothstep(float(0.55), float(0.95), heightNorm).add(
    smoothstep(float(0.45), float(0.9), slopeMag).mul(0.5),
  )

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

        // Hull foam ring: bright at the dimple's outer edge, fading
        // inward and outward over a small band.
        const ringInner = smoothstep(float(BIKE_DIMPLE_R - 1.0), float(BIKE_DIMPLE_R - 0.2), r)
        const ringOuter = smoothstep(float(BIKE_DIMPLE_R + 0.6), float(BIKE_DIMPLE_R - 0.2), r)
        const ring = ringInner.mul(ringOuter).mul(0.55)

        // V-wake stripe behind the bike. All the slot.z/w accesses lose
        // precise TS types because the swizzle proxy is `any`-typed; the
        // `as any` casts below silence the resulting confusion without
        // affecting runtime semantics.
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
        // 2D perpendicular distance via cross-product magnitude (cheaper
        // than `length(d - hat * parallel)`).
        const perp = abs(dxRel.mul(hatZ).sub(dzRel.mul(hatX)))
        const wakeWidth = behind.mul(WAKE_HALF_ANGLE_TAN).add(float(WAKE_BASE_WIDTH))
        const behindGate = smoothstep(float(0.0), float(0.3), behind)
        const speedGate = smoothstep(float(WAKE_SPEED_LOW), float(WAKE_SPEED_HIGH), speed)
        const decay = exp(behind.mul(-WAKE_DECAY))
        const edgeBlur = smoothstep(wakeWidth.add(0.4), wakeWidth.sub(0.5), perp)
        const wake = behindGate.mul(speedGate).mul(decay).mul(edgeBlur).mul(0.7)

        sum.addAssign(ring.add(wake))
      })
    }
    return sum
  })
  const bikeFoam = computeBikeFoam()

  const foamMask = clamp(waveFoam.add(bikeFoam), float(0), float(0.92))
  const foamColor = vec3(0.92, 0.96, 1.0)
  const albedo = mix(baseColor, foamColor, foamMask)

  // Fresnel: tint with sky color at grazing angles. We push this into the
  // emissive channel so it adds even where the sun isn't catching the wave.
  const viewDir = normalize(cameraPosition.sub(positionWorld))
  const ndotv = max(dot(normalNode, viewDir), float(0))
  const f0 = float(0.02)
  const fresnel = f0.add(
    float(1)
      .sub(f0)
      .mul(pow(float(1).sub(ndotv), 5)),
  )
  const skyTint = vec3(0.55, 0.72, 0.95)
  const fresnelEmissive = skyTint.mul(fresnel.mul(0.5))

  // Sparkle: cheap hash on world XZ + animated UV scroll, gated to crests.
  const sparkleSeed = positionWorld.xz.mul(0.6).add(vec2(tNode.mul(0.27), tNode.mul(-0.19)))
  const sparkleNoise = fract(
    sin(sparkleSeed.x.mul(12.9898).add(sparkleSeed.y.mul(78.233))).mul(43758.5453),
  )
  const sparkleMask = smoothstep(float(0.985), float(1.0), sparkleNoise).mul(
    smoothstep(float(0.45), float(0.85), heightNorm),
  )
  const sparkleEmissive = vec3(1.0, 1.0, 1.0).mul(sparkleMask)

  const mat = new MeshStandardNodeMaterial({
    transparent: true,
    metalness: 0.45,
    roughness: 0.18,
    envMapIntensity: 0.9,
  })
  mat.name = 'water'
  mat.positionNode = positionNode
  mat.normalNode = normalNode
  mat.colorNode = albedo
  mat.emissiveNode = fresnelEmissive.add(sparkleEmissive)
  mat.opacityNode = float(0.78)

  const mesh = new THREE.Mesh(geom, mat as unknown as THREE.Material)
  mesh.name = 'water'
  mesh.position.y = 0

  function tick(impacts?: readonly BikeImpact[]): void {
    tNode.value = field.time
    for (let i = 0; i < MAX_BIKES; i++) {
      const slot = bikeSlots[i]!
      const im = impacts?.[i]
      if (im && im.weight > 0.05) {
        slot.set(im.x, im.z, im.vx * im.weight, im.vz * im.weight)
      } else {
        slot.set(INACTIVE_FAR, INACTIVE_FAR, 0, 0)
      }
    }
  }

  function dispose() {
    geom.dispose()
    mat.dispose()
  }

  return { mesh, tick, dispose }
}
