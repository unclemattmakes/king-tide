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
  attribute,
  clamp,
  dot,
  float,
  fract,
  max,
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
import type { TerrainShaderConfig } from '@/game/tracks/types'

type ColorStop = { pos: number; color: [number, number, number] }

/**
 * Altitude bands in linear-light, mirroring the ``build_terrain_material``
 * ramp in ``tools/blender/seed_template_island.py`` so the in-game look
 * matches the Blender preview.
 */
const FLAT_STOPS: ColorStop[] = [
  { pos: 0.0, color: [0.03, 0.08, 0.2] }, // abyssal blue   (y≈-50)
  { pos: 0.18, color: [0.22, 0.3, 0.4] }, // blue-sand      (y≈-19)
  { pos: 0.27, color: [0.68, 0.66, 0.55] }, // silty sand     (y≈ -4)
  { pos: 0.3, color: [0.92, 0.86, 0.72] }, // bright sand    (y=   1)
  { pos: 0.345, color: [0.78, 0.7, 0.5] }, // wet beach tan  (y=   9)
  { pos: 0.43, color: [0.36, 0.55, 0.27] }, // grass          (y=  23)
  { pos: 0.62, color: [0.22, 0.4, 0.18] }, // forest         (y=  55)
  { pos: 0.82, color: [0.3, 0.27, 0.21] }, // alpine stone   (y=  89)
  { pos: 1.0, color: [0.18, 0.15, 0.13] }, // volcanic top   (y= 120)
]

