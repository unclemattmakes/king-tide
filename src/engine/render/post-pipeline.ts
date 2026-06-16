import type * as THREE from 'three'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js'
import { sobel } from 'three/addons/tsl/display/SobelOperatorNode.js'
import {
  float,
  mix,
  mrt,
  output,
  pass,
  saturation,
  smoothstep,
  uniform,
  vec3,
  vec4,
  velocity,
} from 'three/tsl'
import { RenderPipeline } from 'three/webgpu'

/**
 * Loose alias for the chainable TSL node proxies. The precise generic
 * `Node<'vec4'>` types from `three/tsl` don't compose cleanly across the
 * addon display nodes (sobel / bloom / motionBlur) whose return types are
 * widened, so the rest of this file uses `as never` casts at the call
 * boundaries — the same style the original bloom wiring used.
 */
type TslNode = {
  add: (n: unknown) => TslNode
  sub: (n: unknown) => TslNode
  mul: (n: unknown) => TslNode
}

/**
 * WebGPU post-processing pipeline. Owns a `RenderPipeline` that
 * intercepts the scene render with a `pass(scene, camera)` +
 * `bloom(scenePass, ...)` chain.
 *
 * Render systems can register an active pipeline with
 * `setActivePostPipeline()` in `renderer-service.ts`; render call sites
 * use `renderFrame(scene, camera)` from that same module to route through
 * the pipeline when the (scene, camera) match.
 *
 * The bloom uniforms (strength / radius / threshold) are CPU-mutable via
 * `setBloom()` so the sky system can push per-track `sky.bloom` values
 * without rebuilding the pipeline.
 *
 * Two further effects — a full-scene cel/ink outline and a velocity-buffer
 * motion blur — are available but DEFAULT-OFF, and are GRAPH-gated: when both
 * are disabled the beauty composite is byte-for-byte today's
 * `scenePassColor.add(bloom)` with no extra nodes and no velocity MRT, so the
 * shipping bloom-only look is unchanged unless a track opts in. (The colour
 * grade below differs: its nodes are always present but identity-valued — see
 * next paragraph.)
 *
 * A scene-wide colour GRADE is the final stage of the chain — the vehicle for
 * the "hold the world in a muted band so gameplay events pop" contrast budget
 * (docs/painterly-legibility-plan.md Part 3B / Part 5 A2). Like bloom, the
 * grade nodes are ALWAYS present and CPU-mutable via `setGrade()` with no
 * pipeline rebuild. Their uniforms default to an exact algebraic IDENTITY
 * (exposure 1, temperature 0, saturation 1, contrast 1), so until a setter is
 * called the graded output equals the ungraded composite term-for-term — the
 * shipping look is unchanged. The grade sits in scene-referred LINEAR space,
 * *before* the `RenderPipeline`'s tone-map + sRGB encode (which it applies to
 * `outputNode` downstream when `outputColorTransform` is true — the default we
 * keep): exposure + white-balance are the photographically correct "camera"
 * stage ahead of the filmic curve, and bloom — which is also pre-tonemap —
 * is graded along with the beauty image so halos sit in the same muted band.
 */

