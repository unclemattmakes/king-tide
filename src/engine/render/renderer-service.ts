/**
 * Renderer service singleton — same pattern as `audio-service.ts`. The
 * `WebGLRenderer` instance created during boot is stashed here so the
 * Settings overlay + the Steam Deck profile can re-apply pixel-ratio
 * / size changes without prop-drilling through `main.ts → game-loop`.
 *
 * `main.ts` calls `setRenderer(renderer)` right after `createRenderer()`.
 * Consumers either:
 *
 *   - call `getRenderer()?.…` and tolerate `null` (overlay opens before
 *     the renderer exists in some test/headless paths), or
 *   - call the helpers in this module (e.g. `applyPixelRatio`) which do
 *     the null check themselves.
 *
 * The helpers also clamp to safe values — a settings UI is free to pass
 * any number; the service is the single place that respects
 * `devicePixelRatio` (we don't want to over-sample on a hi-DPI screen
 * because the player's slider read `1.0`).
 */

import type * as THREE from 'three'
import type { PostPipeline } from './post-pipeline'

let instance: THREE.WebGLRenderer | null = null
let activePipeline: PostPipeline | null = null

export function setRenderer(renderer: THREE.WebGLRenderer): void {
  instance = renderer
}

export function getRenderer(): THREE.WebGLRenderer | null {
  return instance
}

/**
 * Apply a player-facing pixel ratio to the live renderer. We honour
 * the device's own `devicePixelRatio` as a ceiling so a slider value of
 * 1.0 doesn't accidentally force 2× rendering on a 4K display — the
 * intent of the slider is "fraction of native", not "absolute scale".
 */
export function applyPixelRatio(ratio: number): void {
  if (!instance) return
  if (!Number.isFinite(ratio) || ratio <= 0) return
  const ceiling = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio ?? 1, 2)
  const effective = Math.max(0.25, Math.min(ratio, ceiling))
  instance.setPixelRatio(effective)
  // `setPixelRatio` alone doesn't resize the drawing buffer — the canvas
  // size hasn't changed. Re-apply the existing size so the new ratio
  // takes effect for the next render.
  if (typeof window !== 'undefined') {
    instance.setSize(window.innerWidth, window.innerHeight, false)
  }
}

/**
 * Register the active post-processing pipeline. Render call sites that go
 * through `renderFrame(scene, camera)` route through the pipeline when
 * the (scene, camera) tuple matches the one the pipeline was built for;
 * otherwise they fall back to a direct `renderer.render(scene, camera)`.
 *
 * Sky systems call this at construction and again with `null` on dispose.
 * Only one pipeline is active at a time (we ship one race scene at a time).
 */
export function setActivePostPipeline(pipeline: PostPipeline | null): void {
  activePipeline = pipeline
}

export function getActivePostPipeline(): PostPipeline | null {
  return activePipeline
}

/**
 * Render a frame, routing through the active post-processing pipeline if
 * one is registered for this (scene, camera) tuple. Falls back to a
 * direct `renderer.render(scene, camera)` for utility renderers
 * (track-editor, bike-viewer) that don't want bloom.
 */
export function renderFrame(scene: THREE.Scene, camera: THREE.Camera): void {
  if (
    activePipeline !== null &&
    activePipeline.scene === scene &&
    activePipeline.camera === camera
  ) {
    activePipeline.render()
    return
  }
  instance?.render(scene, camera)
}

/** Test-only — clear the registered renderer between cases. */
export function _resetRendererForTests(): void {
  instance = null
  activePipeline = null
}