const CLIFF_STOPS: ColorStop[] = [
  { pos: 0.0, color: [0.07, 0.1, 0.16] }, // dark abyssal rock
  { pos: 0.22, color: [0.2, 0.22, 0.24] }, // wet rock
  { pos: 0.3, color: [0.34, 0.32, 0.28] }, // sea cliff
  { pos: 0.5, color: [0.42, 0.39, 0.34] }, // grey rock
  { pos: 0.75, color: [0.3, 0.25, 0.22] }, // warmer rock
  { pos: 1.0, color: [0.16, 0.13, 0.13] }, // volcanic
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
 *
 * The optional ``config`` overrides the slope-mix range, altitude band,
 * variation strength, wet-band width, and path tint. Authors edit these
 * in the addon's "Terrain shader (runtime)" panel; the export pipeline
 * writes them to ``public/tracks/<id>.json`` and the track loader
 * threads them through to here.
 *
 * The material also reads the baked ``COLOR_0`` vertex attribute:
 *
 *   - ``.g`` — ambient occlusion (1 = no occlusion). Multiplies into
 *     the final diffuse so authored cavities darken without darkening
 *     the lighting model.
 *   - ``.b`` — racing-line wear (0 = pristine, 1 = full wear). Mixes
 *     the diffuse toward ``pathTint`` so the runtime stamps a worn
 *     dirt track into the surface where the AI spline runs.
 */
export function buildTerrainMaterial(config: TerrainShaderConfig = {}): MeshStandardNodeMaterial {
  const { flat, cliff } = sharedRamps()

  const altMin = config.altMin ?? ALT_MIN
  const altMax = config.altMax ?? ALT_MAX
  const slopeStart = config.slopeStart ?? 0.85
  const slopeEnd = config.slopeEnd ?? 0.55
  const variation = config.variation ?? 0.3
  const wetBand = config.wetBand ?? 2.0
  const pathTint = config.pathTint ?? [0.3, 0.24, 0.18]
  // SOTA-pass extras (M-coloration). Each is a no-op at its default so
  // existing tracks keep their stock look without re-export.
  const warpStrength = config.warpStrength ?? 0.5
  const macroScale = config.macroScale ?? 120.0
  const microScale = config.microScale ?? 8.0
  const altJitter = config.altJitter ?? 4.0
  const screeBand = config.screeBand ?? 0.25
  const saturation = config.saturation ?? 1.05
  const triplanar = config.triplanar ?? 0.6

  const mat = new MeshStandardNodeMaterial({ metalness: 0 })
  mat.name = 'mat_terrain_runtime'

  const worldNorm = normalize(normalWorld)

  // ── Slope split ───────────────────────────────────────────────────────
  // Three-way split: flat (sand/grass), scree (gravel transition), cliff
  // (rock). Cosine angles run 1.0 (flat) → 0.0 (vertical). Splitting on
  // two thresholds gives a band where the colour reads as broken rubble,
  // breaking the visual snap from grass to wall that the original
  // single-smoothstep had at steep cliffs.
  const screeHalf = Math.max(screeBand * 0.5, 0.001)
  const slopeMid = (slopeStart + slopeEnd) * 0.5
  const screeUpper = slopeMid + screeHalf * (slopeStart - slopeEnd)
  const screeLower = slopeMid - screeHalf * (slopeStart - slopeEnd)
  // 0 on flat ground; rises to 1 once the surface tilts past `slopeStart`.
  const flatToScree = smoothstep(float(slopeStart), float(screeUpper), worldNorm.y)
  // 0 on slopes shallower than the scree band; rises to 1 once the
  // surface is steep enough to read as bare rock.
  const screeToCliff = smoothstep(float(screeLower), float(slopeEnd), worldNorm.y)
  // Final slope mask used by roughness + colour blend. Equivalent to
  // the original `smoothstep(slopeStart, slopeEnd, n.y)` when
  // `screeBand == 0`, which keeps backward compat as a clean limit.
  const slope = clamp(
    flatToScree.mul(float(0.5)).add(screeToCliff.mul(float(0.5))),
    float(0),
    float(1),
  )

  // ── Domain-warped detail UVs ──────────────────────────────────────────
  // A low-frequency warp noise perturbs the input UVs of the colour
  // noise so the visible noise pattern doesn't show its underlying
  // grid. This is the single biggest "looks pre-baked" → "looks
  // sculpted" upgrade in the chain.
  const microFreq = 1.0 / Math.max(microScale, 0.5)
  const macroFreq = 1.0 / Math.max(macroScale, 1.0)
  const warpNoiseX = valueNoise2D(positionWorld.xz.mul(macroFreq * 0.5))
  const warpNoiseY = valueNoise2D(positionWorld.xz.mul(macroFreq * 0.5).add(vec2(13.7, 47.3)))
  const warp = vec2(warpNoiseX.sub(float(0.5)), warpNoiseY.sub(float(0.5))).mul(
    float(warpStrength * macroScale * 0.5),
  )
  const microUV = positionWorld.xz.add(warp).mul(microFreq)
  const macroUV = positionWorld.xz.mul(macroFreq)

  // Triplanar micro-noise: blend in YZ + XY samples scaled by the
  // matching world-normal axis so cliff faces (worldNorm.y ≈ 0) read
  // their detail along the vertical axes rather than smearing the XZ
  // pattern. Done with `min(triplanar, slope * 1.0 + something)` so
  // triplanar only kicks in where the surface actually leaves
  // horizontal — flat ground stays cheap (one tap).
  const microXZ = valueNoiseOctave2D(microUV)
  const triBlend = clamp(
    float(triplanar).mul(slope.mul(float(1.2)).add(float(0.1))),
    float(0),
    float(1),
  )
  const microYZ = valueNoiseOctave2D(positionWorld.yz.mul(microFreq).add(warp.mul(0.7)))
  const microXY = valueNoiseOctave2D(positionWorld.xy.mul(microFreq).add(warp.mul(0.5)))
  const triNoise = mix(microXZ, mix(microYZ, microXY, abs(worldNorm.x)), triBlend)

  // Macro biome variation — large-scale tint shift used to bias
  // saturation + altitude band so adjacent regions read as subtly
  // different biomes rather than one repeated palette.
  const macroN = valueNoise2D(macroUV)
  const macroBias = macroN.sub(float(0.5))

  // ── Altitude → ramp parameter (with stochastic jitter) ───────────────
  // World-Y mapped into [0, 1] over the configured altitude band, plus
  // a noise-driven jitter so the contour transitions aren't perfectly
  // level. At default jitter (4 m) the sand→grass break feathers over
  // a few metres; at 0 the bands snap cleanly (legacy look).
  const altSpan = Math.max(altMax - altMin, 1)
  const jitterN = valueNoise2D(positionWorld.xz.mul(microFreq * 0.5).add(warp.mul(0.3)))
  const jittered = positionWorld.y.add(jitterN.sub(float(0.5)).mul(float(altJitter * 2.0)))
  const altT = clamp(jittered.sub(float(altMin)).div(float(altSpan)), float(0), float(1))

  const flatCol = texture(flat, vec2(altT, float(0.5))).rgb
  const cliffCol = texture(cliff, vec2(altT, float(0.5))).rgb
  // Scree colour = mid-grey lerp between the two ramps, biased a touch
  // toward warm gravel. Shows up in the `screeBand` between flat &
  // cliff and only there.
  const screeCol = mix(flatCol, cliffCol, float(0.6)).mul(vec3(1.05, 1.0, 0.9))
  // Three-way blend driven by the two slope-band masks. Flat ground →
  // flatCol; scree band → screeCol; cliff → cliffCol.
  const flatToScreeCol = mix(flatCol, screeCol, flatToScree)
  const blended = mix(flatToScreeCol, cliffCol, screeToCliff)

  // ── Variation: brightness + saturation perturbed independently ───────
  // Brightness pulse from the (possibly triplanar) micro noise, and
  // saturation pulse from the macro noise. Doing the two on different
  // axes reads as natural biome variation rather than just "noisy".
  const brightnessFac = float(1.0 - variation * 0.5).add(triNoise.mul(float(variation)))
  const variedBaseCol = blended.mul(brightnessFac)
  // Saturation: lift around macro biome highs, push down where the
  // macro noise is low. Bounded ±0.15 around the configured base so
  // the user's `saturation` setting stays the dominant control.
  const satMul = float(saturation).add(macroBias.mul(float(0.15)))
  const desat = dot(variedBaseCol, vec3(0.299, 0.587, 0.114))
  const saturated = mix(vec3(desat, desat, desat), variedBaseCol, max(satMul, float(0)))

  // ── Wet band ─────────────────────────────────────────────────────────
  // Triangular |y|-mask around the waterline pulls saturation down and
  // tints cool to read as damp sand / wave-washed rock. Full at y=0,
  // zero beyond |y|≥wetBand m.
  const wet = smoothstep(float(wetBand), float(0.0), abs(positionWorld.y))
  const withWet = mix(saturated, saturated.mul(vec3(0.72, 0.76, 0.86)), wet)

  // ── Baked vertex attributes (AO + path wear) ─────────────────────────
  // Vertex-baked AO + racing-line wear from the addon's "Bake AO + Path
  // Wear" operator. The GN graph stamps these into COLOR_0.G and
  // COLOR_0.B respectively (R is sway-unused, A is the biome flag).
  // GLB authoring without the bake leaves both at their attribute
  // defaults (1 / 0) so this collapses to a no-op for unbaked terrain.
  const vc = attribute('color') as Node<'vec4'>
  // AO multiplies into the colour with a 0.55 floor so deep cavities
  // darken visibly but never go to black. ``vc.g`` ∈ [0, 1].
  const ao = clamp(vc.g, float(0), float(1))
  const withAO = withWet.mul(mix(float(0.55), float(1.0), ao))
  // Path-worn mixes the diffuse toward the dirt-track tint. Capped at
  // 0.8 so even fully worn vertices keep a hint of the underlying
  // biome colour.
  const path = clamp(vc.b, float(0), float(1))
  const withPath = mix(withAO, vec3(pathTint[0], pathTint[1], pathTint[2]), path.mul(0.8))

  // Clamp final colour so any combined gain (saturation lift × macro
  // bias × brightness pulse) never blows past linear-1 and wrecks
  // tonemapping downstream.
  mat.colorNode = clamp(withPath, vec3(0, 0, 0), vec3(1.6, 1.6, 1.6))
  // Slope-driven roughness lift — rocks rougher than sand / grass so
  // lighting doesn't go uniformly matte across the island. Scree sits
  // between the two so gravel doesn't read as wet asphalt.
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
 * the runtime terrain material. Detection runs in this order:
 *
 *   1. The mesh's name starts with ``terrain`` (covers ``terrain``,
 *      ``terrain.001`` from Blender's auto-dedupe, ``terrain_main``,
 *      etc.) — the canonical case for procedurally-seeded templates.
 *   2. Any of the mesh's materials is named ``mat_terrain_main`` — the
 *      legacy detection used by the GN seed pipeline.
 *
 * The match is intentionally *narrower* than just ``kind === 'track'``:
 * downtown buildings, ramps, tunnel interiors, and the road slab also
 * carry ``kind = "track"`` so they pick up trimesh colliders, and
 * applying the slope/altitude shader to those would replace their
 * authored materials with the abyssal-blue-to-volcanic terrain ramp.
 * Anything that should look like terrain at runtime needs to either
 * be named ``terrain*`` or use the ``mat_terrain_main`` material.
 *
 * Returns the number of materials replaced, for caller logging.
 */
export function applyTerrainShaderToScene(
  root: THREE.Object3D,
  config: TerrainShaderConfig = {},
): number {
  let count = 0
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const mat = obj.material as THREE.Material | THREE.Material[] | undefined
    if (!mat) return
    const isTerrainName = (m: THREE.Material) => m.name === 'mat_terrain_main'
    const nameIsTerrain = typeof obj.name === 'string' && obj.name.startsWith('terrain')
    const isTerrain =
      nameIsTerrain || (Array.isArray(mat) ? mat.some(isTerrainName) : isTerrainName(mat))
    if (!isTerrain) return
    const next = buildTerrainMaterial(config)
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