export type PostPipeline = {
  /** Scene + camera the pipeline's PassNode was built around. */
  readonly scene: THREE.Scene
  readonly camera: THREE.Camera
  /** Run the post chain. Replaces `renderer.render(scene, camera)`. */
  render(): void
  /**
   * Pre-warm the scene's GPU pipelines against the PassNode's render
   * target (HalfFloatType, no MSAA) — the format the scene is actually
   * sampled at when going through the post chain. Must be called *instead
   * of* (or after) `renderer.compileAsync(scene, camera)`, which compiles
   * for the canvas RT and leaves no usable pipelines for the PassNode RT.
   * The mismatch silently renders an empty (black) framebuffer with no
   * validation error.
   */
  compileAsync(): Promise<void>
  /**
   * Asynchronously pre-warm one subtree's GPU pipelines under the *same*
   * cache key the live `render()` uses — `renderer.compileAsync(object,
   * camera, scene)` bracketed by the PassNode's renderTarget + MRT (the
   * exact renderer state `PassNode.updateBefore` sets for the scene pass).
   * Pipeline creation goes through `createRenderPipelineAsync` with
   * main-thread yields between objects, so — unlike a first-sight compile
   * in the rAF loop — it never stalls a frame. Used by the progressive
   * scenery warm to compile each deferred mesh *before* revealing it.
   *
   * Only valid after `compileAsync()` (or the first `render()`) has run:
   * the PassNode's RT samples/type are populated in its first
   * `updateBefore`, and compiling against an unconfigured RT caches under
   * a stale key (the silent black-framebuffer failure described above).
   *
   * Note `object.visible` (and `frustumCulled`, against the renderer's
   * stale compile-time frustum) gate the synchronous project step inside
   * `renderer.compileAsync` — callers warming a hidden mesh must flip
   * those flags for the duration of this call (the synchronous prologue
   * captures the render list; the flags can be restored as soon as the
   * call returns, before awaiting).
   */
  compileSubtreeAsync(object: THREE.Object3D): Promise<void>
  /**
   * Live-set bloom parameters. `strength = 0` short-circuits to a passthrough
   * (no bloom contribution) — cheaper than tearing the pipeline down for
   * tracks that authored `sky.bloom: 0`.
   */
  setBloom(strength: number, radius?: number, threshold?: number): void
  /**
   * Live-set the cel/ink outline look. No-op when the pipeline was built
   * with the outline effect disabled (the outline nodes don't exist in the
   * graph in that case — toggling it on requires a rebuild). `strength = 0`
   * mutes the ink contribution.
   */
  setOutline(strength: number, color?: THREE.ColorRepresentation): void
  /**
   * Live-set the scene-wide colour grade — the contrast/saturation budget knob.
   * Always available (the grade nodes are always in the graph, like bloom) and
   * mutates uniforms with no pipeline rebuild. Every field is optional and
   * defaults to its IDENTITY value, so a bare `setGrade({})` (or the explicit
   * all-identity / "neutral" call) restores today's ungraded look. Out-of-range
   * inputs are clamped to safe bounds. See `GradeOptions`.
   */
  setGrade(grade: GradeOptions): void
  /** Drop GPU resources. */
  dispose(): void
}

/**
 * Scene-wide colour-grade parameters. The grade is the final post stage and
 * runs in scene-referred LINEAR space (before the pipeline's tone-map + sRGB
 * encode). Every field is OPTIONAL and identity by default; an all-default
 * grade is a no-op (output byte-identical to today). Applied in order:
 * exposure → temperature (white balance) → saturation → contrast.
 */
export type GradeOptions = {
  /**
   * Linear exposure multiplier on the composited HDR colour. `1` = identity
   * (no change). `<1` darkens the whole frame (the "muted band" lever), `>1`
   * lifts it. Clamped to `>= 0`. Default `1`.
   */
  exposure?: number
  /**
   * Warm/cool white-balance shift in roughly `[-1, 1]`. `0` = identity (neutral,
   * channel gain exactly `(1,1,1)`). Positive warms (lifts red, drops blue);
   * negative cools (drops red, lifts blue); green is held. Clamped to `[-1, 1]`.
   * Default `0`.
   */
  temperature?: number
  /**
   * Global saturation around Rec.709 luminance. `1` = identity, `0` = greyscale,
   * `>1` = punchier. Holding the world `<1` while gameplay FX stay saturated is
   * the core of the legibility budget. Clamped to `>= 0`. Default `1`.
   */
  saturation?: number
  /**
   * Contrast about a 0.5 pivot (in linear space). `1` = identity; `<1` flattens
   * toward mid grey (mutes the world), `>1` widens. Clamped to `>= 0`.
   * Default `1`.
   */
  contrast?: number
}

/** Per-track cel/ink outline look. All optional; effect is off unless `enabled`. */
export type OutlineOptions = {
  /** Master switch. Default `false` — pipeline output is unchanged. */
  enabled?: boolean
  /** Ink darkness 0..1 at full edge response. Default 0.85. */
  strength?: number
  /** Ink line colour. Default near-black (`0x0a0a0a`). */
  color?: THREE.ColorRepresentation
  /** Sobel magnitude below this reads as flat (no line). Default 0.1. */
  threshold?: number
  /** Sobel magnitude at/above this is a full-strength line. Default 0.4. */
  softness?: number
}

/** Per-track motion blur look. All optional; effect is off unless `enabled`. */
export type MotionBlurOptions = {
  /**
   * Master switch. Default `false`. When enabled the PassNode grows a
   * velocity MRT output and the final composite is smeared along the
   * per-pixel motion vectors.
   */
  enabled?: boolean
  /** Sample count along the velocity vector. Default 16. Higher = smoother, costlier. */
  samples?: number
}

