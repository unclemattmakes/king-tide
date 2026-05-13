import * as THREE from 'three'
import type Node from 'three/src/nodes/core/Node.js'
import { attribute, dot, float, max, mix, pow, smoothstep } from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import type { SkyShared } from '@/engine/render/sky'

/**
 * Distant horizon silhouette — a ring of procedural terrain drawn at the
 * edge of the playable area to give the world a tangible far-field shape
 * instead of an empty fog gradient.
 *
 * Implementation:
 *  - A two-vertex-per-angle "drape" (bottom edge buried below water, top
 *    edge shaped by layered sines) wrapped into a closed cylinder of
 *    `radius` metres around the player. Each angle samples a deterministic
 *    1-D height function seeded per track so swapping seeds gives a new
 *    silhouette without re-authoring geometry.
 *  - Camera-locked XZ in `tick()` so the ring follows the player as they
 *    cross the 512 m track. At 1700 m radius the per-step parallax error
 *    over a 100 m bike traverse is ≈ 6 %, well inside the perceptual
 *    threshold for "that's the horizon."
 *  - Material reads the sky's `horizonColor` and `sunGlow` uniforms so the
 *    silhouette tracks the day-night palette automatically; no per-tick
 *    CPU pushes needed. A small warm bias is added on the sun-facing side
 *    (atmospheric forward-scatter cue) using `sunDir` from the same shared
 *    uniform block.
 *  - `fog: true` on the material lets Three.js's linear distance fog haze
 *    the silhouette toward the scene's fog colour (now sky-tinted by
 *    sky.ts). With the ring at 1700 m and fog 500–2200 m, the silhouette
 *    sits at ~71 % fog density — visible as a tinted shape, not a hard
 *    distant edge.
 *
 * Cost: ~384 verts, ~768 tris, single draw call, no shadow casting /
 * receiving. Renders for free on every GPU we target.
 */

const RING_SEGMENTS = 192
const DEFAULT_RADIUS = 1400
const DEFAULT_PEAK = 300
const RING_BASE_Y = -40 // well below water; fog + below-horizon clip hide the seam

export type HorizonRingConfig = {
  /** Ring radius in metres. Default 1400 — close enough that the
   *  silhouette survives the scene fog (~53 % density at this distance
   *  with the default 500-2200 m fog band) and large enough that bike
   *  traverse parallax is negligible. */
  radius?: number
  /** Maximum peak height above y=0, in metres. Default 300. */
  peakHeight?: number
  /** PRNG seed driving the heightfield's phase offsets. Per-track variety. */
  seed?: number
  /** Multiplier on the sampled horizon colour. < 1 darkens to silhouette,
   *  > 1 lifts toward a lighter haze. Default 0.45 — combined with the
   *  fog density at the default ring distance, peaks read as ~26 %
   *  darker than the sky directly behind them. */
  silhouetteDark?: number
}

export type HorizonRing = {
  mesh: THREE.Mesh
  /** Keep the ring XZ-locked to the player so it never appears to translate. */
  tick(focus: { x: number; z: number }): void
  dispose(): void
}

export type HorizonRingDeps = {
  scene: THREE.Scene
  shared: SkyShared
  config?: HorizonRingConfig
}

/**
 * Layered-sine 1-D heightfield. Five octaves of `0.5 + 0.5 sin(...)` with
 * geometric amplitude falloff (0.55^n) and frequency growth (≈2x per
 * octave) give a hilly profile with a couple of distinct peaks per
 * quadrant. `seed` shifts each octave's phase so different tracks get
 * visibly different silhouettes from the same code. Result is clamped to
 * [0, 1] for downstream peakHeight scaling.
 */
function heightAt(theta: number, seed: number): number {
  let h = 0
  let amp = 1
  let freq = 1.7
  let total = 0
  for (let i = 0; i < 5; i++) {
    h += amp * (0.5 + 0.5 * Math.sin(theta * freq + seed * (i + 1) * 1.731 + i * 0.91))
    total += amp
    amp *= 0.55
    freq *= 2.05
  }
  let v = h / total
  // Occasional sharp peak — clamp(sin - 0.6, 0)^2 fires roughly once per
  // 33° of arc, lifting one out of ~6 hills above the rolling profile.
  const spikeRaw = Math.sin(theta * 11.3 + seed * 0.71) - 0.6
  if (spikeRaw > 0) v += (spikeRaw / 0.4) * (spikeRaw / 0.4) * 0.35
  return Math.max(0, Math.min(1.2, v))
}

