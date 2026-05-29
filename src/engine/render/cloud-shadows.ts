import * as THREE from 'three'
import type Node from 'three/src/nodes/core/Node.js'
import {
  abs,
  clamp,
  dot,
  float,
  floor,
  fract,
  max,
  mix,
  positionWorld,
  sin,
  smoothstep,
  vec2,
} from 'three/tsl'
import type { MeshStandardNodeMaterial } from 'three/webgpu'
import type { SkyShared } from '@/engine/render/sky'

/**
 * Scrolling cloud-shadow modifier for terrain materials.
 *
 * Builds a TSL float node ∈ [shadowFloor, 1.0] that approximates the
 * darkening cast on the ground by the same cloud layer painted into the
 * sky dome. The node is then multiplied into the terrain shader's
 * `colorNode` so every fragment of authored terrain dims under a cloud
 * and lifts back up when the cloud scrolls away.
 *
 * How the projection works:
 *
 *   For a ground fragment at p = (x, 0, z) and a unit sun direction s,
 *   the ray from p toward the sun reaches the cloud layer at altitude H
 *   after parameter t = H / s.y. The point on the cloud layer that's
 *   shadowing p is therefore p.xz + s.xz · (H / s.y). Sampling the cloud
 *   noise at that offset is equivalent to projecting the cloud silhouette
 *   onto the ground along the sun ray — the geometrically correct shape.
 *
 *   As the sun moves (track-time swap, not per-frame here) shadows shift
 *   accordingly. As the cloud field scrolls under wind (driven by sky's
 *   `time` uniform) the shadows scroll along the ground in lock-step with
 *   the clouds painted on the dome.
 *
 * Cost is one FBM (3 octaves of hash-noise) per terrain fragment. The
 * terrain shader was already evaluating two-octave noise for biome
 * variation, so the marginal cost is modest and only applies to GLB-
 * authored terrain (procedural Lagoon / Cliffside don't use the runtime
 * terrain node material).
 */

const DEFAULT_CLOUD_ALTITUDE = 600 // metres above terrain
const DEFAULT_FEATURE_SCALE = 1 / 320 // ≈ 320 m per cloud feature on the ground
const DEFAULT_WIND = { x: 0.6, z: 0.35 } // metres per (uniform) second
const DEFAULT_SHADOW_FLOOR = 0.35 // deepest darkening under a cloud (≈ 65 % darker)

export type CloudShadowOptions = {
  /** Altitude of the virtual cloud layer in metres. Default 600 m — sits
   *  well above the 240 m peak terrain so the projection always has a
   *  sensible offset. */
  cloudAltitude?: number
  /** World-space frequency multiplier for the cloud noise. Smaller →
   *  bigger, lazier clouds; larger → small dappled shadows. */
  featureScale?: number
  /** Wind drift in (x, z) metres per unit of sky-time. */
  wind?: { x: number; z: number }
  /** Minimum brightness multiplier under a cloud. 1.0 = no shadow at all,
   *  0.0 = pure black. Default 0.55. */
  shadowFloor?: number
}

/**
 * Build the TSL multiplier node. The returned node has type 'float' and
 * should be multiplied into a terrain `colorNode` (or any albedo node
 * that wants cloud shadows): `mat.colorNode = mat.colorNode.mul(node)`.
 *
 * The node reads from the sky system's shared uniforms (sunDir, time,
 * cloudiness) so it stays in lock-step with the dome's painted clouds
 * with no per-frame CPU pushes — the same uniforms drive both sides.
 */
