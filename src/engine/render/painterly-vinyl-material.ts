/**
 * Painterly-vinyl runtime material — the unified "look" layer for props AND
 * the track's buildings / set-pieces.
 *
 * Props are instanced with their raw GLB material (`props-mesh.ts`) and the
 * track's buildings/docks/ramps ship with whatever stock material Blender
 * exported, so both bypass every look pass. This wraps a source material in a
 * `MeshStandardNodeMaterial` that KEEPS the incoming albedo (texture or flat
 * colour) and layers the intake-independent painterly-vinyl signature on top:
 * soft fresnel rim, matte finish, a subtle procedural weathering wash, brush
 * strokes, and (opt-in) the world-space waterline trio. The look becomes
 * intake-independent — a clean Quaternius atlas and an AI-painted skin both read
 * painterly-vinyl because they share this treatment. `buildVinylMaterial`
 * converts one material; `applyVinylMaterialToScene` runs it over every
 * still-stock mesh in a loaded track. See docs/painterly-vinyl-pipeline.md.
 *
 * Built on idioms already shipping: the GLB->node copy pattern from
 * `foliage-sway.ts` (`toSwayNodeMaterial`), the fresnel rim from `clouds.ts`,
 * and the value-noise + waterline math from `terrain-shader.ts` (waterline
 * factored into ./waterline). WebGPU/TSL only — never `ShaderMaterial`.
 */
import * as THREE from 'three'
import type Node from 'three/src/nodes/core/Node.js'
import {
  abs,
  attribute,
  bumpMap,
  cameraPosition,
  clamp,
  cos,
  dot,
  float,
  fract,
  mix,
  normalize,
  normalWorld,
  positionWorld,
  pow,
  sin,
  texture,
  vec2,
  vec3,
} from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { ExportedKind } from '../asset-kinds'
import { brushHeightTriplanar, brushScaleWeights, normalizeMix } from './brush-strokes'
import { applyWaterlineBands } from './waterline'

/** Marks a material we've already vinyl-converted, so conversion is idempotent
 *  and a source material shared by reference converts once. */
const VINYL_MARKED = Symbol.for('hoverbike.painterlyVinyl')

/** Source visual props copied from the GLB material onto the node replacement.
 *  Deliberately DROPS roughnessMap/metalnessMap/aoMap — vinyl wants a uniform
 *  matte finish and computes its own AO from COLOR_0. */
const COPIED_PROPS = [
  'map',
  'normalMap',
  'normalScale',
  'emissiveMap',
  'alphaMap',
  'transparent',
  'opacity',
  'alphaTest',
  'side',
  'depthWrite',
  'depthTest',
  'emissiveIntensity',
] as const

/** propSize the absolute look was tuned at — a call with no propSize behaves as
 *  if dressing a prop this big (metres). */
const REF_PROP_SIZE = 4
/** The brush stops treating a prop as "bigger" past this size (metres). Stroke
 *  size tracks prop size up to here, then holds — so a big form (a 20 m sea
 *  stack, a cliff, a hull) gets MORE strokes rather than a few giant ones.
 *  Without the cap, brushScaleWeights drives big props fully to the coarse
 *  channel and the tile period blows out, so the brushwork reads as a flat wash.
 *  Small / medium props (< cap) are unaffected — the chest/barrel tuning holds. */
const BRUSH_PROP_SIZE_CAP = 6
/** At/above this size (metres) the waterline band keeps its full physical height
 *  — a thin line on a big prop. Smaller props scale it down proportionally so a
 *  fixed-metre band doesn't swallow them. */
const WATERLINE_FULL_BAND_SIZE = 6

