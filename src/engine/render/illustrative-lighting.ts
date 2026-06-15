/**
 * Illustrative (TF2-style) lighting for the shared painterly-vinyl material.
 *
 * The painterly look today lives entirely in *albedo* — brush impasto,
 * weathering, edge-wear and a soft rim are all composited into `colorNode` on a
 * stock `MeshStandardNodeMaterial`, then lit by default physically-based diffuse
 * (see painterly-vinyl-material.ts). This module adds the *lighting* half of the
 * look from "Illustrative Rendering in Team Fortress 2" (NPAR 2007): a
 * **diffuse warp ramp** (Half-Lambert → 1D ramp: cool shadow, neutral body, warm
 * terminator, slight overbright) and a true **additive rim** for silhouette
 * readability. Both are gated so the default is byte-identical to today's PBR
 * look — knob 0 = no change.
 *
 * ── Chosen mechanism: a custom LightingModel (NOT a post-lit tint) ───────────
 * three's node materials expose lighting through `Material.setupLightingModel()`,
 * which returns a `LightingModel` whose `direct()` is called *per light* and
 * whose `indirect()` handles ambient/IBL — exactly how `MeshToonNodeMaterial`
 * swaps in its `ToonLightingModel` while keeping the rest of the pipeline. We
 * subclass `PhysicalLightingModel` (the one `MeshStandardNodeMaterial` uses) and
 * override ONLY `direct()`:
 *
 *   - The TF2 warp replaces the diffuse *response curve* `clamp(N·L)` with a
 *     ramp lookup of Half-Lambert `N·L*0.5+0.5`. Crucially the per-light
 *     `lightColor` handed to `direct()` is ALREADY shadow-attenuated
 *     (`AnalyticLightNode.setupShadow` bakes the shadow into the light's color
 *     node: `colorNode.mul(shadowNode)`), so a warp diffuse built from
 *     `lightColor` is shadowed for free — shadows, ambient and IBL all survive.
 *   - We do not re-implement specular. The multiscatter specular BRDF
 *     (`BRDF_GGX_Multiscatter` + `specularColorBlended`) is internal to three and
 *     is NOT re-exported from `three/tsl`/`three/webgpu`; re-deriving it would
 *     drift from stock and break the "knob 0 == today" guarantee. Instead we
 *     delegate to `super.direct()` (which adds the stock diffuse AND the exact
 *     stock specular), capture the diffuse term it just added, and replace only
 *     that term with `mix(stockDiffuse, warpDiffuse, uIllum)`. At `uIllum = 0`
 *     the mix is the stock term and specular is untouched, so the frame is
 *     identical to the unmodified material.
 *
 * Why a LightingModel and not a cheap "tint the lit result by a warp colour":
 * the latter can't put the cool/warm shift *inside* the shadow term (it would
 * tint lit and shadowed pixels alike) and fights the shadow/ambient split. The
 * LightingModel hook is the supported, surgical place to reshape the diffuse
 * response while preserving everything else — the same tradeoff Valve made.
 *
 * The rim is deliberately NOT part of the lighting model: it must survive shadow
 * and pop the silhouette regardless of light direction, so the material folds it
 * into `emissiveNode` (added to the outgoing light AFTER lighting — see
 * NodeMaterial.setupLighting). This module just builds the rim term + owns its
 * uniforms; the material composes it additively with the existing exhaust glow.
 *
 * Built on the project's existing idioms: the 1D `DataTexture` ramp mirrors
 * `makeRampTexture` in terrain-shader.ts, and the fresnel rim mirrors clouds.ts.
 * WebGPU/TSL only — never `ShaderMaterial`.
 */
import * as THREE from 'three'
import type Node from 'three/src/nodes/core/Node.js'
import {
  attribute,
  BRDF_Lambert,
  cameraPosition,
  clamp,
  diffuseColor,
  dot,
  float,
  mix,
  normalize,
  normalView,
  normalWorld,
  positionWorld,
  pow,
  saturate,
  texture,
  uniform,
  vec2,
} from 'three/tsl'
import { PhysicalLightingModel } from 'three/webgpu'

