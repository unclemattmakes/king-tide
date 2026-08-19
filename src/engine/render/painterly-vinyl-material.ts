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
  materialEmissive,
  mix,
  nodeObject,
  normalize,
  normalLocal,
  normalWorld,
  positionLocal,
  positionWorld,
  pow,
  sin,
  texture,
  uniform,
  userData,
  vec2,
  vec3,
} from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { ExportedKind } from '../asset-kinds'
import {
  BRUSH_TEX_TILE,
  brushHeightTriplanar,
  brushScaleWeights,
  normalizeMix,
} from './brush-strokes'
import {
  registerVinylBrush,
  VINYL_BRUSH_DEFAULTS,
  type VinylBrushHandle,
  type VinylBrushValues,
} from './brush-tuning-service'
import { stampConvexityColor0 } from './edge-wear-convexity'
import {
  buildIllustrativeRim,
  IllustrativeLightingModel,
  type IllustrativeRim,
  sharedWarpRampTexture,
} from './illustrative-lighting'
import { applyWaterlineBands } from './waterline'

/** Marks a material we've already vinyl-converted, so conversion is idempotent
 *  and a source material shared by reference converts once. */
const VINYL_MARKED = Symbol.for('hoverbike.painterlyVinyl')

/** Material-userData key holding the additive-rim handle ({@link IllustrativeRim})
 *  so a per-object consumer (the player bike) can drive the gameplay-signal rim
 *  per frame. Symbol so it never collides with glTF/userData string keys. */
const VINYL_RIM_HANDLE = Symbol.for('hoverbike.painterlyVinyl.rimHandle')

/** Read the additive-rim handle off a vinyl material (or null if it isn't a vinyl
 *  twin / predates the handle). The per-object signal driver uses this to paint a
 *  rim signal into `.uStrength`/`.uColor` — see signal-state.ts. On a per-instance
 *  (`rimColorAttribute`) material the handle's uniforms are inert (the rim reads
 *  attributes), so this only does anything for single-mesh materials. */
export function vinylRimHandle(m: THREE.Material | null | undefined): IllustrativeRim | null {
  if (!m) return null
  const h = (m.userData as Record<string | symbol, unknown> | undefined)?.[VINYL_RIM_HANDLE]
  return (h as IllustrativeRim | undefined) ?? null
}

/** Per-object userData keys a size-shared (`sizePerObject`) vinyl material
 *  reads at render time — three `userData()` reference nodes, whose value is
 *  re-read from the rendered mesh's `userData` and uploaded into that render
 *  object's own uniform buffer each frame. Stamped by `stampVinylObjectSize`. */
const UD_BRUSH_FREQ = 'vinylBrushFreq'
const UD_BRUSH_WEIGHTS = 'vinylBrushWeights'
const UD_BAND_SCALE = 'vinylBandScale'
const UD_OBJECT_SCALE = 'vinylObjectScale'
/** Per-object base-tint (linear vec3) read at render time when a material is
 *  built with `tintUserData`. Lets ONE shared vinyl material serve a whole
 *  field of NON-instanced meshes (skinned rider clones) each with its own
 *  livery — the tint lives in each rendered mesh's `userData`, so the node
 *  graph (and thus the pipeline) is identical across meshes. The value shape is
 *  a plain `{x,y,z}` (three's vec3 uniform upload reads `.x/.y/.z`). Exported so
 *  a caller can pass it as `tintUserData` AND stamp the same key via
 *  `stampVinylTint` without duplicating the literal. */
export const UD_TINT = 'vinylTint'
/** Raw characteristic size record so a Brush-tuner re-dial can re-derive the
 *  frequency/weights without re-measuring the mesh. */
const UD_PROP_SIZE = 'vinylPropSize'
/** Material-userData marker: this vinyl twin reads per-object sizes, so every
 *  mesh wearing it must carry the stamps above. String (not a symbol) because
 *  `Material.copy` JSON-roundtrips userData and the marker must survive. */
const SIZE_PER_OBJECT_MARK = 'vinylSizePerObject'

/** Count of distinct vinyl materials actually built this session — each is a
 *  shader the pre-warm must compile. Read by the boot trace so the loading-time
 *  breakdown shows how many variants the look generated. */