export function buildCloudShadowMultiplier(shared: SkyShared, opts: CloudShadowOptions = {}) {
  const cloudAltitude = opts.cloudAltitude ?? DEFAULT_CLOUD_ALTITUDE
  const featureScale = opts.featureScale ?? DEFAULT_FEATURE_SCALE
  const wind = opts.wind ?? DEFAULT_WIND
  const shadowFloor = opts.shadowFloor ?? DEFAULT_SHADOW_FLOOR

  // ── Hash + value noise + 3-octave FBM (inline, same recipe as sky.ts /
  // terrain-shader.ts; centralising the helpers in TSL turned out
  // gnarlier than duplicating ~15 lines of node graph). The cast-to-
  // `Vec2` widens TSL's strict `JoinNode<'vec2'>` to the looser node
  // type so intermediate `mul(...)` results round-trip through the
  // helpers without re-typing each step. ───────────────────────────────
  type Vec2 = Node<'vec2'>
  const hash21 = (p: Vec2) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453))

  const valueNoise = (p: Vec2): Node<'float'> => {
    const i = vec2(floor(p.x), floor(p.y))
    const f = vec2(fract(p.x), fract(p.y))
    const u = f.mul(f).mul(f.mul(float(-2)).add(float(3)))
    const a = hash21(i)
    const b = hash21(i.add(vec2(1, 0)) as unknown as Vec2)
    const c = hash21(i.add(vec2(0, 1)) as unknown as Vec2)
    const d = hash21(i.add(vec2(1, 1)) as unknown as Vec2)
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y)
  }

  const fbm3 = (p: Vec2): Node<'float'> => {
    const p0 = p
    const p1 = p0.mul(2.07).add(vec2(31.4, 5.7)) as unknown as Vec2
    const p2 = p0.mul(4.11).add(vec2(17.1, 9.2)) as unknown as Vec2
    return valueNoise(p0).mul(0.5).add(valueNoise(p1).mul(0.32)).add(valueNoise(p2).mul(0.18))
  }

  // ── Project ground fragment along the sun ray to the cloud layer. ────
  // `shared.sunDir` is unit-ish; `.y` is the sun's elevation sine. Guard
  // against very low sun angles (or below-horizon) where the projection
  // explodes — `max(.y, 0.18)` caps the slant offset at ≈ 5.5× cloud
  // altitude. Below-horizon nights run with no useful cloud shadow
  // anyway (terrain is lit only by the hemisphere ambient).
  const sunDirVec = shared.sunDir as unknown as {
    x: Node<'float'>
    y: Node<'float'>
    z: Node<'float'>
  }
  const slant = float(cloudAltitude).div(max(abs(sunDirVec.y), float(0.18)))
  const projX = positionWorld.x.add(sunDirVec.x.mul(slant))
  const projZ = positionWorld.z.add(sunDirVec.z.mul(slant))

  // Wind-scrolled coordinate. featureScale is metres → noise units; wind
  // is metres-per-time-unit so the scrolled offset is also in metres.
  const time = shared.time as unknown as Node<'float'>
  const sampleCoord = vec2(
    projX.mul(float(featureScale)).add(time.mul(float(wind.x * featureScale))),
    projZ.mul(float(featureScale)).add(time.mul(float(wind.z * featureScale))),
  ) as unknown as Node<'vec2'>
  const cloudN = fbm3(sampleCoord)

  // ── Convert noise → light multiplier ─────────────────────────────────
  // The smoothstep ramp has to straddle where the FBM noise actually
  // lives, otherwise the cover term sits at ~0 for typical fragments and
  // the multiplier reads as a no-op. Three-octave value noise centres at
  // ≈ 0.5 with std-dev ≈ 0.18, so an earlier `(0.37, 0.9)` ramp put 95 %+
  // of pixels below threshold and the shadows were invisible in-game.
  // The current `(threshold, 0.66)` band puts the upper edge just above
  // the FBM mean — patches with fbm ≳ 0.6 saturate to full shadow, the
  // rest stay clear, producing dappled cumulus patterns.
  // `cloudiness` slides the lower edge so clear skies (cloudiness ≈ 0)
  // shadow only the brightest noise peaks, and overcast (cloudiness ≈ 1)
  // pulls the threshold under the FBM mean so the ground reads as
  // uniformly soft-shadowed.
  const cloudiness = shared.cloudiness as unknown as Node<'float'>
  const threshold = float(0.52).sub(cloudiness.mul(0.32))
  const cover = clamp(smoothstep(threshold, float(0.66), cloudN), float(0), float(1))

  // mix( 1.0 → shadowFloor ) by `cover` → multiplier ∈ [floor, 1].
  return mix(float(1), float(shadowFloor), cover)
}

/**
 * Walk a scene root and inject the cloud-shadow multiplier into every
 * terrain material's `colorNode`. Matches materials by the well-known
 * name `mat_terrain_runtime` stamped in
 * [terrain-shader.ts](./terrain-shader.ts) — meshes that don't go
 * through that path (procedural arena, ramps, cliffside) are left alone.
 *
 * Idempotent: re-wrapping a previously-decorated material multiplies the
 * shadow again, which would double-darken. Callers should ensure they
 * apply this exactly once per loaded environment scene. The wrap is
 * tagged on `material.userData.__cloudShadowApplied` so a re-walk skips
 * already-decorated materials defensively.
 */
export function applyCloudShadowsToScene(
  root: THREE.Object3D,
  multiplier: ReturnType<typeof buildCloudShadowMultiplier>,
): number {
  let count = 0
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const mat = obj.material as THREE.Material | THREE.Material[] | undefined
    if (!mat) return
    const decorate = (m: THREE.Material) => {
      if (m.name !== 'mat_terrain_runtime') return
      if (m.userData?.__cloudShadowApplied) return
      const nodeMat = m as MeshStandardNodeMaterial
      const existing = nodeMat.colorNode
      if (!existing) return
      // Wrap: result = existing * multiplier (multiplier ∈ [floor, 1]).
      // TSL accepts `Node.mul(Node)` returning a same-rank result; the
      // float multiplier broadcasts onto the existing vec3 colour.
      nodeMat.colorNode = (existing as unknown as { mul(n: unknown): unknown }).mul(
        multiplier,
      ) as typeof existing
      // Force a needsUpdate so the next render rebuilds the WGSL/GLSL.
      nodeMat.needsUpdate = true
      m.userData = { ...(m.userData ?? {}), __cloudShadowApplied: true }
      count++
    }
    if (Array.isArray(mat)) {
      for (const m of mat) decorate(m)
    } else {
      decorate(mat)
    }
  })
  return count
}
