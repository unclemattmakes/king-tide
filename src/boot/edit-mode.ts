/**
 * Track editor wiring — `?edit=1` branches `boot()` here instead of
 * spinning up the live race. The editor owns the canvas; sim/physics
 * are skipped, no AI bikes, no race system. The user authors the track
 * and saves to disk; hitting "Play" reloads without `?edit=1`.
 *
 * Returns once the rAF loop is armed so the caller can `return` from
 * `boot()`.
 */

import type * as THREE from 'three'
import { installTrackEditor } from '@/engine/editor/track-editor'
import type { SkySystem } from '@/engine/render/sky'
import { updateUnderwaterFog } from '@/engine/render/water'
import type { WaveFieldState } from '@/engine/sim/water/wave-field'
import type { PropManifestEntry } from '@/game/assets/manifest'
import type { Track } from '@/game/tracks/types'
import { hideLoadingScreen } from './loading-screen'

export interface EditModeWiringOpts {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  appEl: HTMLElement
  track: Track
  propAssets: PropManifestEntry[] | undefined
  sky: SkySystem
  waterMesh: { tick: () => void }
  waveField: WaveFieldState
  backend: string
  backendEl: HTMLElement | null
}

export function startEditMode(opts: EditModeWiringOpts): void {
  const { scene, camera, renderer, appEl, track, propAssets, sky, waterMesh, waveField, backend } =
    opts
  if (opts.backendEl) opts.backendEl.textContent = `editor · backend ${backend}`
  const editor = installTrackEditor({
    scene,
    camera,
    renderer,
    domEl: appEl,
    track,
    ...(propAssets ? { propAssets } : {}),
  })
  let editLastT = performance.now()
  function editFrame(): void {
    const now = performance.now()
    const dt = Math.min(0.1, (now - editLastT) / 1000)
    editLastT = now
    // Editor: lighting is fixed at the track's `timeOfDay` (the dome
    // bakes a single env-map at load), so this tick is just shadow-
    // camera focus tracking off the editor camera.
    sky.tick(waveField.time, dt, { x: camera.position.x, z: camera.position.z })
    updateUnderwaterFog(scene, camera.position.y)
    waterMesh.tick()
    editor.tick()
    requestAnimationFrame(editFrame)
  }
  hideLoadingScreen()
  requestAnimationFrame(editFrame)
}