let vinylBuilt = 0
export function vinylMaterialsBuilt(): number {
  return vinylBuilt
}

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
  /** Mix toward the rim tint at the silhouette (0..~0.6). This is the legacy soft
   *  rim mixed INTO albedo (so it gets lit + weakens in shadow). The TF2 additive
   *  rim below is a separate, shadow-surviving silhouette channel. */
  rimStrength?: number
  /** Warm rim tint (linear) — shared by BOTH the in-albedo rim above and the
   *  additive `rimEmissive` rim below (one tint, two compositing modes). */
  rimColor?: [number, number, number]
  /** TF2 ADDITIVE rim strength (emissive-like): pops the silhouette off sky/water
   *  and SURVIVES shadow (folded into emissive, added after lighting — never
   *  clobbers the per-instance exhaust glow). DEFAULT 0 so the look is unchanged
   *  until dialled. The rim colour is a live uniform (rimColor), set up as a
   *  gameplay-signal channel for a later slice. Live-dialable via the dev tuner. */
  rimEmissive?: number
  /** Illustrative-lighting cross-fade (the TF2 diffuse warp ramp): 0 = today's
   *  stock PBR diffuse EXACTLY, 1 = full Half-Lambert→warp-ramp response (cool
   *  shadow, warm terminator, slight overbright). Shadows / ambient / specular are
   *  preserved at every value (see illustrative-lighting.ts). DEFAULT 0.
   *  Live-dialable via the dev tuner. */
  illum?: number
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
  /** The brush stops treating a prop as "bigger" past this size in metres — the
   *  main lever against big-rock/cliff "straw". Default `BRUSH_PROP_SIZE_CAP` (6).
   *  Live-dialable via the dev Brush tuner. */
  brushPropSizeCap?: number
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
  /** Sample the brush strokes + procedural weathering in OBJECT space
   *  (`positionLocal`) instead of world space. World-space sampling locks the
   *  strokes to world coordinates, so they "swim" across a surface that MOVES
   *  through the world (a bike, a skinned rider). Object space paints the strokes
   *  onto the mesh so they ride along with it. Default false (world) — correct
   *  for static terrain / buildings / placed props. */
  brushObjectSpace?: boolean
  /** The mesh's world scale (metres per local unit), used only when
   *  `brushObjectSpace` is set: `positionLocal` is in un-scaled model units, so
   *  we multiply by this to keep the stroke SIZE matched to the world-space look.
   *  Default 1. */
  objectScale?: number
  /** Read the base albedo tint from a per-INSTANCE vertex attribute of this name
   *  (a vec3 linear colour) instead of the material's flat `color`. This is what
   *  lets ONE shared vinyl material serve a whole `InstancedMesh` field with
   *  per-bike livery — the caller stamps the attribute on each instanced geometry
   *  (see instanced-bikes.ts). Omit → flat `color` (the normal path). */
  tintAttribute?: string
  /** Read the base albedo tint from each rendered MESH's `userData[name]` (a
   *  linear `{x,y,z}` / vec3) instead of the material's flat `color`. The
   *  non-instanced sibling of `tintAttribute`: lets ONE shared vinyl material
   *  serve a field of skinned/plain mesh CLONES (the rider mannequins) each with
   *  its own livery, without a new pipeline per colour — the tint is a per-object
   *  reference read, so the node graph is identical across meshes (same shared
   *  `userData()` idiom as `sizePerObject`). Every mesh wearing the material MUST
   *  stamp this key (an unstamped mesh reads 0 → black). Takes precedence over
   *  the flat `color`; ignored if `tintAttribute` is also set. */
  tintUserData?: string
  /** With `tintAttribute` set, also drive emissive from that same per-instance
   *  colour — the bike's exhaust glow, whose accent hue must stay per-bike when
   *  the thruster sub-mesh is instanced. Omit → emissive stays the flat value. */
  emissiveFromTint?: boolean
  /** Drive emissive from a SEPARATE per-instance vec3 attribute of this name (the
   *  value IS the emissive colour — bake any intensity in CPU-side). Lets one
   *  shared material light only SOME instances, e.g. the "next" race gate glowing
   *  while every other gate stays dark. Takes precedence over `emissiveFromTint`. */
  emissiveAttribute?: string
  /** Drive the TF2 ADDITIVE rim's COLOUR from a per-instance vec3 attribute of
   *  this name (linear RGB) instead of the `rimColor` uniform — the per-instance
   *  signal channel for an `InstancedMesh` field (the style-as-legibility rim, see
   *  signal-state.ts). Pair with `rimStrengthAttribute`. Omit → the per-object
   *  `rimColor` uniform (the normal path). */
  rimColorAttribute?: string
  /** Drive the additive rim's STRENGTH from a per-instance float attribute of this
   *  name instead of the `rimEmissive` uniform. An unstamped / zeroed attribute
   *  reads 0 ⇒ rim off ⇒ byte-identical to today (this is what keeps the
   *  per-instance rim default-OFF). Pair with `rimColorAttribute`. */
  rimStrengthAttribute?: string
  /** Share ONE material instance across meshes of every size: read the
   *  size-derived inputs (brush stroke frequency + scale-blend weights, the
   *  waterline band scale, the object-space stroke scale) from each MESH's
   *  `userData` at render time instead of baking them into the node graph.
   *  three's WebGPU pipeline cache keys per material INSTANCE — converting
   *  the baked constants to material-scoped uniforms does NOT dedupe — so
   *  per-size twins each paid their own ~60–130 ms main-thread node-build +
   *  WGSL codegen in the scenery warm; sharing the instance is what collapses
   *  material count to source-material count. Every mesh wearing the material
   *  MUST be stamped via `stampVinylObjectSize` (an unstamped mesh reads
   *  undefined → NaN uniforms). `propSize`/`objectScale` only seed the tuner
   *  handle here, and `brushScaleMix` is unsupported in this mode. */
  sizePerObject?: boolean
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
  vinylBuilt++

  const rimStrength = opts.rimStrength ?? 0.5
  const rimColor = opts.rimColor ?? [1.0, 0.93, 0.82]
  const rimEmissive = opts.rimEmissive ?? 0
  const illum = opts.illum ?? VINYL_BRUSH_DEFAULTS.illum
  const weathering = opts.weathering ?? 0.12
  const brush = opts.brush ?? 0.7
  const brushScale = opts.brushScale ?? 0.12
  const brushPropSizeCap = opts.brushPropSizeCap ?? BRUSH_PROP_SIZE_CAP
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
  const brushPropSize = Math.min(propSize, brushPropSizeCap)
  const [wCoarse, wMed, wFine] = opts.brushScaleMix
    ? normalizeMix(opts.brushScaleMix)
    : brushScaleWeights(brushPropSize)
  const roughness = opts.roughness ?? 0.82
  const edgeWear = opts.edgeWear ?? 0.66
  const edgeWearColor = opts.edgeWearColor ?? [0.95, 0.92, 0.83]
  const brushObjectSpace = opts.brushObjectSpace ?? false
  const objectScale = opts.objectScale ?? 1
  const tintAttribute = opts.tintAttribute
  const tintUserData = opts.tintUserData
  const emissiveFromTint = opts.emissiveFromTint ?? false
  const emissiveAttribute = opts.emissiveAttribute
  const rimColorAttribute = opts.rimColorAttribute
  const rimStrengthAttribute = opts.rimStrengthAttribute
  const sizePerObject = opts.sizePerObject ?? false

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
  // baseTint is normally the material's flat colour. In instanced mode it reads a
  // per-instance vec3 attribute, so one shared material renders a field of bikes
  // each with its own livery (and, for the exhaust glow, its own emissive accent).
  // In per-object mode (`tintUserData`) it reads each rendered mesh's userData
  // instead — the non-instanced path for skinned rider clones sharing one
  // material (see rider-mannequin.ts); the graph stays identical across meshes so
  // the pipeline is shared.
  const baseTint = tintAttribute
    ? (attribute(tintAttribute, 'vec3') as Node<'vec3'>)
    : tintUserData
      ? (nodeObject(userData(tintUserData, 'vec3')) as unknown as Node<'vec3'>)
      : vec3(next.color.r, next.color.g, next.color.b)
  const mapRgb = std.map ? texture(std.map as THREE.Texture).rgb : vec3(1, 1, 1)
  const albedo = mapRgb.mul(baseTint)

  // AO from COLOR_0.g (identity at the neutral 1.0 the conditioner stamps).
  const vc = attribute('color') as Node<'vec4'>
  const ao = clamp(vc.g, float(0), float(1))
  const withAO = albedo.mul(mix(float(0.55), float(1.0), ao))

  // Brush + weathering sample basis. World space by default — strokes flow
  // continuously across the scene and stay put on static surfaces. Object space
  // (positionLocal × objectScale, normalLocal) for movers: the strokes are
  // painted onto the mesh's own frame so they ride along with a bike / skinned
  // rider instead of swimming through a world-locked field as it travels.
  // (`nodeObject` wraps the raw userData reference nodes in the TSL proxy —
  // swizzles/chaining live on the proxy, not the node class.)
  const brushPos = brushObjectSpace
    ? positionLocal.mul(
        sizePerObject
          ? (nodeObject(userData(UD_OBJECT_SCALE, 'float')) as unknown as Node<'float'>)
          : float(objectScale),
      )
    : positionWorld
  const brushNrm = brushObjectSpace ? normalLocal : normalWorld

  // Procedural weathering wash — subtle value-noise mottling so a flat-tint prop
  // reads as painted, not plastic. weathering 0 -> washFac 1.
  const wn = valueNoiseOctave2D(brushPos.xz.mul(float(1 / 3)))
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
  // brush strength + stroke frequency + R/G/B scale-weights drive the live dev
  // Brush tuner (no recompile) — see brush-tuning-service.ts. Strength is always
  // a material uniform. Frequency + weights are SIZE-derived, so they live in
  // one of two places: baked mode (default) keeps them as material uniforms —
  // this material serves one size — while sizePerObject mode reads them from
  // each mesh's userData (stampVinylObjectSize), letting one instance serve
  // every size. The textured freq folds BRUSH_TEX_TILE back in (matching the
  // old baked frequency exactly at the defaults); the procedural fallback uses
  // the raw worldScale. The weights are unused on the procedural path
  // (harmless — not wired into that graph).
  // ── Illustrative lighting (TF2 warp) + additive rim ──────────────────────────
  // Both default OFF (illum 0, rimEmissive 0) so an unmodified material is
  // byte-identical to today. The warp reshapes only the DIFFUSE light response
  // (shadows/ambient/specular preserved — see illustrative-lighting.ts); the rim
  // is additive (emissive-like) so it survives shadow and pops the silhouette.
  const uIllum = uniform(illum)
  // Swap the material's lighting model for the warp-ramp one via an instance-level
  // override of setupLightingModel (the supported hook MeshToonNodeMaterial uses).
  // At illum 0 the model cross-fades to the exact stock PhysicalLightingModel
  // diffuse, so the WGSL differs but the shaded result matches the stock path.
  const illumModel = new IllustrativeLightingModel(
    uIllum as unknown as Node<'float'>,
    sharedWarpRampTexture(),
  )
  ;(next as unknown as { setupLightingModel: () => IllustrativeLightingModel }).setupLightingModel =
    () => illumModel
  // Additive rim — its own term. Default path: a per-OBJECT colour uniform (the
  // Track-B gameplay-signal channel) + a strength uniform defaulting to 0. When
  // the caller passes per-instance attribute names (instanced bike fields), the
  // rim instead reads the signal colour + strength PER INSTANCE, so one shared
  // material paints a different drift/charge rim on each bike. Either way it's
  // additive-into-emissive and 0-strength by default = byte-identical to today.
  const illumRim = buildIllustrativeRim({
    rimColor,
    rimEmissive,
    ...(rimColorAttribute ? { colorAttribute: rimColorAttribute } : {}),
    ...(rimStrengthAttribute ? { strengthAttribute: rimStrengthAttribute } : {}),
  })

  // Apply the live-tunable illustrative dials shared by both brush-handle
  // branches (the dev tuner re-dials these with no recompile — uniform writes).
  const applyIllumRim = (v: VinylBrushValues): void => {
    uIllum.value = v.illum
    illumRim.uStrength.value = v.rimEmissive
    illumRim.uColor.value.setRGB(v.rimColorR, v.rimColorG, v.rimColorB)
  }
  const illumRimInitial = {
    illum,
    rimEmissive,
    rimColorR: rimColor[0],
    rimColorG: rimColor[1],
    rimColorB: rimColor[2],
  }

  const uBrush = uniform(brush)
  let streakFreq: Node<'float'>
  let streakWeights: Node<'vec3'>
  let brushHandle: VinylBrushHandle
  if (sizePerObject) {
    streakFreq = nodeObject(userData(UD_BRUSH_FREQ, 'float')) as unknown as Node<'float'>
    streakWeights = nodeObject(userData(UD_BRUSH_WEIGHTS, 'vec3')) as unknown as Node<'vec3'>
    // Freq/weights live per MESH here — the scene pass registers its own
    // handle that re-stamps every mesh (it knows each mesh's size); this
    // material-level handle owns only the strength uniform.
    brushHandle = {
      initial: { brush, brushScale, brushPropSizeCap, ...illumRimInitial },
      set(v) {
        uBrush.value = v.brush
        applyIllumRim(v)
      },
    }
  } else {
    const uBrushFreq = uniform(brushTextured ? brushWorldScale * BRUSH_TEX_TILE : brushWorldScale)
    const uBrushWeights = uniform(new THREE.Vector3(wCoarse, wMed, wFine))
    streakFreq = uBrushFreq
    streakWeights = uBrushWeights
    // Live-tuner handle — recompute freq + weights from (brushScale, cap, propSize).
    brushHandle = {
      initial: { brush, brushScale, brushPropSizeCap, ...illumRimInitial },
      set(v) {
        uBrush.value = v.brush
        const bp = Math.min(propSize, v.brushPropSizeCap)
        const bws = 1 / Math.max(v.brushScale * bp, 0.02)
        uBrushFreq.value = brushTextured ? bws * BRUSH_TEX_TILE : bws
        // brushScaleMix pins the weights explicitly — leave them; else size-derive.
        if (brushTextured && !opts.brushScaleMix) {
          const w = brushScaleWeights(bp)
          uBrushWeights.value.set(w[0], w[1], w[2])
        }
        applyIllumRim(v)
      },
    }
  }
  let streak: Node<'float'>
  if (brushTextured) {
    // Object-space positions (swim fix) feeding the tunable freq/weights.
    streak = brushHeightTriplanar(brushPos, brushNrm, streakFreq, streakWeights)
  } else {
    const bn = normalize(brushNrm)
    const an = vec3(abs(bn.x), abs(bn.y), abs(bn.z))
    const wsum = an.x.add(an.y).add(an.z).add(float(1e-4))
    const sampleStreak = (p: Node<'vec2'>) => dirStreak(p, streakFreq)
    streak = sampleStreak(vec2(brushPos.z, brushPos.y))
      .mul(an.x)
      .add(sampleStreak(vec2(brushPos.x, brushPos.z)).mul(an.y))
      .add(sampleStreak(vec2(brushPos.x, brushPos.y)).mul(an.z))
      .div(wsum)
  }
  const brushFac = float(1).add(streak.sub(float(0.5)).mul(uBrush.mul(float(3.0))))

  next.userData.vinylBrushHandle = brushHandle
  // Expose the additive-rim handle so a per-OBJECT consumer (the player's
  // per-clone bike) can paint a gameplay signal into the rim per frame: read
  // `material.userData.illumRimHandle` and set `.uStrength.value` / `.uColor.value`
  // from `getBikeSignal(eid)` (signal-state.ts). On the per-INSTANCE path
  // (`rimColorAttribute`/`rimStrengthAttribute`) these uniforms are inert stubs —
  // the rim is driven by the instanced attributes instead — so this handle is only
  // meaningful for the per-object (single-mesh) materials. Default-off either way
  // (strength 0). A runtime handle on this freshly-built material (symbol-keyed,
  // not serialized); the cast mirrors the vinylRimHandle reader above.
  const rimUd = next.userData as Record<string | symbol, unknown>
  rimUd[VINYL_RIM_HANDLE] = illumRim

  // World-space waterline trio FIRST, on the UN-brushed wash (opt-in; strength
  // 0 = no-op). The band height shrinks on small props (kept full on big ones)
  // so a fixed-metre salt band doesn't swallow a 1 m chest. Per-object mode
  // reads the pre-clamped scale from mesh userData (stampVinylObjectSize does
  // the min(size/6, 1) CPU-side).
  const bandScale = sizePerObject
    ? (nodeObject(userData(UD_BAND_SCALE, 'float')) as unknown as Node<'float'>)
    : Math.min(propSize / WATERLINE_FULL_BAND_SIZE, 1)
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

  // Per-instance emissive (exhaust glow): emissiveNode replaces emissive directly
  // (three does NOT fold in emissiveIntensity once a node is set — three.webgpu
  // line ~21754), so bake the copied intensity into the node to match the flat
  // path's `emissive × emissiveIntensity`. The TF2 additive rim ADDS into this
  // same channel (emissive is summed into the outgoing light after lighting, so
  // the rim survives shadow) — it must COMPOSE WITH the exhaust glow, never
  // replace it. At rimEmissive 0 the rim term is vec3(0), a true no-op.
  //
  // For the non-instanced path we add onto `materialEmissive` (the stock accessor
  // = emissive × emissiveIntensity × emissiveMap), NOT a hand-rebuilt node, so a
  // prop with a flat emissive or an emissiveMap keeps its exact stock value and
  // only the (zero-by-default) rim rides on top. Setting emissiveNode here is safe
  // for the rim-off case: stock already adds `materialEmissive` (black by default)
  // to the outgoing light, so `materialEmissive + vec3(0)` is byte-identical.
  let emissiveBase: Node<'vec3'>
  if (emissiveAttribute) {
    // The attribute value is the emissive colour directly (intensity baked in).
    emissiveBase = attribute(emissiveAttribute, 'vec3') as Node<'vec3'>
  } else if (tintAttribute && emissiveFromTint) {
    const emi = next.emissiveIntensity ?? 1
    emissiveBase = (attribute(tintAttribute, 'vec3') as Node<'vec3'>).mul(float(emi))
  } else {
    // Flat / default emissive (incl. any emissiveMap) via the stock accessor.
    emissiveBase = materialEmissive as unknown as Node<'vec3'>
  }
  // emissiveNode = exhaust/flat emissive + additive rim (rim is vec3(0) until
  // dialled, so this stays a no-op against the stock emissive contribution).
  next.emissiveNode = emissiveBase.add(illumRim.node)

  // Brush RELIEF — the impasto read. Stroke height modulates roughness (matte
  // sheen breaks up along strokes) and perturbs the shading normal (light
  // catches the ridges). Both scale with `brush`, so brush 0 leaves the matte
  // surface untouched.
  next.roughnessNode = clamp(
    float(roughness).add(streak.sub(float(0.5)).mul(uBrush.mul(float(1.2)))),
    float(0.4),
    float(1.0),
  )
  next.normalNode = bumpMap(streak, uBrush.mul(float(2.5)))

  marked2(next).userData[VINYL_MARKED] = true
  if (sizePerObject) next.userData[SIZE_PER_OBJECT_MARK] = true
  next.needsUpdate = true
  return next
}