export function createHorizonRing(deps: HorizonRingDeps): HorizonRing {
  const { scene, shared, config } = deps
  const radius = config?.radius ?? DEFAULT_RADIUS
  const peak = config?.peakHeight ?? DEFAULT_PEAK
  const seed = config?.seed ?? 1337
  const silhouetteDark = config?.silhouetteDark ?? 0.45

  // ── Geometry ──────────────────────────────────────────────────────────
  // 2 verts per angle (top, bottom). 6 indices per quad segment. Wraps
  // seamlessly because vertex 0 and vertex SEGMENTS coincide (we emit one
  // extra angle column so UV-like attributes don't pinch at theta=0).
  const cols = RING_SEGMENTS + 1
  const positions = new Float32Array(cols * 2 * 3)
  // Vertex "height factor" — 1 at the top edge, 0 at the bottom. Drives
  // the silhouette gradient in the fragment shader.
  const heightT = new Float32Array(cols * 2)
  // Per-vertex outward direction (cos θ, 0, sin θ) → lets the shader bias
  // colour by sun direction without recomputing world XZ.
  const outward = new Float32Array(cols * 2 * 3)

  for (let i = 0; i < cols; i++) {
    const theta = (i / RING_SEGMENTS) * Math.PI * 2
    const cosT = Math.cos(theta)
    const sinT = Math.sin(theta)
    const topY = heightAt(theta, seed) * peak
    const topIdx = i * 2
    const botIdx = i * 2 + 1
    positions[topIdx * 3 + 0] = cosT * radius
    positions[topIdx * 3 + 1] = topY
    positions[topIdx * 3 + 2] = sinT * radius
    positions[botIdx * 3 + 0] = cosT * radius
    positions[botIdx * 3 + 1] = RING_BASE_Y
    positions[botIdx * 3 + 2] = sinT * radius
    heightT[topIdx] = 1
    heightT[botIdx] = 0
    outward[topIdx * 3 + 0] = cosT
    outward[topIdx * 3 + 1] = 0
    outward[topIdx * 3 + 2] = sinT
    outward[botIdx * 3 + 0] = cosT
    outward[botIdx * 3 + 1] = 0
    outward[botIdx * 3 + 2] = sinT
  }

  // Two triangles per segment, wound so the visible (inward-facing) side
  // of the ring is the one rendered when DoubleSide is on. We use
  // DoubleSide anyway because the silhouette is read from inside the ring
  // only and back-face culling would risk a black edge if the geometry
  // ever drifted relative to the camera.
  const indices = new Uint32Array(RING_SEGMENTS * 6)
  for (let i = 0; i < RING_SEGMENTS; i++) {
    const a = i * 2
    const b = i * 2 + 1
    const c = (i + 1) * 2
    const d = (i + 1) * 2 + 1
    indices[i * 6 + 0] = a
    indices[i * 6 + 1] = b
    indices[i * 6 + 2] = d
    indices[i * 6 + 3] = a
    indices[i * 6 + 4] = d
    indices[i * 6 + 5] = c
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setAttribute('heightT', new THREE.BufferAttribute(heightT, 1))
  geom.setAttribute('outward', new THREE.BufferAttribute(outward, 3))
  geom.setIndex(new THREE.BufferAttribute(indices, 1))
  geom.computeBoundingSphere()

  // ── Shader ────────────────────────────────────────────────────────────
  // Vertical gradient: peaks are the darkest part of the silhouette (the
  // signature "distant mountain against bright sky" look), the base
  // slightly lifted toward the sky as atmospheric haze pools at ground
  // level. Sun-side tint adds a touch of `sunGlow` to peaks pointing at
  // the sun (`outward.xz · sunDir.xz`), faking aerial forward-scatter
  // without extra noise.
  const t = attribute('heightT') as unknown as Node<'float'>
  const outVec = attribute('outward') as unknown as Node<'vec3'>
  const horizonColor = shared.horizonColor as unknown as Node<'vec3'>
  const sunGlow = shared.sunGlow as unknown as Node<'vec3'>

  const peakDark = horizonColor.mul(float(silhouetteDark))
  const baseHaze = horizonColor.mul(float(Math.min(silhouetteDark + 0.20, 0.95)))
  // t=0 at the base → baseHaze, t=1 at the peak → peakDark.
  const vertical = mix(baseHaze, peakDark, smoothstep(float(0.1), float(0.9), t))

  // 2-D dot of outward direction against sun direction (project both onto
  // XZ via .xz, ignore Y). Positive → this side of the ring faces the sun.
  // outward and sunDir are both unit-ish on their XZ projections, so the
  // dot lands in [-1, 1]; clamp positive and curve sharply with pow.
  const outwardXZ = (outVec as unknown as { xz: Node<'vec2'> }).xz
  const sunDirXZ = (shared.sunDir as unknown as { xz: Node<'vec2'> }).xz
  const sunAlign = max(dot(outwardXZ, sunDirXZ), float(0))
  const sunWarm = pow(sunAlign, float(2.4)).mul(float(0.32))
  const finalColor = mix(vertical, sunGlow, sunWarm.mul(t)) // only the peaks pick up the warm tint

  const material = new MeshBasicNodeMaterial({
    side: THREE.DoubleSide,
    fog: true, // honours scene.fog → silhouette dissolves into the sky
    depthWrite: false, // don't punch a hole in the depth buffer for the sky behind
    transparent: false, // opaque shading, just no depth-write
  })
  material.colorNode = finalColor

  const mesh = new THREE.Mesh(geom, material as unknown as THREE.Material)
  mesh.name = 'horizon-ring'
  mesh.frustumCulled = false
  // Render order: after the sky dome (-1) and the opaque scene (0), before
  // transparents. 5 keeps it above water (which lives at the default order)
  // so the ring sits on top of any incidental water foam at the silhouette.
  mesh.renderOrder = 5
  // No shadows: it's 1.7 km away and outside the sun's shadow camera frustum
  // anyway. Both flags off avoid pointless shadow-pass cost.
  mesh.castShadow = false
  mesh.receiveShadow = false
  scene.add(mesh)

  function tick(focus: { x: number; z: number }): void {
    // Keep the ring centred on the player so the silhouette always wraps
    // them. Y is anchored to 0 so peaks rise above the water plane
    // consistently regardless of where the camera bobs.
    mesh.position.set(focus.x, 0, focus.z)
  }

  function dispose(): void {
    scene.remove(mesh)
    geom.dispose()
    material.dispose()
  }

  return { mesh, tick, dispose }
}
