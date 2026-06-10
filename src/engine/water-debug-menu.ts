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
  // (Wave bearing is NOT in this table: it's track-authored data
  // (`water.swellBearingDeg`), so its slider is a hand-built live-only
  // row below — applied on drag, never persisted.)
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
  // Foam coverage — where whitecaps fire (foam v3, curvature-based). Foam fires
  // on crest CURVATURE biased to the wave's leading edge, so it reads as a thin
  // forward-loaded cap ON the crest instead of the old wide "white bar". See
  // docs/water-foam-look-plan.md. (The legacy height/slope/mode knobs were
  // retired from this menu — they no longer affect the wave whitecap.)
  {
    key: 'whitecapCurvature',
    label: 'Foam curvature',
    min: 0,
    max: 12,
    step: 0.25,
    format: (n) => `${n.toFixed(2)}×`,
    hint: 'Gain on the crest-curvature signal — the primary whitecap control. Higher = foam on gentler crests (more coverage); lower = only the sharpest breaking crests. 4 = baseline. Foam sits as a thin line on the crest, not a wide band',
  },
  {
    key: 'whitecapLeadBias',
    label: 'Foam lead bias',
    min: 0,
    max: 1,
    step: 0.05,
    format: (n) => (n < 0.01 ? 'sym' : n > 0.99 ? 'front' : n.toFixed(2)),
    hint: 'Push the whitecap onto the wave\'s leading (rising/front) face via ∂h/∂t. 0 = symmetric crest line · 1 = front-only ("breaking forward"). 1 = baseline',
  },
  {
    key: 'foamWarmth',
    label: 'Foam warmth',
    min: 0,
    max: 2,
    step: 0.05,
    format: (n) => `${n.toFixed(2)}×`,
    hint: 'Light-driven warm tint + warm emissive bloom on sun-raked foam. 0 = flat white foam (legacy) · 1 = baseline sunset-kissed crests. Follows the sky tint, so near-neutral at midday and warm at golden/sunset',
  },
  {
    key: 'foamStreak',
    label: 'Foam streaks',
    min: 0,
    max: 2,
    step: 0.05,
    format: (n) => `${n.toFixed(2)}×`,
    hint: 'Brushstroke foam bands on the wave faces, running along the local crest line. 0 = isotropic round bubbles only (legacy) · 1 = baseline streaks. Only applies on sloped faces, fades at distance',
  },
  {
    key: 'foamBrush',
    label: 'Foam brush',
    min: 0,
    max: 1,
    step: 0.05,
    format: (n) => (n < 0.01 ? 'discs' : n > 0.99 ? 'oil' : n.toFixed(2)),
    hint: 'Foam break-up pattern: 0 = round bubble discs (legacy) · 1 = oil-paint brush strokes pulled along the crest lines (the engine-trail painted read). Fringes and thin foam dissolve into tapered strokes; solid foam cores stay solid',
  },
  {
    key: 'foamWarp',
    label: 'Foam warp',
    min: 0,
    max: 2,
    step: 0.05,
    format: (n) => `${n.toFixed(2)}×`,
    hint: 'P2.3 tangential warp: wobbles the foam break-up pattern ALONG the crest axis (±4 m at 1×) so stroke/bubble rows bend organically instead of running straight forever. Never warps travel/height — those carry the steepness signal',
  },
  {
    key: 'langmuir',
    label: 'Langmuir lanes',
    min: 0,
    max: 1.5,
    step: 0.05,
    format: (n) => (n < 0.01 ? 'off' : `${n.toFixed(2)}×`),
    hint: 'P2.3 windrow lanes: faint brightness streaks aligned WITH the swell travel direction, only on calm low-slope water — the "which way is the sea moving" prime where no crest/foam cue fires. Brightness-only (never displaces geometry)',
  },
  {
    key: 'wakeStrength',
    label: 'Bike wake',
    min: 0,
    max: 2,
    step: 0.05,
    format: (n) => `${n.toFixed(2)}×`,
    hint: "Trail-wake strength: the churn + edge-rail foam laid along each bike's ridden path AND its V-ridge displacement. 1 = baseline · 0 = no drawn wake (buoyancy still feels the sim wake — dev setting only)",
  },
  // P1 readability layers (water-next-research §8 P1) — the live knobs are
  // the point: the 2026-06-06 cel session was lost partly because its hooks
  // were console-only.
  {
    key: 'rampStrength',
    label: 'Value ramp',
    min: 0,
    max: 1,
    step: 0.05,
    format: (n) => n.toFixed(2),
    hint: 'Crest-to-trough brightness sweep ("one value sweep per wave face" — the Wave Race lesson). Keyed to the swell-only field so chop never carves it. 0 = off',
  },
  {
    key: 'rampSteps',
    label: 'Ramp bands',
    min: 2,
    max: 5,
    step: 1,
    format: (n) => n.toFixed(0),
    hint: 'Posterize band count for the value ramp. Band boundaries are the readability signal (cel-session + perception research)',
  },
  {
    key: 'rampPosterize',
    label: 'Ramp posterize',
    min: 0,
    max: 1,
    step: 0.05,
    format: (n) => n.toFixed(2),
    hint: '0 = continuous gradient, 1 = hard quantized bands. Mid values keep a hint of band edge over a smooth sweep',
  },
  {
    key: 'contourStrength',
    label: 'Contour lines',
    min: 0,
    max: 1.5,
    step: 0.05,
    format: (n) => n.toFixed(2),
    hint: 'Iso-height foam lines off the swell-only field — they pack together where the face steepens (line density IS the steepness cue). fwidth-thinned, fade when crowded, every 3rd heavier. 0 = off',
  },
  {
    key: 'contourSpacing',
    label: 'Contour spacing',
    min: 0.2,
    max: 1.5,
    step: 0.05,
    format: (n) => `${n.toFixed(2)} m`,
    hint: 'Vertical interval between contour lines, metres. Smaller = more lines per face = finer height reading (and earlier crowd-fade at distance)',
  },
  {
    key: 'contourRelief',
    label: 'Contour relief',
    min: 0,
    max: 1,
    step: 0.05,
    format: (n) => n.toFixed(2),
    hint: 'Wind-Waker light/dark pair: a dark-teal twin line offset away from the sun beside each light line — the cheap embossed-relief read. 0 = light lines only',
  },
  {
    key: 'contourBreakup',
    label: 'Contour breakup',
    min: 0,
    max: 1,
    step: 0.05,
    format: (n) => n.toFixed(2),
    hint: 'Breaks the iso lines into crest-aligned brush dashes — gentle nicks near the crests, near-total in the troughs so lines cling to the crests instead of running the whole sea. 0 = solid unbroken lines',
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

  // Live-only rows — hand-built, deliberately outside the SLIDERS table +
  // persistence: these knobs are per-track AUTHORED data (track JSON keys,
  // applied at boot), so each seeds from the live mesh value and any drag
  // lasts only for the session. Persisting the bearing was how a value
  // dialed on one track silently re-aimed every other track's swell on
  // that machine (water-next-research §4.5); the wave-set rows follow the
  // same rule. RESET doesn't touch them either — "default" here means
  // "what the track authored", which is already what boot applied.
  const liveRow = (opts: {
    id: string
    label: string
    hint: string
    min: number
    max: number
    step: number
    get: () => number
    set: (v: number) => void
    format: (n: number) => string
  }): void => {
    const row = document.createElement('div')
    row.className = 'row'
    const label = document.createElement('label')
    label.htmlFor = `wd-${opts.id}`
    label.textContent = opts.label
    label.title = opts.hint
    row.appendChild(label)
    const input = document.createElement('input')
    input.type = 'range'
    input.id = `wd-${opts.id}`
    input.min = String(opts.min)
    input.max = String(opts.max)
    input.step = String(opts.step)
    input.value = String(opts.get())
    row.appendChild(input)
    const valEl = document.createElement('span')
    valEl.className = 'val'
    valEl.textContent = opts.format(opts.get())
    row.appendChild(valEl)
    body.appendChild(row)
    input.addEventListener('input', () => {
      const v = Number.parseFloat(input.value)
      if (!Number.isFinite(v)) return
      opts.set(v)
      valEl.textContent = opts.format(v)
    })
  }
  liveRow({
    id: 'waveBearingLive',
    label: 'Wave bearing',
    hint: 'Global wave-train direction (CCW from world +X). Authored per track via water.swellBearingDeg — this slider is a live session override and is NOT saved. Render + CPU buoyancy track together.',
    min: -180,
    max: 180,
    step: 1,
    get: () => water.debug.getWaveBearing(),
    set: (v) => water.debug.setWaveBearing(v),
    format: (n) => `${n.toFixed(0)}°`,
  })
  liveRow({
    id: 'swellSetPeriodLive',
    label: 'Set period',
    hint: 'Wave-set envelope period, seconds between set peaks (0 = off). Sea breathes ±depth around its static state; buoyancy follows. Authored per track via water.swellSets — live override, NOT saved.',
    min: 0,
    max: 120,
    step: 1,
    get: () => water.debug.getSwellSet().periodS,
    set: (v) => water.debug.setSwellSetPeriod(v),
    format: (n) => (n > 0 ? `${n.toFixed(0)} s` : 'off'),
  })
  liveRow({
    id: 'swellSetDepthLive',
    label: 'Set depth',
    hint: 'Wave-set envelope amplitude swing, 0..0.6 (0.3 → sea breathes between 0.7× and 1.3×). Authored per track via water.swellSets — live override, NOT saved.',
    min: 0,
    max: 0.6,
    step: 0.05,
    get: () => water.debug.getSwellSet().depth,
    set: (v) => water.debug.setSwellSetDepth(v),
    format: (n) => n.toFixed(2),
  })

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
        case 'whitecapCurvature':
          water.debug.setWhitecapCurvature(v)
          break
        case 'whitecapLeadBias':
          water.debug.setWhitecapLeadBias(v)
          break
        case 'foamWarmth':
          water.debug.setFoamWarmth(v)
          break
        case 'foamStreak':
          water.debug.setFoamStreak(v)
          break
        case 'foamBrush':
          water.debug.setFoamBrush(v)
          break
        case 'foamWarp':
          water.debug.setFoamWarp(v)
          break
        case 'langmuir':
          water.debug.setLangmuir(v)
          break
        case 'wakeStrength':
          water.debug.setWakeStrength(v)
          break
        case 'rampStrength':
          water.debug.setRampStrength(v)
          break
        case 'rampSteps':
          water.debug.setRampSteps(v)
          break
        case 'rampPosterize':
          water.debug.setRampPosterize(v)
          break
        case 'contourStrength':
          water.debug.setContourStrength(v)
          break
        case 'contourSpacing':
          water.debug.setContourSpacing(v)
          break
        case 'contourRelief':
          water.debug.setContourRelief(v)
          break
        case 'contourBreakup':
          water.debug.setContourBreakup(v)
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
