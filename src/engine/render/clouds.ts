import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type Node from 'three/src/nodes/core/Node.js'
import {
  attribute,
  cameraPosition,
  clamp,
  dot,
  float,
  mix,
  normalize,
  normalWorld,
  positionWorld,
  pow,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import type { CloudFieldConfig } from '@/game/tracks/types'
import type { SkyShared } from './sky'

/**
 * Hero cumulus layer — discrete, chonky, low-poly cloud blobs placed at
 * altitude that parallax against the world and drift on the wind.
 *
 * Why this exists separately from the sky dome: the dome paints a 2D cloud
 * noise field onto its inner surface (a flat band at infinity — no volume, no
 * parallax). That's fine for far haze and high cirrus but can't give the big,
 * blobby, flat-bottomed cumulus masses the concept art is built around. This
 * layer adds those as real geometry in the scene, so they:
 *   - have a true silhouette (cluster-of-spheres cumulus, smooth-shaded),
 *   - parallax against the islands / horizon as the player moves,
 *   - sit at varying distances and drift past on the wind.
 *
 * The look is the "clean stylized toy" register: each blob is a handful of
 * merged low-poly icospheres (smooth normals → soft puffs, not hard facets),
 * lit by an unlit TSL material that mixes a cool shadowed base into a warm
 * sun-lit crown, wraps a soft half-Lambert sun term around the form, and pops
 * a bright fresnel rim at the silhouette (the backlit-cumulus edge). Every
 * colour term is derived from the sky's shared uniforms (`horizonColor`,
 * `sunGlow`, `sunDir`) so the clouds stay tonally locked to the time-of-day
 * with no per-frame CPU uniform pushes.
 *
 * Render-only: this reads `SkyShared` (owned by the sky) and the camera XZ
 * passed to `tick`, and writes Three.js objects. It never touches the sim.
 * Constructed and ticked by `createSkySystem` (clouds are a sky object), so
 * every boot path that builds a sky gets them for free.
 *
 * Cost: one `InstancedMesh` per blob variant (a few draw calls), ~1–2 k verts
 * per variant geometry, and a CPU `setMatrixAt` drift loop over the field
 * (tens of matrix composes per frame). Cheap on every GPU we target.
 */

const UP = new THREE.Vector3(0, 1, 0)

const DEFAULTS = {
  count: 28,
  altitude: 320,
  altitudeJitter: 70,
  spreadRadius: 1100,
  scaleRange: [55, 130] as [number, number],
  wind: { x: 1, z: 0.2 },
  sunPop: 1,
  variants: 4,
  coolBase: '#b4c2d4',
  warmTop: '#fffdf7',
  seed: 1337,
}

export type CloudLayer = {
  /** The group holding the per-variant InstancedMeshes. */
  group: THREE.Group
  /**
   * Per-frame update. Drifts the field on the wind and keeps it centred on
   * the player so the clouds always surround them.
   *   - `time` is the sim seconds clock (drift is a pure function of it, so
   *     replays reproduce cloud positions exactly);
   *   - `dt` is accepted for signature symmetry with other systems (unused —
   *     drift derives from absolute `time`);
   *   - `focus` is the player/camera XZ the field wraps around.
   */
  tick(time: number, dt: number, focus: { x: number; z: number }): void
  dispose(): void
}

export type CloudLayerDeps = {
  scene: THREE.Scene
  /** Shared sky uniforms — the cloud material reads sunDir / sunGlow /
   *  horizonColor so it tracks the frozen time-of-day palette. */
  shared: SkyShared
  /** The opted-in cloud field config (only constructed when count > 0). */
  config: CloudFieldConfig
}

/** Small deterministic PRNG (mulberry32) so blob shapes + scatter reproduce
 *  across runs — important for stable capture-and-tune comparisons. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Wrap `d` into [-R, R] — the seamless torus the cloud field drifts through
 *  so it stays centred on the player without a visible edge. */
function wrapSigned(d: number, r: number): number {
  const span = 2 * r
  let x = (d + r) % span
  if (x < 0) x += span
  return x - r
}

/**
 * Build one low-poly cumulus blob: a cluster of merged icospheres with a
 * flatter, wider base (the cumulus flat bottom) and rounder bumps stacked on
 * top (the cauliflower crown). Returns a single merged geometry, recentred so
 * its XZ centroid and vertical midpoint sit at the origin, with an `aHeightT`
 * attribute (0 at the base, 1 at the crown) driving the vertical colour ramp.
 *
 * Geometry is authored ~1 unit wide / tall; the per-instance matrix scales it
 * to metres. Smooth icosphere normals (detail ≥ 1) keep each puff soft rather
 * than faceted.
 */
function buildCumulusGeometry(rng: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []

  const addLobe = (cx: number, cy: number, cz: number, r: number, squashY: number) => {
    const g = new THREE.IcosahedronGeometry(r, 1)
    if (squashY !== 1) g.scale(1, squashY, 1)
    g.translate(cx, cy, cz)
    parts.push(g)
  }

  // Base lobes: 2–3 wide, squashed spheres sitting on the baseline → a broad
  // flattish bottom.
  const nBase = 2 + Math.floor(rng() * 2)
  for (let i = 0; i < nBase; i++) {
    const r = 0.42 + rng() * 0.16
    const spread = nBase === 1 ? 0 : (i / (nBase - 1) - 0.5) * 0.9
    addLobe(spread + (rng() - 0.5) * 0.2, r * 0.55, (rng() - 0.5) * 0.45, r, 0.66)
  }

  // Crown bumps: 3–6 smaller, rounder spheres stacked higher and inward → the
  // cauliflower top.
  const nTop = 3 + Math.floor(rng() * 4)
  for (let i = 0; i < nTop; i++) {
    const r = 0.26 + rng() * 0.16
    const cx = (rng() - 0.5) * 0.9
    const cz = (rng() - 0.5) * 0.7
    const cy = 0.5 + rng() * 0.55
    addLobe(cx, cy, cz, r, 0.92)
  }

  const merged = mergeGeometries(parts, false)
  for (const g of parts) g.dispose()
  if (!merged) {
    // mergeGeometries only returns null on mismatched attributes, which can't
    // happen here (every part is an IcosahedronGeometry) — but fail loud
    // rather than ship a broken layer if three ever changes that contract.
    throw new Error('clouds: failed to merge cumulus lobes')
  }

  // Measure extents, stamp aHeightT (raw, translation-invariant), then recentre
  // XZ centroid → 0 and vertical midpoint → 0.
  const pos = merged.getAttribute('position') as THREE.BufferAttribute
  const n = pos.count
  let yMin = Infinity
  let yMax = -Infinity
  let sx = 0
  let sz = 0
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i)
    if (y < yMin) yMin = y
    if (y > yMax) yMax = y
    sx += pos.getX(i)
    sz += pos.getZ(i)
  }
  const yRange = Math.max(1e-3, yMax - yMin)
  const heightT = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    heightT[i] = Math.min(1, Math.max(0, (pos.getY(i) - yMin) / yRange))
  }
  merged.setAttribute('aHeightT', new THREE.BufferAttribute(heightT, 1))
  merged.translate(-sx / n, -(yMin + yMax) * 0.5, -sz / n)
  merged.computeBoundingSphere()
  return merged
}

