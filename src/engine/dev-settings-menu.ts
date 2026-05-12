/**
 * Dev settings menu — DOM overlay that drives `devSettings` live.
 *
 * Each slider mutates a single field of the shared `devSettings` object
 * on `input` (every drag tick) and persists on `change` (drag end). The
 * input modules read the same object every tick, so changes apply
 * immediately — no reload, no pause.
 *
 * Mirrors the garage menu's install pattern: bind once at boot, return
 * a small handle so callers can open/close it programmatically.
 */

import {
  DEFAULT_DEV_SETTINGS,
  devSettings,
  resetDevSettings,
  saveDevSettings,
} from './dev-settings'

export type DevSettingsMenu = {
  open(): void
  close(): void
  isOpen(): boolean
}

type NumericKey =
  | 'cameraMouseSens'
  | 'cameraStickYawRange'
  | 'cameraStickPitchRange'
  | 'cameraStickDeadzone'
  | 'gamepadDeadzone'
  | 'stickCurve'
  | 'keyboardSteerRate'
  | 'keyboardThrottleRate'
  | 'keyboardPitchRate'

type SliderSpec = {
  key: NumericKey
  inputId: string
  valId: string
  format: (n: number) => string
}

const SLIDERS: SliderSpec[] = [
  {
    key: 'cameraMouseSens',
    inputId: 'ds-mouse-sens',
    valId: 'ds-mouse-sens-v',
    format: (n) => n.toFixed(4),
  },
  {
    key: 'cameraStickYawRange',
    inputId: 'ds-stick-yaw',
    valId: 'ds-stick-yaw-v',
    format: (n) => `${(n * (180 / Math.PI)).toFixed(0)}°`,
  },
  {
    key: 'cameraStickPitchRange',
    inputId: 'ds-stick-pitch',
    valId: 'ds-stick-pitch-v',
    format: (n) => `${(n * (180 / Math.PI)).toFixed(0)}°`,
  },
  {
    key: 'cameraStickDeadzone',
    inputId: 'ds-stick-dz',
    valId: 'ds-stick-dz-v',
    format: (n) => n.toFixed(2),
  },
  { key: 'gamepadDeadzone', inputId: 'ds-gp-dz', valId: 'ds-gp-dz-v', format: (n) => n.toFixed(2) },
  {
    key: 'stickCurve',
    inputId: 'ds-stick-curve',
    valId: 'ds-stick-curve-v',
    format: (n) => n.toFixed(2),
  },
  {
    key: 'keyboardSteerRate',
    inputId: 'ds-kb-steer',
    valId: 'ds-kb-steer-v',
    format: (n) => n.toFixed(1),
  },
  {
    key: 'keyboardThrottleRate',
    inputId: 'ds-kb-throttle',
    valId: 'ds-kb-throttle-v',
    format: (n) => n.toFixed(1),
  },
  {
    key: 'keyboardPitchRate',
    inputId: 'ds-kb-pitch',
    valId: 'ds-kb-pitch-v',
    format: (n) => n.toFixed(1),
  },
]

export function installDevSettingsMenu(): DevSettingsMenu {
  const overlay = document.getElementById('devsettings')
  const toggle = document.getElementById('devsettings-toggle')
  const closeBtn = document.getElementById('ds-close')
  const resetBtn = document.getElementById('ds-reset')
  const invertY = document.getElementById('ds-invert-y') as HTMLInputElement | null
  if (!overlay || !toggle || !closeBtn || !resetBtn || !invertY) {
    return { open() {}, close() {}, isOpen: () => false }
  }

  type Bound = { spec: SliderSpec; input: HTMLInputElement; valEl: HTMLElement }
  const bound: Bound[] = []
  for (const spec of SLIDERS) {
    const input = document.getElementById(spec.inputId) as HTMLInputElement | null
    const valEl = document.getElementById(spec.valId)
    if (!input || !valEl) continue
    bound.push({ spec, input, valEl })

    const writeValue = (v: number) => {
      devSettings[spec.key] = v
      valEl.textContent = spec.format(v)
    }

    input.addEventListener('input', () => {
      const v = Number.parseFloat(input.value)
      if (Number.isFinite(v)) writeValue(v)
    })
    // Persist only on release, so dragging doesn't hammer localStorage.
    input.addEventListener('change', () => saveDevSettings())
  }

  invertY.addEventListener('change', () => {
    devSettings.cameraInvertY = invertY.checked
    saveDevSettings()
  })

  function syncUI() {
    for (const b of bound) {
      const v = devSettings[b.spec.key]
      b.input.value = String(v)
      b.valEl.textContent = b.spec.format(v)
    }
    if (invertY) invertY.checked = devSettings.cameraInvertY
  }

  function open() {
    syncUI()
    overlay!.classList.add('show')
  }
  function close() {
    overlay!.classList.remove('show')
  }

  toggle.addEventListener('click', open)
  closeBtn.addEventListener('click', close)
  resetBtn.addEventListener('click', () => {
    resetDevSettings()
    syncUI()
  })
  // Esc closes when open.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && overlay!.classList.contains('show')) close()
  })

  return {
    open,
    close,
    isOpen: () => overlay!.classList.contains('show'),
  }
}