// ── Warp ramp ────────────────────────────────────────────────────────────────

/** One stop in the diffuse warp ramp, authored in sRGB display values (matching
 *  terrain-shader's ColorStop convention). `pos` runs 0 (deep shadow) → 1 (fully
 *  lit), indexed by Half-Lambert. */
type WarpStop = { pos: number; color: [number, number, number] }

/**
 * The default TF2 diffuse warp SHAPE, authored in [0,1] so the ramp can live in a
 * plain 8-bit texture (universally LINEAR-filterable on WebGPU — a 32-bit-float
 * texture would need the optional `float32-filterable` feature to filter). The
 * "slight overbright" the look wants is applied as a flat post-lookup multiply
 * (`WARP_OVERBRIGHT`) rather than baked as >1 stops — this is exactly how the TF2
 * paper does it (store the ramp, apply a `×N` after the lookup), and it keeps the
 * texture in the always-filterable byte format.
 *
 * The curve: cool-blue shadow that never reaches black, a cool-neutral body, a
 * warm/reddish saturation spike at the terminator, rolling up to a bright (but
 * sub-1) lit end so `×WARP_OVERBRIGHT` lands it a touch over 1. Tuned to read as
 * a *subtle* re-light at low `illum` and the full illustrative shift at 1; the
 * owner signs the curve off by eye (playtest-is-truth), and it's shared/cheap to
 * regenerate if the stops change.
 */
const DEFAULT_WARP_STOPS: WarpStop[] = [
  { pos: 0.0, color: [0.3, 0.37, 0.52] }, // deep shadow — cool blue, lifted off black
  { pos: 0.35, color: [0.52, 0.54, 0.6] }, // shadow→body transition, cool-neutral
  { pos: 0.5, color: [0.75, 0.72, 0.7] }, // terminator — neutral, faintly warm
  { pos: 0.62, color: [0.88, 0.82, 0.75] }, // warm/reddish saturation spike at the break
  { pos: 0.8, color: [0.92, 0.9, 0.86] }, // lit body
  { pos: 1.0, color: [0.95, 0.93, 0.9] }, // fully lit (×WARP_OVERBRIGHT → slight overbright)
]

/** Flat post-lookup gain applied to the ramp sample (the TF2 `×N`). Keeps the lit
 *  end a hair over 1 for controllable overbright while leaving the byte texture
 *  itself in [0,1]. Small so a track doesn't blow out under bloom. */
const WARP_OVERBRIGHT = 1.15