/** True when `m` is a size-shared vinyl twin (`sizePerObject`) — every mesh
 *  wearing one must carry the per-object stamps (see stampVinylObjectSize). */
export function isSizePerObjectVinyl(m: THREE.Material | null | undefined): boolean {
  if (!m) return false
  return (m.userData as Record<string, unknown> | undefined)?.[SIZE_PER_OBJECT_MARK] === true
}

export type VinylStampConfig = {
  /** Brush-streak size as a fraction of the (capped) prop size — mirrors
   *  `VinylOptions.brushScale` (default 0.12). */
  brushScale: number
  /** Metres past which the brush stops treating a prop as bigger — mirrors
   *  `VinylOptions.brushPropSizeCap` (default 6). */
  brushPropSizeCap: number
  /** Sheet-based brush, which folds BRUSH_TEX_TILE into the frequency —
   *  mirrors `VinylOptions.brushTextured` (default true). */
  brushTextured?: boolean
}

/**
 * Stamp the per-object inputs a `sizePerObject` vinyl material reads at render
 * time onto `obj.userData`: the brush stroke frequency + coarse/medium/fine
 * scale weights (identical formulas to the baked path — capped prop size into
 * `brushScaleWeights` and the BRUSH_TEX_TILE fold), the waterline band scale,
 * and the object-space stroke scale. Also records the raw propSize so a live
 * Brush-tuner re-dial can re-derive freq/weights without re-measuring.
 *
 * Values are JSON-safe on purpose — `Object3D.clone()` JSON-roundtrips
 * userData, so a cloned mesh keeps working stamps. The weights are a plain
 * `{x,y,z}` (not a Vector3): three's vec3 uniform upload only reads `.x/.y/.z`,
 * which both shapes satisfy.
 */
