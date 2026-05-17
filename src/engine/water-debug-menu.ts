/**
 * Water debug menu — DOM overlay for live-tuning the wave field + water
 * shader. Mirrors the dev-settings-menu pattern: bind once at boot,
 * sliders mutate the WaterMesh's debug surface on `input` (every drag
 * tick) and persist on `change` (drag end).
 *
 * The menu writes through `WaterMesh.debug.set*` setters which clamp +
 * apply each value to the relevant TSL uniform (and, for amplitude
 * scales, to `field.waves[i].amplitude` so CPU buoyancy stays locked
 * to what the shader is drawing). Persistence uses localStorage so a
 * tuning session survives reloads; RESET restores the constructor
 * defaults captured by the WaterMesh.
 *
 * The menu is built in JS rather than declared in HTML — these knobs
 * are tuning-only and shouldn't bloat the HUD markup. The shell
 * (`#water-debug` overlay + `#water-debug-toggle` button) is the only
 * static surface the install function needs.
 */

import type { WaterMesh } from './render/water'
import {
  applyWaterSettings,
  defaultsToSettings,
  loadStoredWaterSettings,
  persistWaterSettings,
  type WaterDebugSettings,
} from './water-debug-storage'

type SliderDef = {
  key: Exclude<keyof WaterDebugSettings, 'wireframe'>
  label: string
  min: number
  max: number
  step: number
  format: (n: number) => string
  hint?: string
}

const SLIDERS: SliderDef[] = [
  // Wave shape — the load-bearing knobs for "tuning the waves".
  {
    key: 'steepness',
    label: 'Steepness (Q)',
    min: 0,
    max: 1.5,
    step: 0.01,
    format: (n) => n.toFixed(2),
    hint: '0 = round bumps · 0.7 = SoT default · >1.3 risks crests folding',
  },
  {
    key: 'swellScale',
    label: 'Swell amplitude',
    min: 0,
    max: 2,
    step: 0.05,
    format: (n) => `${n.toFixed(2)}×`,
    hint: 'Multiplier on long-period swells (waves 0–1). Affects buoyancy.',
  },
  {
    key: 'chopScale',
    label: 'Chop amplitude',
    min: 0,
    max: 2,
    step: 0.05,
    format: (n) => `${n.toFixed(2)}×`,
    hint: 'Multiplier on wind chop (waves 2–5). Affects buoyancy.',
  },
  {
    key: 'timeScale',
    label: 'Time scale',
    min: 0,
    max: 3,
    step: 0.05,
    format: (n) => `${n.toFixed(2)}×`,
    hint: '0 = freeze waves · 1 = realtime',
  },
  // Look — surface response + lighting feel.
  {
    key: 'reflectionStrength',
    label: 'Reflection cap',
    min: 0,
    max: 1,
    step: 0.01,
    format: (n) => n.toFixed(2),
    hint: '0 disables planar reflection · 0.85 = v2 default',
  },
  {
    key: 'sunGlow',
    label: 'Sun glow',
    min: 0,
    max: 2,
    step: 0.05,
    format: (n) => `${n.toFixed(2)}×`,
    hint: 'Backlit-crest glow strength',
  },
  {
    key: 'roughBase',
    label: 'Roughness (base)',
    min: 0,
    max: 0.5,
    step: 0.01,
    format: (n) => n.toFixed(2),
    hint: 'Lower = wetter / more specular',
  },
  {
    key: 'roughSparkle',
    label: 'Roughness (sparkle)',
    min: 0,
    max: 0.3,
    step: 0.01,
    format: (n) => n.toFixed(2),
    hint: 'Roughness inside sparkle patches — lower = brighter glints',
  },
  {
    key: 'detailStrength',
    label: 'Detail (sub-Gerstner)',
    min: 0,
    max: 2,
    step: 0.05,
    format: (n) => `${n.toFixed(2)}×`,
    hint: 'FFT-lite detail normal cascades. 0 = bypass · 1 = default chop · 2 = punchy',
  },
  // FFT-path sliders. No-ops outside `?water=fft` + spectrum field so
  // there's no harm leaving them in the menu always — they just hold
  // value silently on the analytic path. A future "show only relevant
  // knobs" pass can hide them based on detected mode.
  {
    key: 'choppiness',
    label: 'Choppiness (λ)',
    min: 0,
    max: 2,
    step: 0.05,
    format: (n) => n.toFixed(2),
    hint: 'Tessendorf horizontal pinch. 0 = pure heightfield · 0.5 = default · 1+ = breaking waves',
  },
  {
    key: 'seaStateIntensity',
    label: 'Sea state',
    min: 0,
    max: 4,
    step: 0.05,
    format: (n) => `${n.toFixed(2)}×`,
    hint: 'Visual amplitude of the FFT spectrum. 1 = default · scrub up for stormy, down for glassy',
  },
  {
    key: 'windSpeed',
    label: 'Wind speed',
    min: 1,
    max: 20,
    step: 0.5,
    format: (n) => `${n.toFixed(1)} m/s`,
    hint: 'Phillips spectrum L = V²/g. Higher = longer rolling swells; lower = short choppy ripples',
  },
  {
    key: 'windDirection',
    label: 'Wind direction',
    min: -180,
    max: 180,
    step: 1,
    format: (n) => `${n.toFixed(0)}°`,
    hint: 'Wind-sea cascade direction (degrees CCW from world +X). Chop + swell cascades keep their hard-coded directions for cascade angle separation',
  },
  {
    key: 'windCutoff',
    label: 'Wind cutoff',
    min: 0.1,
    max: 5,
    step: 0.05,
    format: (n) => `${n.toFixed(2)} m`,
    hint: 'Phillips small-wavelength cutoff. Modes shorter than this are pruned. Lower = finer chop · higher = smoother surface',
  },
]