export type PostPipelineDeps = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.Camera
  /** Initial bloom strength (matches per-track `sky.bloom`). */
  bloomStrength?: number
  /** Initial blur radius (0..1). Defaults to 0.4 — wide enough for sun /
   *  neon halos at race-speed without smearing UI overlays. */
  bloomRadius?: number
  /** Luminance threshold (0..1). Defaults to 0.85 so daytime sky doesn't
   *  smear; only emissive landmarks + sun disc cross the threshold. */
  bloomThreshold?: number
  /** Cel/ink full-scene outline. Off unless `outline.enabled`. */
  outline?: OutlineOptions
  /** Velocity-buffer motion blur. Off unless `motionBlur.enabled`. */
  motionBlur?: MotionBlurOptions
  /**
   * Initial scene-wide colour grade. Omitted / all-default → identity (today's
   * look). Equivalent to building the pipeline and immediately calling
   * `setGrade(grade)`; provided so a per-track grade can be seeded at
   * construction the same way `bloomStrength` seeds bloom.
   */
  grade?: GradeOptions
}

/** Clamp helper local to the grade math (no allocation, inlinable). */
function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Resolve a `temperature` scalar in `[-1, 1]` to a per-channel linear gain
 * vector. `0` → exactly `(1, 1, 1)` (identity), positive warms (R up, B down),
 * negative cools (R down, B up); green is held at `1`. The `0.15` slope keeps a
 * full ±1 push to a gentle ±15 % channel skew — a colour-temperature nudge, not
 * a hard tint (the strong per-track tints belong to the dome grade in sky.ts).
 */
function temperatureGain(temperature: number): { r: number; g: number; b: number } {
  const t = clampNum(temperature, -1, 1) * 0.15
  return { r: 1 + t, g: 1, b: 1 - t }
}