export function stampVinylObjectSize(
  obj: THREE.Object3D,
  propSize: number,
  objectScale: number,
  cfg: VinylStampConfig,
): void {
  const size = Math.max(propSize, 0.05)
  const bp = Math.min(size, cfg.brushPropSizeCap)
  const ws = 1 / Math.max(cfg.brushScale * bp, 0.02)
  const [wCoarse, wMed, wFine] = brushScaleWeights(bp)
  const ud = obj.userData as Record<string, unknown>
  ud[UD_PROP_SIZE] = size
  ud[UD_OBJECT_SCALE] = Math.max(objectScale, 0.01)
  ud[UD_BAND_SCALE] = Math.min(size / WATERLINE_FULL_BAND_SIZE, 1)
  ud[UD_BRUSH_FREQ] = (cfg.brushTextured ?? true) ? ws * BRUSH_TEX_TILE : ws
  ud[UD_BRUSH_WEIGHTS] = { x: wCoarse, y: wMed, z: wFine }
}

/** Stamp the per-object base tint a `tintUserData` vinyl material reads at
 *  render time. `tint` is LINEAR RGB in 0..1 (the shader multiplies it into the
 *  albedo, which is linear). Every mesh wearing such a material must be stamped
 *  or it reads 0 → black. Plain `{x,y,z}` so it JSON-roundtrips through
 *  `Object3D.clone()` and satisfies three's vec3 upload. */