/**
 * Build the shared unlit cloud material. One material instance serves every
 * variant InstancedMesh (it only reads shared uniforms + the per-geometry
 * `aHeightT` attribute, so nothing is per-mesh).
 */
function buildCloudMaterial(shared: SkyShared, coolHex: string, warmHex: string, sunPop: number) {
  const sunDir = shared.sunDir as unknown as Node<'vec3'>
  const sunGlow = shared.sunGlow as unknown as Node<'vec3'>
  const horizonColor = shared.horizonColor as unknown as Node<'vec3'>

  // THREE.Color converts the sRGB hex to the linear working space, matching
  // how sky.ts feeds palette colours into its uniforms.
  const cool = new THREE.Color(coolHex)
  const warm = new THREE.Color(warmHex)
  const uCool = uniform(vec3(cool.r, cool.g, cool.b))
  const uWarm = uniform(vec3(warm.r, warm.g, warm.b))
  // 0..1 directional-light strength: scales the sun-wrap + highlights so a
  // track can flatten the clouds to ambient overcast (0) or keep the sunny
  // pop (1).
  const uSunPop = uniform(sunPop)

  const hT = attribute('aHeightT') as unknown as Node<'float'>
  const nrm = normalize(normalWorld)

  // Vertical ramp: cool shadowed base (biased toward the horizon tone so it
  // beds into the sky) → warm bright crown.
  const coolBase = mix(uCool, horizonColor, float(0.22))
  // Bias the ramp brighter so the body reads as bright cloud and only the
  // deep undersides keep the cool tone — the concept's chonky white cumulus.
  const base = mix(coolBase, uWarm, smoothstep(float(-0.25), float(0.8), hT))

  // Half-Lambert sun wrap — light rolls softly around the rounded form, the
  // shadowed flank floored so the cool base stays readable rather than black.
  // `uSunPop` scales the whole directional contribution: at 1 the shadow floor
  // is 0.5 and the highlights are full (sunny pop); at 0 the floor lifts to 1.0
  // (no wrap darkening) and the highlights vanish, leaving just the vertical
  // base→crown gradient — flat ambient light for an overcast sky.
  const ndl = dot(nrm, sunDir)
  const wrap = clamp(ndl.mul(0.5).add(0.5), float(0), float(1))
  const shadowFloor = mix(float(1.0), float(0.5), uSunPop)
  const lit = base
    .mul(mix(shadowFloor, float(1.0), wrap))
    // Warm push + a white highlight on the directly-sunlit faces → bright
    // sunlit tops that catch the bloom, for the chonky 3D pop.
    .add(sunGlow.mul(pow(wrap, float(2.0)).mul(float(0.22)).mul(uSunPop)))
    .add(vec3(1, 1, 1).mul(pow(wrap, float(3.0)).mul(float(0.18)).mul(uSunPop)))

  // Fresnel rim toward the silhouette → the bright backlit cumulus edge.
  const view = normalize(cameraPosition.sub(positionWorld))
  const ndv = clamp(dot(nrm, view), float(0), float(1))
  const rim = pow(clamp(float(1).sub(ndv), float(0), float(1)), float(3.0))
  const rimColor = mix(vec3(1, 1, 1), sunGlow, float(0.5))
  const color = mix(lit, rimColor, rim.mul(float(0.4)))

  const material = new MeshBasicNodeMaterial({
    side: THREE.FrontSide,
    fog: true, // far clouds dissolve into the sky-tinted scene fog
    depthWrite: true,
    transparent: false,
  })
  // Clamp guards the bright crown / rim from clipping to pure white through
  // the bloom post-pass.
  material.colorNode = clamp(color, float(0), float(1.6))
  return material
}