export type VinylOptions = {
  /** Mix toward the rim tint at the silhouette (0..~0.6). */
  rimStrength?: number
  /** Warm rim tint (linear). */
  rimColor?: [number, number, number]
  /** Procedural value-noise weathering wash amount (0 = off). */
  weathering?: number
  /** Brush-stroke amount layered over the weathering — modulates albedo and
   *  drives the impasto relief (normal + roughness). Default 0.7 (props +
   *  buildings; landed strong-then-pulled-back on the real oil-stroke sheet,
   *  which reads softer than the procedural fallback); 0 = off. */
  brush?: number
  /** Brush-streak size as a FRACTION of the prop (see propSize), so strokes read
   *  the same on a chest and a cliff. Smaller = finer strokes. */
  brushScale?: number
  /** Sample the shared brush-stroke sheet (default true) vs the procedural
   *  value-noise streaks — the sheet gives bolder, deliberate bristle strokes.
   *  The sheet packs three stroke SCALES in R/G/B (coarse/medium/fine); they're
   *  blended by prop size (see brushScaleMix). */
  brushTextured?: boolean
  /** Override the R/G/B (coarse/medium/fine) stroke-scale blend. Omit → derived
   *  from propSize (big props lean coarse, small lean fine). Auto-normalized to
   *  sum 1, so the combined field stays centred and brush 0 stays a no-op. */
  brushScaleMix?: [number, number, number]
  /** The prop's characteristic size in metres (≈ its max bbox dimension). Makes
   *  the brush-stroke size and the waterline band scale-relative so one set of
   *  dials reads right from a ~1 m chest to a ~30 m cliff. Omit → a neutral mid
   *  reference (REF_PROP_SIZE). */
  propSize?: number
  /** Real sea level for the waterline bands. */
  waterLevel?: number
  /** Waterline strength (0 = off — the default; opt in per call). */
  waterline?: number
  /** How far ABOVE the line the crust/bleach high-tide band reaches, metres. */
  waterlineTide?: number
  /** Submerged algae tint depth (0..1): 0 = none, 1 = full algae tone. Tints
   *  the base rather than overpainting it. */
  waterlineAlgae?: number
  /** Matte roughness (vinyl ~ 0.8). */
  roughness?: number
  /** Edge-wear drybrush amount (default 0.66; 0 = off): lighten convex edges
   *  toward edgeWearColor to pop sculpted forms (rocks). Reads the per-vertex
   *  convexity the conditioner bakes into COLOR_0.A — a flat prop has A=1 so this
   *  is a no-op (edge = 1−A = 0) until the prop carries real convexity. */
  edgeWear?: number
  /** Edge-wear tint (linear) — a bleached drybrush highlight. */
  edgeWearColor?: [number, number, number]
}

// ── Self-contained value noise (verbatim from terrain-shader.ts) ────────────
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

/** One plane's directional brush streak: a value-noise field rotated by a
 *  low-frequency flow angle then stretched along the stroke, so it reads as a
 *  hand-painted streak rather than isotropic mottling. Returns ~0..1. */
function dirStreak(p: Node<'vec2'>, bScale: Node<'float'>) {
  const flow = valueNoise2D(p.mul(float(0.05)))
  const ang = flow.mul(float(Math.PI))
  const ca = cos(ang)
  const sa = sin(ang)
  const along = p.x.mul(ca).add(p.y.mul(sa))
  const across = p.x.mul(sa).negate().add(p.y.mul(ca))
  // Across-axis frequency >> along-axis -> thin bristle lines that run ALONG the
  // stroke instead of blobby patches. The slow flow field (0.05) keeps
  // neighbouring strokes roughly parallel, so it reads as brushwork, not camo.
  return valueNoiseOctave2D(vec2(along.mul(float(0.8)), across.mul(float(14.0))).mul(bScale))
}

/**
 * Convert a single GLB material into its painterly-vinyl node-material twin.
 * Idempotent (returns the input unchanged once marked). Does not mutate `src`.
 */