export function stampVinylTint(
  obj: THREE.Object3D,
  tint: { r: number; g: number; b: number },
): void {
  ;(obj.userData as Record<string, unknown>)[UD_TINT] = { x: tint.r, y: tint.g, z: tint.b }
}

/** Re-derive a previously-stamped mesh's freq/weights for new tuner dials,
 *  keeping its recorded size. No-op-ish fallback (REF_PROP_SIZE) if the mesh
 *  was never stamped. */
function restampVinylObjectSize(obj: THREE.Object3D, cfg: VinylStampConfig): void {
  const ud = obj.userData as Record<string, unknown>
  const size = typeof ud[UD_PROP_SIZE] === 'number' ? (ud[UD_PROP_SIZE] as number) : REF_PROP_SIZE
  const oScale = typeof ud[UD_OBJECT_SCALE] === 'number' ? (ud[UD_OBJECT_SCALE] as number) : 1
  stampVinylObjectSize(obj, size, oScale, cfg)
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

/** glTF-extras key the GLB material-dedupe tool
 *  (tools/optimize-track-glb-materials.mjs) stamps on its canonical shared
 *  materials — in track GLBs (decoration/landmark families) and prop GLBs
 *  (multi-colour scatter props like mxc/trajinera) alike: the glTF name of
 *  the per-vertex linear-RGB base-tint attribute (`_VINYLTINT`) baked from
 *  each merged material's baseColorFactor. Whole same-look families then
 *  share ONE material — one pipeline compile in the scenery warm — while
 *  every building/prop part keeps its colour. GLTFLoader copies material
 *  extras onto `material.userData` and lowercases custom attribute names, so
 *  the marker value maps to the three-side geometry attribute via
 *  `.toLowerCase()` (`_vinyltint`). */
const VINYL_TINT_EXTRA = 'vinylTintAttribute'

/** The three-side attribute name a marked material's tint rides on, or null
 *  for the normal flat-colour path. Every vinyl-converting consumer (the
 *  track scene pass here, `createPropsMesh`'s instanced props, the prop
 *  viewer) must thread a non-null result into `buildVinylMaterial`'s
 *  `tintAttribute` — a tint-canonical material is WHITE, so the flat-colour
 *  path would render it white. */
export function vinylTintAttribute(m: THREE.Material | null | undefined): string | null {
  if (!m) return null
  const v = (m.userData as Record<string, unknown> | undefined)?.[VINYL_TINT_EXTRA]
  return typeof v === 'string' && v.length > 0 ? v.toLowerCase() : null
}

/** Stamp a neutral white tint on a geometry missing the marked attribute, so
 *  a mesh that reaches a tint-reading vinyl twin without baked data renders
 *  the material's (white) colour instead of black — an absent attribute reads
 *  0 under TSL. The dedupe tool guarantees the attribute on every primitive
 *  inside the source GLB; this guards meshes assembled outside it. (A clone of
 *  a converted mesh shares its geometry by reference, so clones keep working
 *  without re-detection.) */
export function ensureNeutralTintAttribute(geom: THREE.BufferGeometry, name: string): void {
  if (geom.getAttribute(name)) return
  const n = geom.getAttribute('position')?.count ?? 0
  if (!n) return
  geom.setAttribute(name, new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3))
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
  /** Override the brush stroke size (fraction of prop size; default 0.12). */
  brushScale?: number
  /** Override the brush prop-size cap in metres (default 6) — bigger = sparser
   *  strokes on large rocks/cliffs/buildings (the main anti-"straw" lever). */
  brushPropSizeCap?: number
  /** Edge-wear drybrush amount (default 0 = off for stock set-pieces, which
   *  carry no baked convexity). When > 0, real per-vertex convexity is baked
   *  into each mesh (`stampConvexityColor0`) so the wear lands on actual edges —
   *  use it on hero meshes that should pop (e.g. bikes). */
  edgeWear?: number
  /** Sample the brush + weathering in object space so they don't swim on a mesh
   *  that MOVES through the world (a bike, a skinned rider). Default false
   *  (world) — correct for static buildings / set-pieces. */
  brushObjectSpace?: boolean
  /** Read each mesh's base tint from `userData[name]` (linear vec3) instead of
   *  the source material's flat colour — see `VinylOptions.tintUserData`. Lets
   *  ONE converted material serve a field of clones (rider mannequins) each with
   *  its own livery. Callers MUST `stampVinylTint` every mesh that will wear the
   *  converted material. */
  tintUserData?: string
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
  const edgeWear = opts.edgeWear ?? 0
  const brushObjectSpace = opts.brushObjectSpace ?? false
  // ONE vinyl twin per source material: the size-derived inputs are per-OBJECT
  // userData reads (`sizePerObject`), so differently-sized meshes share the
  // same instance and the cache needs no size key. Material COUNT is the
  // shader pre-warm lever — three's WebGPU pipeline cache keys per material
  // INSTANCE, so every per-size twin paid its own ~60–130 ms main-thread
  // node-build + WGSL codegen during the progressive scenery warm (155
  // materials on Mexico City = frame dips ~10 s past the green light).
  const cache = new Map<THREE.Material, THREE.Material>()
  const stampCfg: VinylStampConfig = {
    brushScale: opts.brushScale ?? VINYL_BRUSH_DEFAULTS.brushScale,
    brushPropSizeCap: opts.brushPropSizeCap ?? VINYL_BRUSH_DEFAULTS.brushPropSizeCap,
  }
  /** Meshes carrying per-object stamps — the pass-level tuner handle re-stamps
   *  these on a brushScale/cap re-dial (each keeps its own recorded size). */
  const stamped: THREE.Object3D[] = []
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

    // Per-mesh characteristic size (its own geometry bbox × world scale, NOT the
    // subtree) drives the scale-relative brush + waterline band. Object-space
    // brush additionally needs the mesh's world scale to keep the stroke size
    // matched (positionLocal is in un-scaled model units).
    const measure = (): { propSize: number; objectScale: number } => {
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
      obj.matrixWorld.decompose(tmpPos, tmpQuat, scaleV)
      const objectScale = Math.max(Math.abs(scaleV.x), Math.abs(scaleV.y), Math.abs(scaleV.z), 0.01)
      return { propSize, objectScale }
    }
    const stamp = (): void => {
      const m = measure()
      stampVinylObjectSize(obj, m.propSize, m.objectScale, stampCfg)
      stamped.push(obj)
    }

    const allOwned = Array.isArray(mat) ? mat.every(ownedByAnotherPass) : ownedByAnotherPass(mat)
    if (allOwned) {
      // Nothing to convert — but a mesh can arrive already WEARING a size-shared
      // vinyl (a clone of a converted tree shares materials by reference). It
      // still needs its OWN per-object stamps: without them the material's
      // userData reads are undefined → NaN uniforms on this mesh.
      if ((Array.isArray(mat) ? mat : [mat]).some(isSizePerObjectVinyl)) {
        stamp()
        ensureNeutralVertexColor(obj.geometry as THREE.BufferGeometry)
      }
      return
    }

    // Edge wear needs real per-vertex convexity: bake it when requested,
    // otherwise stamp a neutral COLOR_0 so the AO/edge reads are safe no-ops
    // (a fully-absent attribute reads 0 on every channel under TSL). The bake is
    // idempotent + a no-op for a mesh that already carries COLOR_0.
    const geom = obj.geometry as THREE.BufferGeometry
    if (edgeWear > 0) stampConvexityColor0(geom)
    else ensureNeutralVertexColor(geom)
    // Deduped-material tint lane: a canonical material from the GLB dedupe
    // tool names its per-vertex tint attribute in userData (glTF extras).
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      const tintAttr = vinylTintAttribute(m)
      if (tintAttr) ensureNeutralTintAttribute(geom, tintAttr)
    }
    const convert = (m: THREE.Material): THREE.Material => {
      if (ownedByAnotherPass(m)) return m
      const hit = cache.get(m)
      if (hit) return hit
      const tintAttr = vinylTintAttribute(m)
      const v = buildVinylMaterial(m, {
        sizePerObject: true,
        waterLevel: opts.waterLevel ?? 0,
        waterline: opts.waterline ?? 0,
        ...(opts.brush !== undefined ? { brush: opts.brush } : {}),
        ...(opts.brushScale !== undefined ? { brushScale: opts.brushScale } : {}),
        ...(opts.brushPropSizeCap !== undefined ? { brushPropSizeCap: opts.brushPropSizeCap } : {}),
        ...(tintAttr ? { tintAttribute: tintAttr } : {}),
        ...(opts.tintUserData !== undefined ? { tintUserData: opts.tintUserData } : {}),
        edgeWear,
        brushObjectSpace,
      })
      const h = (v.userData as { vinylBrushHandle?: VinylBrushHandle }).vinylBrushHandle
      if (h) registerVinylBrush(h)
      cache.set(m, v)
      count++
      return v
    }
    obj.material = Array.isArray(mat) ? mat.map(convert) : convert(mat)
    const now = obj.material as THREE.Material | THREE.Material[]
    if ((Array.isArray(now) ? now : [now]).some(isSizePerObjectVinyl)) stamp()
  })

  // The per-material handles registered above only re-dial brush STRENGTH in
  // per-object mode — the size half (freq/weights) lives in mesh userData. One
  // pass-level handle re-stamps every mesh from its recorded size, so the dev
  // Brush tuner keeps working end-to-end. Registered after the material
  // handles, so the tuner's initial-value seeding stays material-first.
  if (stamped.length > 0) {
    registerVinylBrush({
      // This pass-level handle only re-stamps per-mesh size inputs; the
      // illustrative-lighting dials are owned by the per-material handles. Seed
      // its `initial` from the defaults for those fields so the type is complete
      // and seeding (if this ever registers first) stays the current look.
      initial: {
        ...VINYL_BRUSH_DEFAULTS,
        brush: opts.brush ?? VINYL_BRUSH_DEFAULTS.brush,
        brushScale: stampCfg.brushScale,
        brushPropSizeCap: stampCfg.brushPropSizeCap,
      },
      set(v) {
        const cfg: VinylStampConfig = {
          brushScale: v.brushScale,
          brushPropSizeCap: v.brushPropSizeCap,
        }
        for (const m of stamped) restampVinylObjectSize(m, cfg)
      },
    })
  }
  return count
}
