/**
 * Slope- and altitude-aware terrain material for in-game terrain.
 * Built as TSL nodes on a ``MeshStandardNodeMaterial`` so it composes
 * naturally with the project's WebGPU renderer (the same path the
 * water shader uses).
 *
 * Why a runtime material rather than baked vertex colours:
 *
 * - Blender's slope-aware shader graph cannot round-trip through glTF —
 *   the exporter sees a Principled BSDF with a complex node tree feeding
 *   BaseColor and falls back to a default constant. The author-time look
 *   is lost no matter what we do at export.
 * - Baking the colours to vertex RGB *would* survive the export, but it
 *   freezes tuning at author time, prevents the runtime from layering
 *   detail (variation noise, wet-band tint, future fog/distance work),
 *   and burns 12 bytes/vertex on a ~150 k-vert terrain that already
 *   exists on the GPU.
 * - A runtime node-material lets us evaluate the same logic per-fragment,
 *   gets free re-tuning without re-exporting the .glb, and leaves the
 *   ``COLOR_0`` channels (R=sway, G=AO, B=path-worn, A=biome) for the
 *   parameter purposes spec'd in
 *   ``docs/vertex-attribute-spec.md``.
 *
 * The material composes:
 *
 *   1. Altitude → 0..1 fac, used to sample two pre-baked colour ramps
 *      (a "flat" ramp: deep blue → sand → grass → forest → alpine, and
 *      a "cliff" ramp: dark rock → wet rock → grey rock → volcanic).
 *   2. Slope from world normal Y → 0..1 fac that blends flat toward
 *      cliff (smoothstep cos 30° → cos 55°).
 *   3. Two-octave value noise in world XZ → ±15% brightness variation
 *      that breaks the ramps' visible banding.
 *   4. Triangular |y|-mask around y=0 → multiplies in a cool-blue wet
 *      tint on damp shoreline.
 *   5. Slope-driven roughness lift so rocks read rougher than sand /
 *      grass.
 *
 * The ramps live in 256-pixel ``DataTexture``s sampled with LINEAR
 * filtering and SRGB colour-space conversion. Both are built once and
 * shared across every terrain mesh.
 */

import * as THREE from 'three'
import type Node from 'three/src/nodes/core/Node.js'
import {
  abs,
  clamp,
  dot,
  float,
  fract,
  mix,
  normalize,
  normalWorld,
  positionWorld,
  sin,
  smoothstep,
  texture,
  vec2,
  vec3,
} from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'

type ColorStop = { pos: number; color: [number, number, number] }

/**
 * Altitude bands in linear-light, mirroring the ``build_terrain_material``
 * ramp in ``tools/blender/seed_template_island.py`` so the in-game look
 * matches the Blender preview.
 */
const FLAT_STOPS: ColorStop[] = [
  { pos: 0.000, color: [0.03, 0.08, 0.20] },   // abyssal blue   (y≈-50)
  { pos: 0.180, color: [0.22, 0.30, 0.40] },   // blue-sand      (y≈-19)
  { pos: 0.270, color: [0.68, 0.66, 0.55] },   // silty sand     (y≈ -4)
  { pos: 0.300, color: [0.92, 0.86, 0.72] },   // bright sand    (y=   1)
  { pos: 0.345, color: [0.78, 0.70, 0.50] },   // wet beach tan  (y=   9)
  { pos: 0.430, color: [0.36, 0.55, 0.27] },   // grass          (y=  23)
  { pos: 0.620, color: [0.22, 0.40, 0.18] },   // forest         (y=  55)
  { pos: 0.820, color: [0.30, 0.27, 0.21] },   // alpine stone   (y=  89)
  { pos: 1.000, color: [0.18, 0.15, 0.13] },   // volcanic top   (y= 120)
]

const CLIFF_STOPS: ColorStop[] = [
  { pos: 0.000, color: [0.07, 0.10, 0.16] },   // dark abyssal rock
  { pos: 0.220, color: [0.20, 0.22, 0.24] },   // wet rock
  { pos: 0.300, color: [0.34, 0.32, 0.28] },   // sea cliff
  { pos: 0.500, color: [0.42, 0.39, 0.34] },   // grey rock
  { pos: 0.750, color: [0.30, 0.25, 0.22] },   // warmer rock
  { pos: 1.000, color: [0.16, 0.13, 0.13] },   // volcanic
]

/** World-Y range mapped to ramp parameter 0..1. Matches the Blender
 *  shader's altitude Map Range so colour breaks fall at the same y. */
const ALT_MIN = -50.0
const ALT_MAX = 120.0

function evalRamp(stops: ColorStop[], t: number): [number, number, number] {
  if (t <= stops[0]!.pos) return stops[0]!.color
  if (t >= stops[stops.length - 1]!.pos) return stops[stops.length - 1]!.color
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!
    const b = stops[i + 1]!
    if (t >= a.pos && t <= b.pos) {
      const span = b.pos - a.pos
      const local = span > 0 ? (t - a.pos) / span : 0
      // Smoothstep interpolation to match Blender ColorRamp's default.
      const s = local * local * (3 - 2 * local)
      return [
        a.color[0] + (b.color[0] - a.color[0]) * s,
        a.color[1] + (b.color[1] - a.color[1]) * s,
        a.color[2] + (b.color[2] - a.color[2]) * s,
      ]
    }
  }
  return stops[stops.length - 1]!.color
}

