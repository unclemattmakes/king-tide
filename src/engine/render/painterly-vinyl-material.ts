/**
 * Painterly-vinyl runtime material — the unified "look" layer for props.
 *
 * Props are instanced with their raw GLB material today (`props-mesh.ts`), so
 * they bypass every look pass. This wraps a prop's source material in a
 * `MeshStandardNodeMaterial` that KEEPS the incoming albedo (texture or flat
 * colour) and layers the intake-independent painterly-vinyl signature on top:
 * soft fresnel rim, matte finish, a subtle procedural weathering wash, and
 * (opt-in) the world-space waterline trio. The look becomes intake-independent —
 * a clean Quaternius atlas and an AI-painted skin both read painterly-vinyl
 * because they share this treatment. See docs/painterly-vinyl-pipeline.md.
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
import { assetUrl } from '../asset-url'
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
/** At/above this size (metres) the waterline band keeps its full physical height
 *  — a thin line on a big prop. Smaller props scale it down proportionally so a
 *  fixed-metre band doesn't swallow them. */
const WATERLINE_FULL_BAND_SIZE = 6

/** Brush-texture tile size as a fraction of (brushScale·propSize). The sheet
 *  packs ~13 strokes across, so the tile wants to be ≈ the prop (≈8-12 strokes
 *  across it). Without this the default brushScale would cram a whole sheet into
 *  a fraction of the prop and the strokes read as fine speckle. */
const BRUSH_TEX_TILE = 0.08

/** The shared painterly brush-stroke sheet (authored by
 *  tools/blender/build_brush_texture.py), loaded once and sampled triplanar by
 *  every vinyl material. It's DATA, not albedo — NoColorSpace + RepeatWrapping so
 *  it tiles seamlessly under the world/object-space sampling. */
let sharedBrushTex: THREE.Texture | null = null
function sharedBrushTexture(): THREE.Texture {
  if (sharedBrushTex) return sharedBrushTex
  try {
    const tex = new THREE.TextureLoader().load(assetUrl('/assets/textures/brush_strokes.png'))
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.colorSpace = THREE.NoColorSpace
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = THREE.LinearFilter
    sharedBrushTex = tex
  } catch {
    // No DOM image support (headless tests / SSR) — fall back to a neutral 1×1
    // mid-grey so material construction never throws; brush streaks read as a
    // no-op (0.5) until a real image-capable context loads the sheet.
    const grey = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1)
    grey.needsUpdate = true
    sharedBrushTex = grey
  }
  return sharedBrushTex
}

export type VinylOptions = {
  /** Mix toward the rim tint at the silhouette (0..~0.6). */
  rimStrength?: number
  /** Warm rim tint (linear). */
  rimColor?: [number, number, number]
  /** Procedural value-noise weathering wash amount (0 = off). */
  weathering?: number
  /** Directional brush-streak amount layered over the weathering (0 = off). */
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

/** Blend weights for the brush sheet's three packed stroke scales
 *  (R = coarse / G = medium / B = fine) as a function of prop size: big props
 *  lean to coarse sweeping strokes, small props to fine dabs. Gaussian kernels
 *  in log2(size) centred at 16 m / 4 m / 1 m, ALWAYS normalized to sum 1 — so
 *  the combined height field stays centred on 0.5 and a brush amount of 0 stays
 *  a true no-op. A grayscale sheet (R=G=B) collapses the blend to its old
 *  single-field behaviour for free. */
function brushScaleWeights(propSize: number): [number, number, number] {
  const lp = Math.log2(Math.min(Math.max(propSize, 0.25), 64))
  const k = (centre: number) => Math.exp(-(((lp - centre) / 1.4) ** 2))
  return normalizeMix([k(4), k(2), k(0)]) // coarse(16 m) / medium(4 m) / fine(1 m)
}

/** Normalize a 3-weight mix to sum 1 (falls back to all-medium if degenerate). */
function normalizeMix(m: [number, number, number]): [number, number, number] {
  const s = m[0] + m[1] + m[2]
  return s > 1e-6 ? [m[0] / s, m[1] / s, m[2] / s] : [0, 1, 0]
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
  const brush = opts.brush ?? 0.12
  const brushScale = opts.brushScale ?? 0.12
  const brushTextured = opts.brushTextured ?? true
  const waterLevel = opts.waterLevel ?? 0
  const waterlineStr = opts.waterline ?? 0
  const waterlineTide = opts.waterlineTide ?? 0.4
  const waterlineAlgae = opts.waterlineAlgae ?? 0.5
  const propSize = Math.max(opts.propSize ?? REF_PROP_SIZE, 0.05)
  const [wCoarse, wMed, wFine] = opts.brushScaleMix
    ? normalizeMix(opts.brushScaleMix)
    : brushScaleWeights(propSize)
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
  const an = vec3(abs(nrm.x), abs(nrm.y), abs(nrm.z))
  const wsum = an.x.add(an.y).add(an.z).add(float(1e-4))
  // brushScale is a FRACTION of the prop (propSize) — stroke size tracks prop
  // size, so the same dial reads on a 1 m chest and a 30 m cliff.
  const bScale = float(1 / Math.max(brushScale * propSize, 0.02))
  // Triplanar brush field — blended across the 3 world planes by the world
  // normal so strokes read on every face. brushTextured (default) samples the
  // shared stroke sheet (deliberate bristle strokes value-noise can't give);
  // else the procedural dirStreak. One texel fetch per plane, combining the
  // sheet's three packed stroke SCALES (R coarse / G medium / B fine) by the
  // prop-size weights — sum 1, so the field stays centred on mid-grey and a
  // brush amount of 0 stays a true no-op. Feeds brushFac (albedo) + relief.
  const brushTex = sharedBrushTexture()
  const sampleStreak = (p: Node<'vec2'>) => {
    if (!brushTextured) return dirStreak(p, bScale)
    const t = texture(brushTex, p.mul(bScale).mul(float(BRUSH_TEX_TILE)))
    return t.r
      .mul(float(wCoarse))
      .add(t.g.mul(float(wMed)))
      .add(t.b.mul(float(wFine)))
  }
  const streak = sampleStreak(vec2(positionWorld.z, positionWorld.y))
    .mul(an.x)
    .add(sampleStreak(vec2(positionWorld.x, positionWorld.z)).mul(an.y))
    .add(sampleStreak(vec2(positionWorld.x, positionWorld.y)).mul(an.z))
    .div(wsum)
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
