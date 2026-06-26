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
import type { HorizonRing } from '@/engine/render/horizon-ring'
import type { SkySystem } from '@/engine/render/sky'
import type { TerrainHeightmap } from '@/engine/render/terrain-heightmap'
import { updateUnderwaterFog } from '@/engine/render/water'
import { advanceWaveField, sampleHeight, type WaveFieldState } from '@/engine/sim/water/wave-field'
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
  horizonRing: HorizonRing
  waterMesh: { tick: () => void; mesh: THREE.Object3D }
  waveField: WaveFieldState
  /** Baked terrain heightmap (when an env GLB loaded in edit mode) — forwarded
   *  to the editor so `seatToTerrain` prop-line previews seat onto real terrain. */
  terrainHeightmap: TerrainHeightmap | null
  backend: string
  backendEl: HTMLElement | null
}

export function startEditMode(opts: EditModeWiringOpts): void {
  const {
    scene,
    camera,
    renderer,
    appEl,
    track,
    propAssets,
    sky,
    horizonRing,
    waterMesh,
    waveField,
    terrainHeightmap,
    backend,
  } = opts
  if (opts.backendEl) opts.backendEl.textContent = `editor · backend ${backend}`
  // Dev-only handle: lets the fidelity e2e (and ad-hoc debugging) confirm the
  // editor's water is actually advancing. Pairs with `window.__scene`.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    ;(window as unknown as { __editWaveField?: WaveFieldState }).__editWaveField = waveField
  }
  const editor = installTrackEditor({
    scene,
    camera,
    renderer,
    domEl: appEl,
    track,
    ...(propAssets ? { propAssets } : {}),
    waveField,
    terrainHeightmap,
    setWaterHeight: (h) => {
      waveField.baseY = h
      waterMesh.mesh.position.y = h
    },
  })
  let editLastT = performance.now()
  function editFrame(): void {
    const now = performance.now()
    const dt = Math.min(0.1, (now - editLastT) / 1000)
    editLastT = now
    // Advance the wave field so the editor's water actually moves — crests
    // roll, the waterline breathes, and any floating (wave-rider) props bob.
    // Without this the surface (and floats) sit frozen. Mirrors the dev
    // scenes (?waterlab / ?waveriders); the editor has no time-scale toggle
    // so it always runs at real time.
    advanceWaveField(waveField, dt)
    // Editor: lighting is fixed at the track's `timeOfDay` (the dome
    // bakes a single env-map at load), so this tick is just shadow-
    // camera focus tracking off the editor camera.
    sky.tick(waveField.time, dt, { x: camera.position.x, z: camera.position.z })
    // Horizon silhouette follows the editor's free-fly camera so the
    // distant landform always wraps the author's viewpoint.
    horizonRing.tick({ x: camera.position.x, z: camera.position.z })
    updateUnderwaterFog(
      scene,
      camera.position.y,
      sampleHeight(waveField, camera.position.x, camera.position.z),
    )
    waterMesh.tick()
    editor.tick(dt)
    requestAnimationFrame(editFrame)
  }
  hideLoadingScreen()
  requestAnimationFrame(editFrame)
}