function makeRampTexture(stops: ColorStop[]): THREE.DataTexture {
  const N = 256
  const data = new Uint8Array(N * 4)
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1)
    const [r, g, b] = evalRamp(stops, t)
    data[i * 4 + 0] = Math.round(r * 255)
    data[i * 4 + 1] = Math.round(g * 255)
    data[i * 4 + 2] = Math.round(b * 255)
    data[i * 4 + 3] = 255
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  // The ramps are authored in sRGB display values; tell Three to run the
  // standard sRGB → linear conversion on sample so the in-game colours
  // sit at the same perceptual stops as the Blender preview.
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

let sharedFlatRamp: THREE.DataTexture | null = null
let sharedCliffRamp: THREE.DataTexture | null = null

function sharedRamps(): { flat: THREE.DataTexture; cliff: THREE.DataTexture } {
  if (!sharedFlatRamp) sharedFlatRamp = makeRampTexture(FLAT_STOPS)
  if (!sharedCliffRamp) sharedCliffRamp = makeRampTexture(CLIFF_STOPS)
  return { flat: sharedFlatRamp, cliff: sharedCliffRamp }
}

/**
 * Build the terrain material as a fresh ``MeshStandardNodeMaterial`` with
 * a TSL colour graph. Cheap to call — the only allocated state is the
 * material itself; the ramps are shared across calls.
 */
export function buildTerrainMaterial(): MeshStandardNodeMaterial {
  const { flat, cliff } = sharedRamps()

  const mat = new MeshStandardNodeMaterial({ metalness: 0 })
  mat.name = 'mat_terrain_runtime'

  const worldNorm = normalize(normalWorld)

  // Slope mask: 0 on horizontal faces (worldNormal.y == 1), 1 on
  // verticals. Smoothstep cos 30°..cos 55° so gentle slopes still read
  // as grass / sand rather than rock.
  const slope = smoothstep(float(0.85), float(0.55), worldNorm.y)

  // Altitude -> ramp parameter. Heights outside the configured range
  // clamp; deepest abyssal blue / brightest volcanic top sit at the
  // ramps' ends.
  const altT = clamp(
    positionWorld.y.sub(ALT_MIN).div(ALT_MAX - ALT_MIN),
    float(0),
    float(1),
  )

  const flatCol = texture(flat, vec2(altT, float(0.5))).rgb
  const cliffCol = texture(cliff, vec2(altT, float(0.5))).rgb
  const blended = mix(flatCol, cliffCol, slope)

  // Two-octave value noise sampled on the world XZ plane. Breaking ramp
  // banding via 2D rather than 3D keeps the TSL node count manageable
  // and looks plenty natural on terrain (the dominant variation axis is
  // horizontal). ~16 m base feature size + half-amplitude second octave.
  const varN = valueNoiseOctave2D(positionWorld.xz.mul(0.060))
  const variedBaseCol = blended.mul(float(0.85).add(varN.mul(0.30)))

  // Wet band: triangular |y|-mask around the waterline pulls saturation
  // down and tints slightly cool to read as damp sand / wave-washed
  // rock. Full at y=0, zero beyond |y|≥2 m.
  const wet = smoothstep(float(2.0), float(0.0), abs(positionWorld.y))
  const withWet = mix(variedBaseCol, variedBaseCol.mul(vec3(0.78, 0.78, 0.85)), wet)

  mat.colorNode = withWet
  // Slope-driven roughness lift — rocks rougher than sand / grass so
  // lighting doesn't go uniformly matte across the island.
  mat.roughnessNode = mix(float(0.78), float(0.95), slope)

  return mat
}

/**
 * Bilinear value noise sampled on an XY plane. Hash-based, no texture.
 * Two octaves blended 1.0 + 0.5; output ≈ [0, 1].
 */
function valueNoiseOctave2D(p: Node<'vec2'>) {
  const layer1 = valueNoise2D(p)
  const layer2 = valueNoise2D(p.mul(2.03))
  return layer1.mul(0.667).add(layer2.mul(0.333))
}

function valueNoise2D(p: Node<'vec2'>) {
  const i = p.floor()
  const f = p.fract()
  const u = f.mul(f).mul(float(3).sub(f.mul(2)))
  const n00 = hash2(i)
  const n10 = hash2(i.add(vec2(1, 0)))
  const n01 = hash2(i.add(vec2(0, 1)))
  const n11 = hash2(i.add(vec2(1, 1)))
  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y)
}

function hash2(p: Node<'vec2'>) {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453))
}

/**
 * Walk a loaded glTF scene and swap any mesh authored as terrain over to
 * the runtime terrain material. Detection: Blender custom prop
 * ``kind = "track"`` on the object (lands in ``mesh.userData.kind``) or
 * a glTF material named ``mat_terrain_main`` (the name the GN seed
 * stamps). Other meshes — gates, decoration, foliage — are left alone.
 *
 * Returns the number of materials replaced, for caller logging.
 */
export function applyTerrainShaderToScene(root: THREE.Object3D): number {
  let count = 0
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const mat = obj.material as THREE.Material | THREE.Material[] | undefined
    if (!mat) return
    const kind = obj.userData?.kind
    const isTerrainName = (m: THREE.Material) => m.name === 'mat_terrain_main'
    const isTerrain =
      kind === 'track' ||
      (Array.isArray(mat) ? mat.some(isTerrainName) : isTerrainName(mat))
    if (!isTerrain) return
    const next = buildTerrainMaterial()
    // Dispose the original glTF material to free its baseColor texture etc.
    const dispose = (m: THREE.Material) => {
      try {
        m.dispose()
      } catch {
        /* ignore */
      }
    }
    if (Array.isArray(mat)) {
      for (const m of mat) dispose(m)
      obj.material = next as unknown as THREE.Material
    } else {
      dispose(mat)
      obj.material = next as unknown as THREE.Material
    }
    count++
  })
  return count
}
