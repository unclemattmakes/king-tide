import type * as THREE from 'three'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { pass } from 'three/tsl'
import { RenderPipeline } from 'three/webgpu'

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
   * Live-set bloom parameters. `strength = 0` short-circuits to a passthrough
   * (no bloom contribution) — cheaper than tearing the pipeline down for
   * tracks that authored `sky.bloom: 0`.
   */
  setBloom(strength: number, radius?: number, threshold?: number): void
  /** Drop GPU resources. */
  dispose(): void
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
}

export function createPostPipeline(deps: PostPipelineDeps): PostPipeline {
  const {
    renderer,
    scene,
    camera,
    bloomStrength = 0,
    bloomRadius = 0.4,
    bloomThreshold = 0.85,
  } = deps

  const scenePass = pass(scene as never, camera as never)
  const scenePassColor = scenePass.getTextureNode('output')

  const bloomPass = bloom(scenePassColor, bloomStrength, bloomRadius, bloomThreshold)

  const pipeline = new RenderPipeline(renderer as never)
  pipeline.outputNode = scenePassColor.add(bloomPass)

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
    setBloom(strength: number, radius?: number, threshold?: number) {
      bloomPass.strength.value = Math.max(0, strength)
      if (radius !== undefined) bloomPass.radius.value = Math.max(0, Math.min(1, radius))
      if (threshold !== undefined) bloomPass.threshold.value = Math.max(0, threshold)
    },
    dispose() {
      pipeline.dispose()
      scenePass.dispose?.()
      bloomPass.dispose?.()
    },
  }
}