type CloudInstance = { x0: number; z0: number; y: number; scale: number; yaw: number }
type Variant = { mesh: THREE.InstancedMesh; inst: CloudInstance[] }

export function createCloudLayer(deps: CloudLayerDeps): CloudLayer {
  const { scene, shared, config } = deps

  const count = Math.max(0, Math.floor(config.count ?? DEFAULTS.count))
  const altitude = config.altitude ?? DEFAULTS.altitude
  const altJitter = config.altitudeJitter ?? DEFAULTS.altitudeJitter
  const spreadRadius = config.spreadRadius ?? DEFAULTS.spreadRadius
  const [scaleMin, scaleMax] = config.scaleRange ?? DEFAULTS.scaleRange
  const wind = config.wind ?? DEFAULTS.wind
  const variantCount = Math.max(1, Math.floor(config.variants ?? DEFAULTS.variants))
  const seed = config.seed ?? DEFAULTS.seed

  const rng = mulberry32(seed)
  const group = new THREE.Group()
  group.name = 'clouds'

  const material = buildCloudMaterial(
    shared,
    config.coolBase ?? DEFAULTS.coolBase,
    config.warmTop ?? DEFAULTS.warmTop,
    Math.max(0, Math.min(1, config.sunPop ?? DEFAULTS.sunPop)),
  )

  // Author one geometry per variant, then bucket the field across them so the
  // silhouettes vary.
  const geometries: THREE.BufferGeometry[] = []
  for (let v = 0; v < variantCount; v++) geometries.push(buildCumulusGeometry(rng))

  const buckets: CloudInstance[][] = geometries.map(() => [])
  for (let i = 0; i < count; i++) {
    const theta = rng() * Math.PI * 2
    // Bias the radius outward a touch so the field isn't bunched at the centre.
    const rad = spreadRadius * (0.18 + 0.82 * rng())
    const inst: CloudInstance = {
      x0: Math.cos(theta) * rad,
      z0: Math.sin(theta) * rad,
      y: altitude + (rng() * 2 - 1) * altJitter,
      scale: scaleMin + (scaleMax - scaleMin) * rng(),
      yaw: rng() * Math.PI * 2,
    }
    buckets[i % variantCount]!.push(inst)
  }

  // Scratch — composed once, mutated in place each frame (no per-frame alloc).
  const mtx = new THREE.Matrix4()
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scl = new THREE.Vector3()

  const variants: Variant[] = []
  for (let v = 0; v < variantCount; v++) {
    const inst = buckets[v]!
    const geom = geometries[v]!
    if (inst.length === 0) {
      geom.dispose()
      continue
    }
    const mesh = new THREE.InstancedMesh(geom, material as unknown as THREE.Material, inst.length)
    mesh.name = `clouds:${v}`
    // The field follows the camera and is re-placed every frame, so culling
    // against a static bound would be wrong — skip it (cheap at this count).
    mesh.frustumCulled = false
    mesh.castShadow = false // the cheaper FBM ground-shadow layer carries cloud shade
    mesh.receiveShadow = false
    mesh.renderOrder = 0 // opaque, with the rest of the scene
    // Seed initial matrices (focus 0,0 / time 0) so the first frame is sane
    // even before tick() runs.
    for (let i = 0; i < inst.length; i++) {
      const c = inst[i]!
      pos.set(c.x0, c.y, c.z0)
      quat.setFromAxisAngle(UP, c.yaw)
      scl.setScalar(c.scale)
      mtx.compose(pos, quat, scl)
      mesh.setMatrixAt(i, mtx)
    }
    mesh.instanceMatrix.needsUpdate = true
    group.add(mesh)
    variants.push({ mesh, inst })
  }

  scene.add(group)

  function tick(time: number, _dt: number, focus: { x: number; z: number }): void {
    const driftX = wind.x * time
    const driftZ = wind.z * time
    for (const { mesh, inst } of variants) {
      for (let i = 0; i < inst.length; i++) {
        const c = inst[i]!
        // Absolute drift, then wrap into the torus centred on the player so the
        // field is always around them. Pure function of (x0, time, focus) →
        // deterministic for replays.
        const x = focus.x + wrapSigned(c.x0 + driftX - focus.x, spreadRadius)
        const z = focus.z + wrapSigned(c.z0 + driftZ - focus.z, spreadRadius)
        pos.set(x, c.y, z)
        quat.setFromAxisAngle(UP, c.yaw)
        scl.setScalar(c.scale)
        mtx.compose(pos, quat, scl)
        mesh.setMatrixAt(i, mtx)
      }
      mesh.instanceMatrix.needsUpdate = true
    }
  }

  function dispose(): void {
    scene.remove(group)
    for (const { mesh } of variants) {
      mesh.geometry.dispose()
      scene.remove(mesh)
    }
    material.dispose()
  }

  return { group, tick, dispose }
}
