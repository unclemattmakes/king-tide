/**
 * Dev-tools palette — docked tuner coordinator (single-active).
 *
 * The three live-tuning panels (input-feel / water / chase-camera) all dock
 * to the LEFT edge and would overlap if more than one were open. The host
 * keeps exactly one open: opening a panel closes the others first, and
 * re-running an already-open panel toggles it shut. Each panel's heavy module
 * is dynamic-imported on first open (its own Vite chunk), mirroring
 * `bindLazyMenuButton` (lazy-menu.ts).
 *
 * The dev-settings + water menus expose `{ open, close, isOpen }`; the camera
 * tuner only exposes `{ dispose }` and is "open" the moment it's created, so
 * closing it = dispose + drop the handle (re-created on next open, restoring
 * its persisted values).
 */

import type * as THREE from 'three'
import { getWaterMesh } from '../render/water-service'
import type { TunerId } from './registry-types'

/** Structural shape of the dev-settings / water menu handles. */
type OpenCloseMenu = { open(): void; close(): void; isOpen(): boolean }
type CameraTuner = { dispose(): void }

export type TunerHost = {
  /** Open the tuner (closing any other), or toggle it shut if already open. */
  open(id: TunerId): void
  closeAll(): void
  isOpen(id: TunerId): boolean
}

export function createTunerHost(deps: { camera: THREE.PerspectiveCamera }): TunerHost {
  let devsettings: OpenCloseMenu | null = null
  let water: OpenCloseMenu | null = null
  let brush: OpenCloseMenu | null = null
  let camera: CameraTuner | null = null

  function closeOne(id: TunerId): void {
    if (id === 'devsettings') devsettings?.close()
    else if (id === 'water') water?.close()
    else if (id === 'brush') brush?.close()
    else if (camera) {
      camera.dispose()
      camera = null
    }
  }

  function closeOthers(except: TunerId): void {
    for (const id of ['devsettings', 'water', 'brush', 'camera'] as const) {
      if (id !== except) closeOne(id)
    }
  }

  function isOpen(id: TunerId): boolean {
    if (id === 'devsettings') return devsettings?.isOpen() ?? false
    if (id === 'water') return water?.isOpen() ?? false
    if (id === 'brush') return brush?.isOpen() ?? false
    // The camera tuner has no open/close — it's open iff its panel is mounted.
    return camera !== null && document.getElementById('camtune-panel') !== null
  }

  async function open(id: TunerId): Promise<void> {
    // Toggle: clicking an already-open tuner closes it.
    if (isOpen(id)) {
      closeOne(id)
      return
    }
    closeOthers(id)

    if (id === 'devsettings') {
      if (!devsettings) {
        const { installDevSettingsMenu } = await import('../dev-settings-menu')
        // Re-check after the await so two racing opens can't double-install.
        if (!devsettings) devsettings = installDevSettingsMenu()
      }
      devsettings.open()
    } else if (id === 'water') {
      if (!water) {
        // The full WaterMesh lives in the water-service singleton (set by
        // main.ts). It's null on procedural / edit-mode tracks with no water.
        const mesh = getWaterMesh()
        if (!mesh) return
        const { installWaterDebugMenu } = await import('../water-debug-menu')
        if (!water) water = installWaterDebugMenu(mesh)
      }
      water.open()
    } else if (id === 'brush') {
      if (!brush) {
        const { installBrushDebugMenu } = await import('../brush-debug-menu')
        if (!brush) brush = installBrushDebugMenu()
      }
      brush.open()
    } else {
      if (!camera) {
        const { createCameraTuner } = await import('../../boot/camera-tuner')
        if (!camera) camera = createCameraTuner(deps.camera)
      }
    }
  }

  function closeAll(): void {
    devsettings?.close()
    water?.close()
    brush?.close()
    if (camera) {
      camera.dispose()
      camera = null
    }
  }

  return {
    open: (id) => {
      void open(id)
    },
    closeAll,
    isOpen,
  }
}