export function createPostPipeline(deps: PostPipelineDeps): PostPipeline {
  const {
    renderer,
    scene,
    camera,
    bloomStrength = 0,
    bloomRadius = 0.4,
    bloomThreshold = 0.85,
    outline: outlineOpts,
    motionBlur: motionBlurOpts,
    grade: gradeOpts,
  } = deps

  const outlineEnabled = outlineOpts?.enabled === true
  const motionBlurEnabled = motionBlurOpts?.enabled === true

  const scenePass = pass(scene as never, camera as never)

  // Motion blur needs per-pixel motion vectors. Only grow the PassNode's
  // render target with a velocity MRT when the effect is actually on — an
  // off pipeline must keep exactly the shipping single-target layout.
  if (motionBlurEnabled) {
    scenePass.setMRT(mrt({ output, velocity }))
  }

  const scenePassColor = scenePass.getTextureNode('output')

  const bloomPass = bloom(scenePassColor, bloomStrength, bloomRadius, bloomThreshold)

  // ── Effect uniforms (kept around for dispose + live-set) ────────────────
  // Outline ink uniforms exist only when the effect is wired; the live-set
  // mutator no-ops otherwise so callers don't have to branch.
  let outlineStrength: ReturnType<typeof uniform> | null = null
  let outlineColor: ReturnType<typeof uniform> | null = null

  // Colour-grade uniforms — ALWAYS present (like bloom), so `setGrade()` can
  // mutate them live with no rebuild. Seeded from `deps.grade` (or identity).
  // Each default is an exact algebraic identity for the grade math below:
  //   exposure 1 → ×1 ; tempGain (1,1,1) → ×1 ; saturation 1 → mix returns
  //   the input ; contrast 1 → (c-0.5)*1+0.5 == c. So an unseeded grade leaves
  //   the composited colour unchanged term-for-term (output == today).
  const initExposure = Math.max(0, gradeOpts?.exposure ?? 1)
  const initTemp = temperatureGain(gradeOpts?.temperature ?? 0)
  const initSaturation = Math.max(0, gradeOpts?.saturation ?? 1)
  const initContrast = Math.max(0, gradeOpts?.contrast ?? 1)
  const gradeExposure = uniform(initExposure)
  const gradeTempGain = uniform(vec3(initTemp.r, initTemp.g, initTemp.b))
  const gradeSaturation = uniform(initSaturation)
  const gradeContrast = uniform(initContrast)

  // The beauty image the rest of the chain (bloom, motion blur) composites
  // over. Defaults to the raw scene colour; the outline pass replaces it
  // with an ink-darkened variant when enabled. When the outline is off this
  // stays === scenePassColor so the graph is identical to the shipping one.
  let beauty: TslNode = scenePassColor as unknown as TslNode

  if (outlineEnabled) {
    const inkStrength = Math.max(0, Math.min(1, outlineOpts?.strength ?? 0.85))
    const inkThreshold = outlineOpts?.threshold ?? 0.1
    const inkSoftness = Math.max(inkThreshold + 1e-4, outlineOpts?.softness ?? 0.4)
    const inkColorRep = outlineOpts?.color ?? 0x0a0a0a

    outlineStrength = uniform(inkStrength)
    // Decompose to a vec3 uniform so setOutline() can recolour live without
    // touching the graph topology.
    const c = normalizeColor(inkColorRep)
    outlineColor = uniform(vec3(c.r, c.g, c.b))

    // Full-scene Sobel edge magnitude on the beauty colour → an ink mask.
    // OutlineNode only outlines an explicit selectedObjects list, so it
    // can't give a whole-scene cel line; Sobel on scene luminance does.
    const edge = sobel(scenePassColor as never)
    const edgeMag = (edge as unknown as { r: unknown }).r
    const inkMask = smoothstep(float(inkThreshold), float(inkSoftness), edgeMag as never).mul(
      outlineStrength as never,
    )

    // Multiply-darken toward the ink colour where the mask is hot. mix()
    // keeps flat regions exactly equal to the scene colour (mask 0 → beauty).
    beauty = mix(scenePassColor as never, outlineColor as never, inkMask as never) as TslNode
  }

  // Bloom composites over the (possibly ink-darkened) beauty, identical to
  // the shipping additive blend when the outline is off (beauty === scene).
  let composited: TslNode = beauty.add(bloomPass)

  // Motion blur is the final stage of the BEAUTY composite — it smears the
  // fully-composited image (beauty + bloom) along the velocity vectors so
  // trails inherit bloom too.
  if (motionBlurEnabled) {
    const samples = Math.max(1, Math.round(motionBlurOpts?.samples ?? 16))
    const velocityNode = scenePass.getTextureNode('velocity')
    composited = motionBlur(composited as never, velocityNode as never, samples as never) as TslNode
  }

  // ── Colour grade — the final stage of the whole chain ───────────────────
  // Runs in scene-referred LINEAR space; the RenderPipeline applies tone-map +
  // sRGB encode to this `outputNode` downstream (outputColorTransform=true).
  // Order: exposure → temperature (white balance) → saturation → contrast,
  // operating on .rgb and re-packing the composite's original .a — the same
  // `vec4(transformedRgb, src.a)` shape three's own output nodes use, so the
  // pipeline still receives a vec4 with an unchanged alpha.
  //
  // Always built, but identity at the default uniforms, so the graded colour
  // reduces to today's `composited` term-for-term when no grade is set:
  //   • exposure  : scalar linear gain                 (×1       → identity)
  //   • temp gain : per-channel linear gain vec3        (×(1,1,1) → identity)
  //   • saturation: mix(luma, rgb) by amount           (amt 1    → returns rgb)
  //   • contrast  : (rgb - 0.5) * amount + 0.5          (amt 1    → returns rgb)
  // Exposure (scalar) and white-balance (vec3) are plain linear multiplies;
  // saturation is the addon colour-adjustment node (widened return type → `as
  // never`, same style as above). Contrast is applied inline as explicit vec3
  // math — the same `(c-0.5)*k+0.5` the dome grade uses — rather than the
  // `mx_contrast` node, whose internal `float(input)` cast would collapse the
  // rgb vector to a scalar.
  const compositedColor = composited as never as { rgb: unknown; a: unknown }
  const balancedRgb = (compositedColor.rgb as TslNode).mul(gradeExposure).mul(gradeTempGain)
  const saturatedRgb = saturation(balancedRgb as never, gradeSaturation as never) as TslNode
  const half = vec3(0.5, 0.5, 0.5)
  const gradedRgb = saturatedRgb.sub(half).mul(gradeContrast).add(half)
  const graded = vec4(gradedRgb as never, compositedColor.a as never)

  const pipeline = new RenderPipeline(renderer as never)
  pipeline.outputNode = graded as never

  return {
    scene,
    camera,
    render() {
      pipeline.render()
    },
    async compileAsync() {
      // Pre-warm by actually rendering one `pipeline.render()`. The
      // PassNode's render-target samples + texture type are only
      // populated in its `updateBefore` (reads `renderer.samples` and
      // `renderer.getOutputBufferType()`), so any earlier
      // `renderer.compileAsync(scene, camera)` — even one routed through
      // `passNode.compileAsync` — caches GPU pipelines under a stale key
      // (canvas RT instead of PassNode RT). When game-loop then calls
      // `pipeline.render()` the cache misses, the JIT-rebuild appears
      // to succeed silently, and every frame after that renders solid
      // black with no validation error. Driving one eager render here
      // walks setup → updateBefore → quad render with the *real* key
      // game-loop will use, so the cache is correct from frame 1. The
      // frame round-trips to the canvas but the loading screen is still
      // up, so the player never sees it.
      pipeline.render()
      // Yield to the GPU queue before rAF starts hammering render().
      await Promise.resolve()
    },
    async compileSubtreeAsync(object: THREE.Object3D) {
      const r = renderer as unknown as {
        getRenderTarget(): unknown
        setRenderTarget(rt: unknown): void
        getMRT(): unknown
        setMRT(mrt: unknown): void
        compileAsync?: (scene: unknown, camera: unknown, targetScene?: unknown) => Promise<void>
      }
      if (typeof r.compileAsync !== 'function') return
      const passInternals = scenePass as unknown as {
        renderTarget: unknown
        getMRT(): unknown
      }
      // renderer.compileAsync reads the *currently set* render target + MRT in
      // its synchronous prologue (everything up to its first await, including
      // projecting `object` into a render list and queueing one compile work
      // item per material). Swapping to the PassNode's RT/MRT for exactly that
      // window keys the compiled pipelines + render objects identically to the
      // live scene pass; restoring before the await means interleaved rAF
      // frames never observe the swap.
      const prevRT = r.getRenderTarget()
      const prevMRT = r.getMRT()
      r.setRenderTarget(passInternals.renderTarget)
      r.setMRT(passInternals.getMRT())
      let compiled: Promise<void> | undefined
      try {
        compiled = r.compileAsync(object, camera, scene)
      } finally {
        r.setRenderTarget(prevRT)
        r.setMRT(prevMRT)
      }
      await compiled
    },
    setBloom(strength: number, radius?: number, threshold?: number) {
      bloomPass.strength.value = Math.max(0, strength)
      if (radius !== undefined) bloomPass.radius.value = Math.max(0, Math.min(1, radius))
      if (threshold !== undefined) bloomPass.threshold.value = Math.max(0, threshold)
    },
    setOutline(strength: number, color?: THREE.ColorRepresentation) {
      if (outlineStrength === null) return
      outlineStrength.value = Math.max(0, Math.min(1, strength))
      if (color !== undefined && outlineColor !== null) {
        const c = normalizeColor(color)
        // `uniform(vec3(...))` carries a THREE.Vector3 value at runtime; its
        // static type is widened to `unknown`, hence the cast.
        ;(outlineColor.value as THREE.Vector3).set(c.r, c.g, c.b)
      }
    },
    setGrade(grade: GradeOptions) {
      // Each field is independent and only written when supplied, so callers
      // can nudge one dial without resetting the rest. An omitted field keeps
      // its current uniform; passing every field at its identity value (or a
      // bare `{}`) restores the today's-look identity grade — the clean
      // "neutral" call, no rebuild, same cost as any other write.
      if (grade.exposure !== undefined) {
        gradeExposure.value = Math.max(0, grade.exposure)
      }
      if (grade.temperature !== undefined) {
        const g = temperatureGain(grade.temperature)
        ;(gradeTempGain.value as THREE.Vector3).set(g.r, g.g, g.b)
      }
      if (grade.saturation !== undefined) {
        gradeSaturation.value = Math.max(0, grade.saturation)
      }
      if (grade.contrast !== undefined) {
        gradeContrast.value = Math.max(0, grade.contrast)
      }
    },
    dispose() {
      pipeline.dispose()
      scenePass.dispose?.()
      bloomPass.dispose?.()
    },
  }
}

/**
 * Resolve a `THREE.ColorRepresentation` to linear-ish {r,g,b} without
 * importing the whole three Color class graph at the sim boundary — a hex
 * number or `{r,g,b}` object covers every authoring path we use. Falls back
 * to near-black so a malformed value never produces a bright ink line.
 */
function normalizeColor(c: THREE.ColorRepresentation): { r: number; g: number; b: number } {
  if (typeof c === 'number') {
    return {
      r: ((c >> 16) & 0xff) / 255,
      g: ((c >> 8) & 0xff) / 255,
      b: (c & 0xff) / 255,
    }
  }
  if (typeof c === 'object' && c !== null && 'r' in c && 'g' in c && 'b' in c) {
    const o = c as { r: number; g: number; b: number }
    return { r: o.r, g: o.g, b: o.b }
  }
  return { r: 0.04, g: 0.04, b: 0.04 }
}