export function buildVinylMaterial(src: THREE.Material, opts: VinylOptions = {}): THREE.Material {
  const marked = src as THREE.Material & { userData: Record<string | symbol, unknown> }
  if (marked.userData && marked.userData[VINYL_MARKED]) return src

  const rimStrength = opts.rimStrength ?? 0.5
  const rimColor = opts.rimColor ?? [1.0, 0.93, 0.82]
  const weathering = opts.weathering ?? 0.12
  const brush = opts.brush ?? 0.7
  const brushScale = opts.brushScale ?? 0.12
  const brushTextured = opts.brushTextured ?? true
  const waterLevel = opts.waterLevel ?? 0
  const waterlineStr = opts.waterline ?? 0
  const waterlineTide = opts.waterlineTide ?? 0.4
  const waterlineAlgae = opts.waterlineAlgae ?? 0.5
  const propSize = Math.max(opts.propSize ?? REF_PROP_SIZE, 0.05)
  // Cap the size the BRUSH reads (not the waterline band) so big props get more
  // strokes, not giant ones — see BRUSH_PROP_SIZE_CAP. This is the fix for the
  // sea-stack/cliff "reads flat" case: they're 13–32 m, which without the cap
  // leans fully coarse + a ~40 m tile period = 2–3 huge strokes.
  const brushPropSize = Math.min(propSize, BRUSH_PROP_SIZE_CAP)
  const [wCoarse, wMed, wFine] = opts.brushScaleMix
    ? normalizeMix(opts.brushScaleMix)
    : brushScaleWeights(brushPropSize)
  const roughness = opts.roughness ?? 0.82
  const edgeWear = opts.edgeWear ?? 0.66
  const edgeWearColor = opts.edgeWearColor ?? [0.95, 0.92, 0.83]

  const next = new MeshStandardNodeMaterial({ metalness: 0, roughness })
  next.name = src.name ? `mat_vinyl_${src.name}` : 'mat_vinyl'

  const std = src as Partial<THREE.MeshStandardMaterial> & THREE.Material
  for (const key of COPIED_PROPS) {
    const v = (std as unknown as Record<string, unknown>)[key]
    if (v !== undefined && v !== null) (next as unknown as Record<string, unknown>)[key] = v
  }
  if (std.color) next.color.copy(std.color)
  if (std.emissive) next.emissive.copy(std.emissive)

  // Base albedo = source texture (if any) x base colour. Built explicitly so we
  // can layer nodes; deliberately does NOT fold COLOR_0 in as a tint (it's a
  // parameter channel here, not vertex colour — this also sidesteps the
  // auto-vertexColors albedo multiply that would otherwise darken props).
  const baseTint = vec3(next.color.r, next.color.g, next.color.b)
  const mapRgb = std.map ? texture(std.map as THREE.Texture).rgb : vec3(1, 1, 1)
  const albedo = mapRgb.mul(baseTint)

  // AO from COLOR_0.g (identity at the neutral 1.0 the conditioner stamps).
  const vc = attribute('color') as Node<'vec4'>
  const ao = clamp(vc.g, float(0), float(1))
  const withAO = albedo.mul(mix(float(0.55), float(1.0), ao))

  // Procedural weathering wash — subtle value-noise mottling in world XZ so a
  // flat-tint prop reads as painted, not plastic. weathering 0 -> washFac 1.
  const wn = valueNoiseOctave2D(positionWorld.xz.mul(float(1 / 3)))
  const washFac = float(1.0 - weathering * 0.5).add(wn.mul(float(weathering)))
  const washed = withAO.mul(washFac)

  // Procedural brush streaks — TRIPLANAR directional value-noise so strokes
  // read on EVERY face, not just up-facing ones (the v1 world-XZ limit). Each
  // world plane gets a streak stretched along its own flow field; the three are
  // blended by the world normal. brush 0 -> no-op. (dirStreak does the per-plane
  // flow-rotate + stretch.)
  const nrm = normalize(normalWorld)
  // Triplanar brush field — strokes read on every face, combining the sheet's
  // three packed stroke SCALES (R coarse / G medium / B fine) by the prop-size
  // weights (sum 1, so the field stays centred on mid-grey and brush 0 is a true
  // no-op). brushScale is a FRACTION of the prop (brushPropSize) so stroke size
  // tracks prop size up to BRUSH_PROP_SIZE_CAP, then holds — small props read the
  // same while big forms get more strokes, not giant ones. The textured sheet
  // (default) gives deliberate bristle strokes value-noise can't; brushTextured=
  // false falls back to the procedural dirStreak. Feeds brushFac (albedo) + the
  // impasto relief. Shared with terrain via ./brush-strokes.
  const brushWorldScale = 1 / Math.max(brushScale * brushPropSize, 0.02)
  let streak: Node<'float'>
  if (brushTextured) {
    streak = brushHeightTriplanar(positionWorld, normalWorld, brushWorldScale, [
      wCoarse,
      wMed,
      wFine,
    ])
  } else {
    const an = vec3(abs(nrm.x), abs(nrm.y), abs(nrm.z))
    const wsum = an.x.add(an.y).add(an.z).add(float(1e-4))
    const bScale = float(brushWorldScale)
    const sampleStreak = (p: Node<'vec2'>) => dirStreak(p, bScale)
    streak = sampleStreak(vec2(positionWorld.z, positionWorld.y))
      .mul(an.x)
      .add(sampleStreak(vec2(positionWorld.x, positionWorld.z)).mul(an.y))
      .add(sampleStreak(vec2(positionWorld.x, positionWorld.y)).mul(an.z))
      .div(wsum)
  }
  const brushFac = float(1).add(streak.sub(float(0.5)).mul(float(brush).mul(float(3.0))))

  // World-space waterline trio FIRST, on the UN-brushed wash (opt-in; strength
  // 0 = no-op). The band height shrinks on small props (kept full on big ones)
  // so a fixed-metre salt band doesn't swallow a 1 m chest.
  const bandScale = Math.min(propSize / WATERLINE_FULL_BAND_SIZE, 1)
  const banded = applyWaterlineBands(
    washed,
    waterLevel,
    waterlineStr,
    waterlineTide,
    waterlineAlgae,
    bandScale,
  )
  // ...THEN ride the brush over the whole banded result, so the strokes land in
  // the salt/bleach band too — not just the base. Base + algae are pure
  // multiplies, so brushing after them is mathematically identical there; only
  // the salt's mix-toward-bleach (a flat wash before) gains the painterly strokes.
  const brushed = banded.mul(brushFac)

  // Edge wear — drybrush convex edges (the painted-miniature pop on rocks).
  // Convexity is baked per-vertex into COLOR_0.A by the conditioner (1 = flat,
  // <1 = convex ridge), so this is a smooth, shimmer-free gradient that works on
  // the smooth auto-smoothed rocks — unlike screen-space curvature, which caught
  // the tessellation. edgeWear 0 -> no-op (and a flat A=1 -> edge 0).
  const edgeMask = clamp(float(1).sub(vc.a), float(0), float(1))
  const edgeTint = vec3(edgeWearColor[0], edgeWearColor[1], edgeWearColor[2])
  const worn = mix(brushed, edgeTint, edgeMask.mul(float(edgeWear)))

  // Soft fresnel rim — pops the silhouette off sky/water, no outline (clouds.ts).
  const view = normalize(cameraPosition.sub(positionWorld))
  const ndv = clamp(dot(nrm, view), float(0), float(1))
  const rim = pow(clamp(float(1).sub(ndv), float(0), float(1)), float(3.0))
  const rimTint = vec3(rimColor[0], rimColor[1], rimColor[2])
  const withRim = mix(worn, rimTint, rim.mul(float(rimStrength)))

  next.colorNode = clamp(withRim, vec3(0, 0, 0), vec3(1.6, 1.6, 1.6))

  // Brush RELIEF — the impasto read. Stroke height modulates roughness (matte
  // sheen breaks up along strokes) and perturbs the shading normal (light
  // catches the ridges). Both scale with `brush`, so brush 0 leaves the matte
  // surface untouched.
  next.roughnessNode = clamp(
    float(roughness).add(streak.sub(float(0.5)).mul(float(brush).mul(float(1.2)))),
    float(0.4),
    float(1.0),
  )
  next.normalNode = bumpMap(streak, float(brush).mul(float(2.5)))

  marked2(next).userData[VINYL_MARKED] = true
  next.needsUpdate = true
  return next
}

