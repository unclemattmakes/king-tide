/**
 * Dev-tools palette — single install entry point.
 *
 * Builds the shared tool registry and stands up the two surfaces over it:
 * the right-edge dock rail and the Ctrl/Cmd+K command bar. The tuner host
 * keeps the docked live panels single-active. Dev builds only — called from
 * `startGameLoop` (boot/game-loop.ts) behind the same `import.meta.env.DEV ||
 * ?dev=1` gate that flips `body.dev-build`.
 *
 * One install per live race; each sub-surface is idempotent under Vite HMR
 * (remove-by-id then rebuild), and `destroy()` tears the whole thing down.
 */

import type * as THREE from 'three'
import { installCommandBar } from './command-bar'
import { installDockRail } from './dock-rail'
import { createDevTools } from './tools'
import { createTunerHost } from './tuner-host'

export type DevPalette = { destroy(): void }

export function installDevPalette(deps: { camera: THREE.PerspectiveCamera }): DevPalette {
  const tunerHost = createTunerHost({ camera: deps.camera })
  const tools = createDevTools({
    camera: deps.camera,
    openTuner: (id) => tunerHost.open(id),
    isTunerOpen: (id) => tunerHost.isOpen(id),
  })
  const dock = installDockRail(tools)
  const bar = installCommandBar(tools)

  return {
    destroy() {
      dock.destroy()
      bar.destroy()
      tunerHost.closeAll()
    },
  }
}