export type WaterDebugMenu = {
  open(): void
  close(): void
  isOpen(): boolean
}

/**
 * Mounts the water debug overlay. On boot, loads any persisted settings
 * and applies them to the water mesh so the visible state matches the
 * sliders the user last left. Returns a small handle for programmatic
 * open/close (matching `installDevSettingsMenu`).
 */
export function installWaterDebugMenu(water: WaterMesh): WaterDebugMenu {
  const overlay = document.getElementById('water-debug')
  const toggle = document.getElementById('water-debug-toggle')
  const closeBtn = document.getElementById('wd-close')
  const resetBtn = document.getElementById('wd-reset')
  const body = document.getElementById('wd-body')
  if (!overlay || !toggle || !closeBtn || !resetBtn || !body) {
    return { open() {}, close() {}, isOpen: () => false }
  }

  const settings = loadStoredWaterSettings(water.debug.defaults)
  applyWaterSettings(water, settings)

  type Bound = { def: SliderDef; input: HTMLInputElement; valEl: HTMLElement }
  const bound: Bound[] = []

  // Build the sliders from the SLIDERS table.
  for (const def of SLIDERS) {
    const row = document.createElement('div')
    row.className = 'row'

    const label = document.createElement('label')
    label.htmlFor = `wd-${def.key}`
    label.textContent = def.label
    if (def.hint) label.title = def.hint
    row.appendChild(label)

    const input = document.createElement('input')
    input.type = 'range'
    input.id = `wd-${def.key}`
    input.min = String(def.min)
    input.max = String(def.max)
    input.step = String(def.step)
    input.value = String(settings[def.key])
    row.appendChild(input)

    const valEl = document.createElement('span')
    valEl.className = 'val'
    valEl.textContent = def.format(settings[def.key])
    row.appendChild(valEl)

    body.appendChild(row)
    bound.push({ def, input, valEl })

    input.addEventListener('input', () => {
      const v = Number.parseFloat(input.value)
      if (!Number.isFinite(v)) return
      ;(settings as unknown as Record<string, number>)[def.key] = v
      valEl.textContent = def.format(v)
      // Apply directly — no need to call applyAll on every drag tick.
      switch (def.key) {
        case 'steepness':
          water.debug.setSteepness(v)
          break
        case 'swellScale':
          water.debug.setSwellScale(v)
          break
        case 'chopScale':
          water.debug.setChopScale(v)
          break
        case 'timeScale':
          water.debug.setTimeScale(v)
          break
        case 'reflectionStrength':
          water.debug.setReflectionStrength(v)
          break
        case 'sunGlow':
          water.debug.setSunGlow(v)
          break
        case 'roughBase':
          water.debug.setRoughBase(v)
          break
        case 'roughSparkle':
          water.debug.setRoughSparkle(v)
          break
        case 'detailStrength':
          water.debug.setDetailStrength(v)
          break
        case 'choppiness':
          water.debug.setChoppiness(v)
          break
        case 'seaStateIntensity':
          water.debug.setSeaStateIntensity(v)
          break
        case 'windSpeed':
          water.debug.setWindSpeed(v)
          break
        case 'windDirection':
          water.debug.setWindDirection(v)
          break
        case 'windCutoff':
          water.debug.setWindCutoff(v)
          break
      }
    })
    input.addEventListener('change', () => persistWaterSettings(settings))
  }

  // Wireframe toggle row.
  const wireRow = document.createElement('div')
  wireRow.className = 'row toggle'
  const wireLabel = document.createElement('label')
  wireLabel.htmlFor = 'wd-wire'
  wireLabel.textContent = 'Wireframe'
  wireLabel.title = 'Render the wave geometry as wireframe — shows the actual displacement'
  wireRow.appendChild(wireLabel)
  const wireInput = document.createElement('input')
  wireInput.type = 'checkbox'
  wireInput.id = 'wd-wire'
  wireInput.checked = settings.wireframe
  wireRow.appendChild(wireInput)
  body.appendChild(wireRow)
  wireInput.addEventListener('change', () => {
    settings.wireframe = wireInput.checked
    water.debug.setWireframe(wireInput.checked)
    persistWaterSettings(settings)
  })

  function syncUI(): void {
    for (const b of bound) {
      const v = settings[b.def.key]
      b.input.value = String(v)
      b.valEl.textContent = b.def.format(v)
    }
    wireInput.checked = settings.wireframe
  }

  function open(): void {
    overlay!.classList.add('show')
  }
  function close(): void {
    overlay!.classList.remove('show')
  }

  toggle.addEventListener('click', open)
  closeBtn.addEventListener('click', close)
  resetBtn.addEventListener('click', () => {
    Object.assign(settings, defaultsToSettings(water.debug.defaults))
    applyWaterSettings(water, settings)
    syncUI()
    persistWaterSettings(settings)
  })
  // Esc closes when open. Doesn't intercept when other overlays own the key.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && overlay!.classList.contains('show')) close()
  })

  return {
    open,
    close,
    isOpen: () => overlay!.classList.contains('show'),
  }
}