function evalWarp(stops: WarpStop[], t: number): [number, number, number] {
  if (t <= stops[0]!.pos) return stops[0]!.color
  if (t >= stops[stops.length - 1]!.pos) return stops[stops.length - 1]!.color
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!
    const b = stops[i + 1]!
    if (t >= a.pos && t <= b.pos) {
      const span = b.pos - a.pos
      const local = span > 0 ? (t - a.pos) / span : 0
      // Smoothstep interpolation to match the soft Blender ColorRamp feel used
      // by the terrain ramps.
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

/**
 * Build the 1D diffuse warp ramp as an 8-bit `DataTexture`, exactly like
 * `makeRampTexture` in terrain-shader.ts (256 px, RGBA8, LINEAR, clamped) — the
 * always-filterable format on WebGPU. The stops are the LINEAR light-response
 * curve (no sRGB decode: `NoColorSpace`), since this drives a light *response*,
 * not a surface albedo. The slight overbright is applied at sample time via
 * `WARP_OVERBRIGHT`, so the texture itself stays in [0,1].
 */
function makeWarpRampTexture(stops: WarpStop[] = DEFAULT_WARP_STOPS): THREE.DataTexture {
  const N = 256
  const data = new Uint8Array(N * 4)
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1)
    const [r, g, b] = evalWarp(stops, t)
    data[i * 4 + 0] = Math.round(THREE.MathUtils.clamp(r, 0, 1) * 255)
    data[i * 4 + 1] = Math.round(THREE.MathUtils.clamp(g, 0, 1) * 255)
    data[i * 4 + 2] = Math.round(THREE.MathUtils.clamp(b, 0, 1) * 255)
    data[i * 4 + 3] = 255
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  // Linear-light response curve — NOT an sRGB-authored colour, so no decode.
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

let sharedWarpRamp: THREE.DataTexture | null = null

/** The session-shared default warp ramp (built once, reused across every vinyl
 *  material — exactly like terrain's shared ramps). */
export function sharedWarpRampTexture(): THREE.DataTexture {
  if (!sharedWarpRamp) sharedWarpRamp = makeWarpRampTexture()
  return sharedWarpRamp
}

// ── Lighting model ─────────────────────────────────────────────────────────────

/**
 * Physical lighting with the diffuse term reshaped through a TF2 warp ramp,
 * cross-faded from the stock PBR response by `uIllum` (0 = stock, 1 = full
 * illustrative). Specular, ambient, IBL and shadows are inherited from
 * `PhysicalLightingModel` untouched — see the file header for why the diffuse is
 * swapped via a captured-delta rather than a from-scratch `direct()`.
 */
export class IllustrativeLightingModel extends PhysicalLightingModel {
  private readonly uIllum: Node<'float'>
  private readonly rampTex: THREE.Texture

  /**
   * @param uIllum 0..1 cross-fade between stock PBR diffuse (0) and the warp ramp
   *   (1). MUST default 0 at the call site so the unmodified material is
   *   byte-identical.
   * @param rampTex the 1D warp ramp (see {@link sharedWarpRampTexture}).
   */
  constructor(uIllum: Node<'float'>, rampTex: THREE.Texture) {
    // All PBR feature flags stay at their defaults (no clearcoat/sheen/etc.) so
    // `super.direct()` is the plain diffuse+specular path the vinyl material uses.
    super()
    this.uIllum = uIllum
    this.rampTex = rampTex
  }

  /**
   * Per-light direct term. `lightDirection` is the view-space unit vector toward
   * the light and `lightColor` is the light's colour ALREADY multiplied by its
   * shadow factor (AnalyticLightNode.setupShadow), so anything we scale by
   * `lightColor` is shadowed automatically. (Typed loosely because three's
   * `three/webgpu` entry ships no TS types — the runtime shapes are what matter;
   * see the project's "live type def, not the doc schema" rule.)
   *
   * `direct()` is invoked once per direct light, INSIDE the lighting stack
   * `LightsNode.setup` opens (`builder.addStack()` before `lightingModel.start`),
   * so the `.toVar()`/`.assign()` below are legal here — exactly like the stock
   * model's own `.toVar()`/`.addAssign()`. `directDiffuse` accumulates across
   * lights; we only ever replace THIS light's own delta, so prior lights (held in
   * `diffuseBefore`) and the later indirect/ambient term are untouched. (Calling
   * this outside a builder stack — e.g. a bare unit harness — warns "No stack
   * defined"; that's the harness, not a bug.)
   */
  override direct(
    input: Parameters<PhysicalLightingModel['direct']>[0],
    builder: Parameters<PhysicalLightingModel['direct']>[1],
  ): void {
    // three DOES ship types for the lighting model, so match the base signature
    // exactly via Parameters<> (override-compatible, no type-name hunting), then
    // cast to the node shapes the body needs — the codebase's TSL-typing idiom
    // (`as unknown as Node<...>`). The real input also carries lightNode/
    // directSpecular, which we hand to super.direct() whole.
    const { lightDirection, lightColor, reflectedLight } = input as unknown as {
      lightDirection: Node<'vec3'>
      lightColor: Node<'vec3'>
      reflectedLight: { directDiffuse: Node<'vec3'> }
    }
    const directDiffuse = reflectedLight.directDiffuse

    // Snapshot the diffuse accumulator, then let the stock model add its exact
    // diffuse + specular. Capturing before/after lets us replace ONLY the diffuse
    // term while leaving the (un-exportable) multiscatter specular pristine.
    const diffuseBefore = directDiffuse.toVar()
    super.direct(input, builder)
    // The exact diffuse term the stock model just contributed (realized into its
    // own var so the read-then-reassign of directDiffuse below is unambiguous).
    const stockDiffuse = directDiffuse.sub(diffuseBefore).toVar()

    // TF2 warp diffuse: Half-Lambert → ramp lookup, scaled by the (shadowed)
    // light colour and the same Lambert albedo the stock term uses. `diffuseColor`
    // here is the material's painterly albedo (NodeMaterial.setupDiffuseColor has
    // already assigned colorNode into it). The vinyl material is always
    // metalness 0, so `diffuseColor.rgb` equals the stock path's
    // `diffuseContribution` (= diffuseColor.rgb * (1 - metalness)).
    const halfLambert = clamp(
      normalView.dot(lightDirection).mul(float(0.5)).add(float(0.5)),
      float(0),
      float(1),
    )
    // Sample the [0,1] ramp, then apply the flat overbright (the TF2 `×N`).
    const rampResp = texture(this.rampTex, vec2(halfLambert, float(0.5))).rgb.mul(
      float(WARP_OVERBRIGHT),
    )
    const warpIrradiance = rampResp.mul(lightColor)
    const warpDiffuse = warpIrradiance.mul(
      BRDF_Lambert({ diffuseColor: diffuseColor.rgb }) as never,
    )

    // Cross-fade stock ↔ warp by illum; at illum 0 this is exactly the stock
    // term, so the whole frame matches the unmodified material.
    directDiffuse.assign(diffuseBefore.add(mix(stockDiffuse, warpDiffuse, this.uIllum)))
  }
}

// ── Additive rim (silhouette / readability channel) ─────────────────────────────

export type IllustrativeRim = {
  /** The additive rim contribution (vec3) to fold into `emissiveNode`. At
   *  `rimEmissive = 0` (or a per-instance strength of 0) this is `vec3(0)` so it
   *  never moves the look until dialled. */
  node: Node<'vec3'>
  /** Live-settable rim tint (linear RGB). Becomes a gameplay-signal channel for a
   *  later slice (e.g. rival/hazard/pickup state painted into the lighting).
   *  In the PER-INSTANCE path (`colorAttribute`/`strengthAttribute` set) the rim
   *  reads instanced attributes instead, so this uniform is an unwired stub — the
   *  signal drives the rim per instance, not through this object-wide uniform. */
  uColor: { value: THREE.Color }
  /** Live-settable additive strength (0 = off). Unwired stub in the per-instance
   *  path (see `uColor`). */
  uStrength: { value: number }
}

export type IllustrativeRimOptions = {
  /** Rim tint, linear RGB. Default the warm tint the in-albedo rim already uses. */
  rimColor?: [number, number, number]
  /** Additive strength. DEFAULT 0 so the existing in-albedo rim is unchanged and
   *  nothing moves until dialled. */
  rimEmissive?: number
  /** Fresnel falloff exponent (TF2 uses ~4 — tighter, edge-hugging). Default 4. */
  power?: number
  /** Extra weight toward up-facing rims via `saturate(N·up)`, so silhouettes read
   *  against sky/water even away from the key light (TF2's upward-biased ambient
   *  rim). 0 = pure view-fresnel, 1 = fully up-biased. Default 0.35. */
  upBias?: number
  /** PER-INSTANCE rim colour: read the rim tint from a per-instance vec3 vertex
   *  attribute of this name instead of the `rimColor` uniform. This is what lets
   *  ONE shared material paint a DIFFERENT signal rim on each instance in an
   *  `InstancedMesh` field (mirrors painterly-vinyl's `tintAttribute` livery
   *  pattern — instanced-bikes.ts stamps the attribute per bike). Omit → the
   *  per-object `uColor` uniform (the normal path). */
  colorAttribute?: string
  /** PER-INSTANCE rim strength: read the additive strength from a per-instance
   *  float vertex attribute of this name instead of the `rimEmissive` uniform.
   *  An unstamped / zeroed attribute reads 0 ⇒ rim off ⇒ byte-identical to today,
   *  which is what keeps the per-instance path default-OFF. Usually paired with
   *  `colorAttribute`. Omit → the per-object `uStrength` uniform. */
  strengthAttribute?: string
}

/**
 * Build the additive rim term + its live uniforms. Pure view-dependent fresnel
 * (clouds.ts idiom) raised to `power`, optionally weighted toward up-facing
 * surfaces, tinted + scaled by EITHER per-object uniforms (`uColor`/`uStrength`,
 * the default) OR per-instance vertex attributes (`colorAttribute`/
 * `strengthAttribute`) so one shared instanced material can paint a distinct
 * gameplay signal per instance. Returned as a node to ADD into the material's
 * emissive (so it survives shadow and pops the silhouette) — the caller composes
 * it with any existing per-instance exhaust emissive rather than replacing it.
 *
 * Default-OFF in BOTH paths: the uniform path defaults `rimEmissive` to 0, and
 * the attribute path reads 0 from an unstamped/zeroed strength attribute — either
 * way the rim term is `vec3(0)`, byte-identical to today, until something dials a
 * strength > 0.
 */
export function buildIllustrativeRim(opts: IllustrativeRimOptions = {}): IllustrativeRim {
  const rimColor = opts.rimColor ?? [1.0, 0.93, 0.82]
  const rimEmissive = opts.rimEmissive ?? 0
  const power = opts.power ?? 4
  const upBias = opts.upBias ?? 0.35

  // Keep the uniforms around regardless (the return type promises them); they're
  // only WIRED into the graph on the per-object path. On the per-instance path
  // they're inert stubs so a caller that holds the handle never NaNs.
  const uColor = uniform(new THREE.Color(rimColor[0], rimColor[1], rimColor[2]))
  const uStrength = uniform(rimEmissive)

  // Source the tint + strength from per-instance attributes when asked, else the
  // per-object uniforms. The attribute path is the InstancedMesh signal channel;
  // an absent/zeroed strength attribute reads 0 → rim off (default == today).
  const colorTerm: Node<'vec3'> = opts.colorAttribute
    ? (attribute(opts.colorAttribute, 'vec3') as Node<'vec3'>)
    : (uColor as unknown as Node<'vec3'>)
  const strengthTerm: Node<'float'> = opts.strengthAttribute
    ? (attribute(opts.strengthAttribute, 'float') as Node<'float'>)
    : (uStrength as unknown as Node<'float'>)

  const nrm = normalize(normalWorld)
  const view = normalize(cameraPosition.sub(positionWorld))
  const ndv = clamp(dot(nrm, view), float(0), float(1))
  const fresnel = pow(clamp(float(1).sub(ndv), float(0), float(1)), float(power))
  // Upward bias: lift the rim where the surface faces the sky so top silhouettes
  // separate from the background even with no rim light there. `mix(1, up, upBias)`
  // leaves the pure fresnel intact at upBias 0.
  const up = saturate(nrm.y)
  const biased = fresnel.mul(mix(float(1), up, float(upBias)))

  const node = colorTerm.mul(biased).mul(strengthTerm) as Node<'vec3'>

  return {
    node,
    uColor: uColor as unknown as { value: THREE.Color },
    uStrength: uStrength as unknown as { value: number },
  }
}
