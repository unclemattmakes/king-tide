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
  key: Exclude<keyof WaterDebugSettings, 'wireframe' | 'colorize'>
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
    key: 'waveBearing',
    label: 'Wave bearing',
    min: -180,
    max: 180,
    step: 1,
    format: (n) => `${n.toFixed(0)}°`,
    hint: 'Global wave-train direction (CCW from world +X). Rotates ALL waves together so the swell can be aimed (e.g. toward an island). Render + CPU buoyancy track together — bike float math stays in sync',
  },
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
    max: 8,
    step: 0.1,
    format: (n) => `${n.toFixed(2)}×`,
    hint: 'Multiplier on long-period swells (waves 0–1). Affects buoyancy. >2× starts feeling like proper open-ocean rollers.',
  },
  {
    key: 'chopScale',
    label: 'Chop amplitude',
    min: 0,
    max: 6,
    step: 0.1,
    format: (n) => `${n.toFixed(2)}×`,
    hint: 'Multiplier on wind chop (waves 2–5). Affects buoyancy. Crank to ~3–4× for a stormy surface.',
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
  {
    key: 'pinchDirection',
    label: 'Pinch direction',
    min: 0,
    max: 90,
    step: 1,
    format: (n) => `${n.toFixed(0)}°`,
    hint: 'Rotation of the Gerstner horizontal-displacement vector relative to wave direction. 0° = along wave (standard, sharpens crests in direction of travel) · 90° = across wave (sharpens along the crest-line axis)',
  },
  {
    key: 'shoreWaveStrength',
    label: 'Shore waves',
    min: 0,
    max: 2,
    step: 0.05,
    format: (n) => `${n.toFixed(2)}×`,
    hint: 'Coast-parallel breakers that fill the near-shore band, marching shoreward. Affects buoyancy (rideable). 0 = off (legacy damped shore) · 1 = default · 2 = exaggerated surf',
  },
  // SoT-inspired fragment shading sliders.
  {
    key: 'bodyAbsorption',
    label: 'Body absorption',
    min: 0,
    max: 3,
    step: 0.05,
    format: (n) => `${n.toFixed(2)}×`,
    hint: 'Beer-Lambert depth absorption rate. 0 = no absorption (seabed shows through). 1 = baseline. 3 = fast (shallow water already reads deep)',
  },
  {
    key: 'sunDiscStrength',
    label: 'Sun disc',
    min: 0,
    max: 3,
    step: 0.05,
    format: (n) => `${n.toFixed(2)}×`,
    hint: 'Karis closest-point-on-sphere sun reflection disc. 0 = no disc, ~1.4 = baseline. Tinted by horizon-haze color so disc warmth tracks time of day',
  },
  {
    key: 'sunStreakStrength',
    label: 'Sun streak',
    min: 0,
    max: 3,
    step: 0.05,
    format: (n) => `${n.toFixed(2)}×`,
    hint: 'Anisotropic wave-front streak emissive. 0 = pure disc, ~0.8 = baseline. Higher values brighten the SoT low-sun streak across choppy water',
  },
  {
    key: 'streakElongation',
    label: 'Streak length',
    min: 0.1,
    max: 1.5,
    step: 0.02,
    format: (n) => n.toFixed(2),
    hint: 'σ_along of the 2D anisotropic Gaussian. Lower → more disc-like; higher → longer streak along the wave-front tangent. 0.4 = baseline',
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
        case 'pinchDirection':
          water.debug.setPinchDirection(v)
          break
        case 'waveBearing':
          water.debug.setWaveBearing(v)
          break
        case 'bodyAbsorption':
          water.debug.setBodyAbsorption(v)
          break
        case 'sunDiscStrength':
          water.debug.setSunDiscStrength(v)
          break
        case 'sunStreakStrength':
          water.debug.setSunStreakStrength(v)
          break
        case 'streakElongation':
          water.debug.setStreakElongation(v)
          break
        case 'shoreWaveStrength':
          water.debug.setShoreWaveStrength(v)
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

  // Colorize-by-layer toggle. Paints the center mesh red, the outer
  // LOD tile green, and the horizon skirt blue so the LOD boundaries
  // are obvious. Pairs with the water-test track's camera-locked
  // transition markers for diagnosing seams.
  const colorRow = document.createElement('div')
  colorRow.className = 'row toggle'
  const colorLabel = document.createElement('label')
  colorLabel.htmlFor = 'wd-colorize'
  colorLabel.textContent = 'Colorize layers'
  colorLabel.title =
    'Paint center mesh red, outer LOD tile green, horizon skirt blue — makes the LOD seams obvious'
  colorRow.appendChild(colorLabel)
  const colorInput = document.createElement('input')
  colorInput.type = 'checkbox'
  colorInput.id = 'wd-colorize'
  colorInput.checked = settings.colorize
  colorRow.appendChild(colorInput)
  body.appendChild(colorRow)
  colorInput.addEventListener('change', () => {
    settings.colorize = colorInput.checked
    water.debug.setColorize(colorInput.checked)
    persistWaterSettings(settings)
  })

  function syncUI(): void {
    for (const b of bound) {
      const v = settings[b.def.key]
      b.input.value = String(v)
      b.valEl.textContent = b.def.format(v)
    }
    wireInput.checked = settings.wireframe
    colorInput.checked = settings.colorize
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