function marked2(
  m: THREE.Material,
): THREE.Material & { userData: Record<string | symbol, unknown> } {
  return m as THREE.Material & { userData: Record<string | symbol, unknown> }
}

/** Kinds whose meshes never take the vinyl look: render-only overlays, hidden
 *  collision proxies, the far-field ring, and the water marker. Terrain, foliage
 *  and lava are excluded by material name below (they own bespoke materials). */
const VINYL_SKIP_KINDS: ReadonlySet<string> = new Set([
  ExportedKind.DECAL,
  ExportedKind.EMITTER,
  ExportedKind.HORIZON,
  ExportedKind.COLLIDER_MESH,
  ExportedKind.WATER,
])

/** True for materials another look-pass already owns (terrain / foliage / lava)
 *  or one we've already converted — leave them be. */
function ownedByAnotherPass(m: THREE.Material): boolean {
  const n = m?.name ?? ''
  return (
    n.startsWith('mat_terrain') || // slope/altitude shader
    n.startsWith('mat_foliage_') || // wind sway
    n.startsWith('mat_lava') || // emissive landmark
    n.startsWith('mat_vinyl') // already us
  )
}

/** Stamp a neutral white COLOR_0 on a geometry that lacks one so the vinyl
 *  material's COLOR_0-driven channels collapse to no-ops. Track buildings /
 *  set-pieces ship WITHOUT COLOR_0 (only terrain gets it baked — see
 *  docs note track_glb_color0_export_gap), and an absent attribute reads 0 on
 *  every channel under TSL: that would drive AO (vc.g) to 0 — darkening the
 *  mesh to 0.55× — and edge-wear (1 − vc.a) to 1 — bleaching every face. White
 *  means AO 1 (no darken) and A 1 (edgeMask 0, no wear). Idempotent; the
 *  material reads the attribute explicitly (vertexColors stays off) so this
 *  never doubles as an albedo multiply. */
function ensureNeutralVertexColor(geom: THREE.BufferGeometry): void {
  if (geom.getAttribute('color')) return
  const n = geom.getAttribute('position')?.count ?? 0
  if (!n) return
  const data = new Float32Array(n * 4).fill(1)
  geom.setAttribute('color', new THREE.BufferAttribute(data, 4))
}

export type VinylSceneOptions = {
  /** Real sea level for the (opt-in) waterline bands on set-pieces. */
  waterLevel?: number
  /** Waterline strength (0 = off). Thread the track's terrain waterline here so
   *  a coastal building gets the same salt/algae read as the terrain it sits on. */
  waterline?: number
  /** Override the brush amount for set-pieces (default: buildVinylMaterial's
   *  shipped 0.5). Backdrop walls can want a gentler hand than hero props. */
  brush?: number
}

/**
 * Walk a loaded glTF track scene and wrap every still-stock mesh in the
 * painterly-vinyl material — the buildings / docks / ramps / set-pieces that
 * `loadGlbTrackVisuals` otherwise leaves on their raw Blender material. This is
 * what makes the vinyl look the DEFAULT read of a track rather than a prop-only
 * treatment (see docs/painterly-vinyl-pipeline.md, P2).
 *
 * Additive: the vinyl material KEEPS each mesh's incoming albedo and only layers
 * rim + matte + weathering + brush on top, so authored building colours survive.
 * Skips terrain (slope shader), foliage (sway), lava (emissive), and the
 * render-only / hidden kinds. Per-mesh size scales the brush + waterline band.
 *
 * Returns the number of materials converted, for caller logging.
 */
export function applyVinylMaterialToScene(
  root: THREE.Object3D,
  opts: VinylSceneOptions = {},
): number {
  root.updateMatrixWorld(true)
  // Convert once per (source material, size bucket): a material shared across
  // meshes yields one vinyl twin, preserving whatever batching existed.
  const cache = new Map<THREE.Material, Map<string, THREE.Material>>()
  const localBox = new THREE.Box3()
  const sizeV = new THREE.Vector3()
  const scaleV = new THREE.Vector3()
  const tmpPos = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()
  let count = 0

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !obj.visible) return
    const kind = (obj.userData as { kind?: unknown })?.kind
    if (typeof kind === 'string' && VINYL_SKIP_KINDS.has(kind)) return
    // Terrain keeps its slope/altitude shader (name OR material match, mirroring
    // applyTerrainShaderToScene's detection).
    if (typeof obj.name === 'string' && obj.name.startsWith('terrain')) return
    const mat = obj.material as THREE.Material | THREE.Material[] | undefined
    if (!mat) return
    const allOwned = Array.isArray(mat) ? mat.every(ownedByAnotherPass) : ownedByAnotherPass(mat)
    if (allOwned) return

    // Per-mesh characteristic size (its own geometry bbox × world scale, NOT the
    // subtree) drives the scale-relative brush + waterline band.
    const geom = obj.geometry as THREE.BufferGeometry
    if (!geom.boundingBox) geom.computeBoundingBox()
    let propSize = 4
    if (geom.boundingBox) {
      geom.boundingBox.getSize(sizeV)
      obj.matrixWorld.decompose(tmpPos, tmpQuat, scaleV)
      propSize = Math.max(
        sizeV.x * Math.abs(scaleV.x),
        sizeV.y * Math.abs(scaleV.y),
        sizeV.z * Math.abs(scaleV.z),
        0.05,
      )
    } else {
      localBox.setFromObject(obj)
      localBox.getSize(sizeV)
      propSize = Math.max(sizeV.x, sizeV.y, sizeV.z, 0.05)
    }

    ensureNeutralVertexColor(geom)
    const sizeKey = (Math.round(propSize * 2) / 2).toFixed(1)
    const convert = (m: THREE.Material): THREE.Material => {
      if (ownedByAnotherPass(m)) return m
      let bySize = cache.get(m)
      if (!bySize) {
        bySize = new Map()
        cache.set(m, bySize)
      }
      const hit = bySize.get(sizeKey)
      if (hit) return hit
      const v = buildVinylMaterial(m, {
        propSize,
        waterLevel: opts.waterLevel ?? 0,
        waterline: opts.waterline ?? 0,
        ...(opts.brush !== undefined ? { brush: opts.brush } : {}),
        // Buildings carry no baked convexity (COLOR_0.A is stamped neutral
        // above), so disable edge wear explicitly — a future real-COLOR_0
        // set-piece shouldn't get surprise drybrush bleaching from this pass.
        edgeWear: 0,
      })
      bySize.set(sizeKey, v)
      count++
      return v
    }
    obj.material = Array.isArray(mat) ? mat.map(convert) : convert(mat)
  })
  return count
}
