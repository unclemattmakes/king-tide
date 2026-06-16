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

import { WAVE_BEARING_DEFAULT, type WaterMesh } from './render/water'
import {
  applyWaterSettings,
  clearTrackOverrides,
  defaultsToSettings,
  diffLook,
  getWaterTuningScope,
  loadStoredWaterSettings,
  loadTrackOverrides,
  persistTrackOverrides,
  persistWaterSettings,
  WATER_SETTERS,
  type WaterDebugSettings,
  type WaterLookKey,
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
  {
    key: 'shoalSurf',
    label: 'Surf shoaling',
    min: 0,
    max: 1,
    step: 0.05,
    format: (n) => (n < 0.01 ? 'legacy' : n > 0.99 ? 'surf' : n.toFixed(2)),
    hint: 'Shoaling v2 (P3.1): 0 = legacy shallow-water fade-to-flat · 1 = real surf — swell stacks up (Green’s law) then breaks at the depth line (H/h ≈ 0.78); shore breakers scale with the live swell + set envelope and lean forward. CHANGES BUOYANCY near shores — sim + render move together',
  },
  {
    key: 'splashRings',
    label: 'Splash rings',
    min: 0,
    max: 1.5,
    step: 0.05,
    format: (n) => (n < 0.01 ? 'off' : `${n.toFixed(2)}\u00d7`),
    hint: 'P4.1 landing event waves: a hard water landing radiates an expanding ring other riders SEE and FEEL (sim-owned deterministic pool, mirrored to the GPU). Scales amplitude on both sides; 0 disables spawning too',
  },
  {
    key: 'contactFoam',
    label: 'Contact foam',
    min: 0,
    max: 2,
    step: 0.05,
    format: (n) => (n < 0.01 ? 'off' : `${n.toFixed(2)}\u00d7`),
    hint: 'Foam collars + outward wash ripples around waterline obstacles (bridge pillars, placed rocks, pylons \u2014 auto-discovered at load). Collars surge as each crest washes through; the contact splash bursts fire off the same crests. Render-only shading \u2014 never displaces water',
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
  {
    key: 'contourCoherence',
    label: 'Contour coherence',
    min: 0,
    max: 1,
    step: 0.05,
    format: (n) => n.toFixed(2),
    hint: 'Fix for contour lines SLIDING over the surface: iso-lines of the two-train swell sum sweep past the primary swell’s phase speed with sideways wobble wherever the trains’ slopes partially cancel (once per set-beat; unboundedly fast below the slope gate). 1 = key the ramp + contour field to the dominant swell only, so every line rides the primary swell at exactly its phase speed. 0 = legacy two-train field. A/B it in ?waterlab',
  },
  {
    key: 'contourCalmAtRest',
    label: 'Contour calm at rest',
    min: 0,
    max: 1,
    step: 0.05,
    format: (n) => (n < 0.01 ? 'off' : n.toFixed(2)),
    hint: 'Speed-couples Contour coherence: as the observer (camera) slows below ~11 m/s the effective coherence rises toward 1, so standing riders and the intro flyby see lines pinned to the primary swell — riding the crests instead of outrunning them — while the authored two-train liveliness returns at race speed. 1 = full calm when still · 0 = no coupling (legacy)',
  },
  {
    key: 'contourGate',
    label: 'Contour slope gate',
    min: 0,
    max: 1,
    step: 0.05,
    format: (n) => n.toFixed(2),
    hint: 'Raises the minimum face slope where contour lines draw (0 = legacy 0.02..0.06 window → 1 = 0.06..0.14). Iso-lines sweep at ∂h/∂t ÷ slope, so the flattest faces carry the fastest-sliding lines — raising the gate trims those first while steep faces keep their density cue',
  },
  {
    key: 'riseStroke',
    label: 'Rising strokes',
    min: 0,
    max: 2,
    step: 0.05,
    format: (n) => (n < 0.01 ? 'off' : `${n.toFixed(2)}×`),
    hint: 'Crest-PERPENDICULAR brush strokes climbing the leading (rising) face of an approaching wave — the vertical partner of the contour crest lines. Front-face gated (∂h/∂t), steep swell faces only, building up toward the crest. 0 = off · 0.5 = baseline',
  },
]

/** Look layers that A/B cleanly: 0 means "off / absent", so mute (→ 0) and
 *  solo (mute every other one of these) read as a real isolation. The rest are
 *  shape / time / modifier knobs with no clean "off", so they get no M/S. */
const MUTABLE_KEYS = new Set<WaterLookKey>([
  'reflectionStrength',
  'sunGlow',
  'detailStrength',
  'sunDiscStrength',
  'sunStreakStrength',
  'shoreWaveStrength',
  'whitecapCurvature',
  'foamWarmth',
  'foamStreak',
  'langmuir',
  'rampStrength',
  'contourStrength',
  'contourRelief',
  'contourBreakup',
  'riseStroke',
  'splashRings',
  'contactFoam',
  'wakeStrength',
])

/** Mixer sections — every rendered slider grouped under a header. The authored,
 *  non-persisted live rows (bearing + swell sets) render at the top of
 *  "Shape & motion". Keys not listed here aren't shown (the legacy whitecap
 *  height/slope/mode knobs). */
const SECTIONS: { title: string; keys: WaterLookKey[] }[] = [
  {
    title: 'Shape & motion',
    keys: [
      'steepness',
      'swellScale',
      'chopScale',
      'timeScale',
      'pinchDirection',
      'shoreWaveStrength',
      'shoalSurf',
    ],
  },
  {
    title: 'Lighting & body',
    keys: [
      'reflectionStrength',
      'sunGlow',
      'roughBase',
      'roughSparkle',
      'detailStrength',
      'bodyAbsorption',
      'sunDiscStrength',
      'sunStreakStrength',
      'streakElongation',
    ],
  },
  {
    title: 'Foam & whitecaps',
    keys: [
      'whitecapCurvature',
      'whitecapLeadBias',
      'foamWarmth',
      'foamStreak',
      'foamBrush',
      'foamWarp',
      'langmuir',
    ],
  },
  {
    title: 'Readability',
    keys: [
      'rampStrength',
      'rampSteps',
      'rampPosterize',
      'contourStrength',
      'contourSpacing',
      'contourRelief',
      'contourBreakup',
      'contourCoherence',
      'contourCalmAtRest',
      'contourGate',
      'riseStroke',
    ],
  },
  {
    title: 'Contacts & dynamic',
    keys: ['splashRings', 'contactFoam', 'wakeStrength'],
  },
]

/** Options for the water tuner install. `sceneNotes` tags knobs that can't act
 *  in the current scene (e.g. contact foam in the open-ocean lab — no obstacles). */
export type WaterDebugMenuOptions = {
  sceneNotes?: Partial<Record<WaterLookKey, string>>
}

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
export function installWaterDebugMenu(
  water: WaterMesh,
  opts: WaterDebugMenuOptions = {},
): WaterDebugMenu {
  const overlay = document.getElementById('water-debug')
  const toggle = document.getElementById('water-debug-toggle')
  const closeBtn = document.getElementById('wd-close')
  const resetBtn = document.getElementById('wd-reset')
  const body = document.getElementById('wd-body')
  if (!overlay || !toggle || !closeBtn || !resetBtn || !body) {
    return { open() {}, close() {}, isOpen: () => false }
  }

  const sceneNotes = opts.sceneNotes ?? {}
  const scope = getWaterTuningScope()
  const defaults = defaultsToSettings(water.debug.defaults)
  // Baseline = what this scene "ships": the machine-wide global store in the
  // lab, or defaults + the track's committed `water.look` in a level. Seed the
  // sliders from baseline + any machine-local working overrides, then mirror
  // that onto the mesh so panel + sea agree the moment it opens.
  const baseline: WaterDebugSettings =
    scope.kind === 'track'
      ? Object.assign({ ...defaults }, scope.committed)
      : loadStoredWaterSettings(water.debug.defaults)
  const settings: WaterDebugSettings = { ...baseline }
  if (scope.kind === 'track') Object.assign(settings, loadTrackOverrides(scope.slug))
  applyWaterSettings(water, settings)

  // Persist target depends on scope: per-slug working deltas in a level
  // (sparse — only what differs from this track's shipped look), or the
  // machine-wide store in the lab.
  function persist(): void {
    if (scope.kind === 'track') {
      persistTrackOverrides(scope.slug, diffLook(settings, baseline))
    } else {
      persistWaterSettings(settings)
    }
  }

  // ---- mixer state (session only — never persisted) -------------------
  // `muted` forces a layer to 0; `soloed` mutes every OTHER mutable layer.
  // Structural rows aren't mutable, so soloing a shading layer still rides the
  // live sea. settings[] keeps the real value, so mute is reversible and
  // export/persist reflect intent, not the muted 0.
  const muted = new Set<WaterLookKey>()
  const soloed = new Set<WaterLookKey>()
  function effective(key: WaterLookKey): number {
    if (muted.has(key)) return 0
    if (soloed.size > 0 && !soloed.has(key)) return 0
    return settings[key]
  }
  function applyKey(key: WaterLookKey): void {
    WATER_SETTERS[key](water, MUTABLE_KEYS.has(key) ? effective(key) : settings[key])
  }

  type Bound = {
    def: SliderDef
    input: HTMLInputElement
    valEl: HTMLElement
    row: HTMLElement
    muteBtn?: HTMLButtonElement
    soloBtn?: HTMLButtonElement
  }
  const bound: Bound[] = []

  function refreshMixerState(): void {
    const anySolo = soloed.size > 0
    for (const b of bound) {
      if (!MUTABLE_KEYS.has(b.def.key)) continue
      const off = muted.has(b.def.key) || (anySolo && !soloed.has(b.def.key))
      b.row.classList.toggle('mx-off', off)
      b.muteBtn?.classList.toggle('on', muted.has(b.def.key))
      b.soloBtn?.classList.toggle('on', soloed.has(b.def.key))
    }
  }
  function applyMixer(): void {
    for (const b of bound) if (MUTABLE_KEYS.has(b.def.key)) applyKey(b.def.key)
    refreshMixerState()
  }

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
  // Build one slider row — label (+ optional inert-scene tag), range, value,
  // and for the mute/solo-eligible look layers, M/S buttons. Drag updates the
  // stored value + mesh live; drag-end persists (scope-aware).
  function buildSliderRow(def: SliderDef): void {
    const row = document.createElement('div')
    row.className = 'row'

    const label = document.createElement('label')
    label.htmlFor = `wd-${def.key}`
    label.textContent = def.label
    if (def.hint) label.title = def.hint
    const note = sceneNotes[def.key]
    if (note) {
      const tag = document.createElement('span')
      tag.className = 'lab-note'
      tag.textContent = note
      tag.title = `Inert in this scene — ${note}. The knob works; it just has nothing to act on here.`
      label.appendChild(document.createTextNode(' '))
      label.appendChild(tag)
    }
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

    const b: Bound = { def, input, valEl, row }

    if (MUTABLE_KEYS.has(def.key)) {
      const mix = document.createElement('div')
      mix.className = 'mix'
      const muteBtn = document.createElement('button')
      muteBtn.type = 'button'
      muteBtn.className = 'mx-btn mx-mute'
      muteBtn.textContent = 'M'
      muteBtn.title = 'Mute — force this layer off (its intensity is remembered)'
      const soloBtn = document.createElement('button')
      soloBtn.type = 'button'
      soloBtn.className = 'mx-btn mx-solo'
      soloBtn.textContent = 'S'
      soloBtn.title = 'Solo — mute every other shading layer'
      mix.appendChild(muteBtn)
      mix.appendChild(soloBtn)
      row.appendChild(mix)
      b.muteBtn = muteBtn
      b.soloBtn = soloBtn
      muteBtn.addEventListener('click', () => {
        if (muted.has(def.key)) muted.delete(def.key)
        else muted.add(def.key)
        applyMixer()
      })
      soloBtn.addEventListener('click', () => {
        if (soloed.has(def.key)) soloed.delete(def.key)
        else soloed.add(def.key)
        applyMixer()
      })
    }

    body!.appendChild(row)
    bound.push(b)

    input.addEventListener('input', () => {
      const v = Number.parseFloat(input.value)
      if (!Number.isFinite(v)) return
      ;(settings as unknown as Record<string, number>)[def.key] = v
      valEl.textContent = def.format(v)
      applyKey(def.key)
    })
    input.addEventListener('change', persist)
  }

  // Build the mixer board section by section. The authored, non-persisted live
  // rows (bearing + swell sets) head up "Shape & motion" — each seeds from the
  // live mesh value and any drag lasts only for the session; persisting the
  // bearing was how a value dialed on one track silently re-aimed every other
  // track's swell (water-next-research §4.5). RESET doesn't touch them.
  const defByKey = new Map(SLIDERS.map((d) => [d.key, d] as const))
  SECTIONS.forEach((section, si) => {
    const h = document.createElement('h2')
    h.textContent = section.title
    body.appendChild(h)
    if (si === 0) {
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
    }
    for (const key of section.keys) {
      const def = defByKey.get(key)
      if (def) buildSliderRow(def)
    }
    // Crest sub-surface glow — a SoT lighting dial, so it rides with "Lighting
    // & body". Built as a LIVE row (not a SLIDERS/persisted knob): it talks
    // straight to the mesh debug surface, seeds at the shipped default (0 =
    // off, today's look) every session, and a drag lasts only for the session
    // — never persisted, so it can never silently bake a non-zero crest glow
    // into a track's or the machine's shipped water look. Dial it in
    // ?waterlab, eyeball it, then promote the chosen value to a real persisted
    // knob if it survives playtest.
    if (section.title === 'Lighting & body') {
      liveRow({
        id: 'crestSSSLive',
        label: 'Crest SSS glow',
        hint: 'SoT crest sub-surface glow: lerps wave PEAKS toward a brighter translucent tube-glow tint, gated by the choppiness peak mask × crest height — pinched crests read lit-from-within regardless of sun angle (deepens the shipped sun-backlit SSS). 0 = off (today’s look). Render-only; live session dial, NOT saved.',
        min: 0,
        max: 1,
        step: 0.05,
        get: () => water.debug.getCrestSSS(),
        set: (v) => water.debug.setCrestSSS(v),
        format: (n) => (n < 0.01 ? 'off' : n.toFixed(2)),
      })
    }
  })

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
    persist()
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
    persist()
  })

  function syncUI(): void {
    for (const b of bound) {
      const v = settings[b.def.key]
      b.input.value = String(v)
      b.valEl.textContent = b.def.format(v)
    }
    wireInput.checked = settings.wireframe
    colorInput.checked = settings.colorize
    refreshMixerState()
  }

  function open(): void {
    overlay!.classList.add('show')
  }
  function close(): void {
    overlay!.classList.remove('show')
  }

  // EXPORT — copy this scene's water block to the clipboard. The look is the
  // sparse diff-from-defaults (so it layers on the shipped global look); the
  // live bearing / swell-set authoring rides along. In a level it's the track's
  // `water` block, ready to paste into public/tracks/<slug>.json.
  const round = (n: number, p = 3): number => {
    const f = 10 ** p
    return Math.round(n * f) / f
  }
  function buildExportBlock(): string {
    const waterBlock: Record<string, unknown> = {}
    const bearing = water.debug.getWaveBearing()
    if (Math.abs(bearing - WAVE_BEARING_DEFAULT) > 0.5) {
      waterBlock.swellBearingDeg = round(bearing, 1)
    }
    const sset = water.debug.getSwellSet()
    if (sset.periodS > 0) {
      const sets: Record<string, number> = {
        periodS: round(sset.periodS, 2),
        depth: round(sset.depth, 3),
      }
      const phase = (sset as { phase?: number }).phase
      if (phase) sets.phase = round(phase, 3)
      waterBlock.swellSets = sets
    }
    const lookDiff = diffLook(settings, defaults)
    const lookKeys = Object.keys(lookDiff) as WaterLookKey[]
    if (lookKeys.length > 0) {
      const lookOut: Record<string, number> = {}
      for (const k of lookKeys) lookOut[k] = round(lookDiff[k] as number)
      waterBlock.look = lookOut
    }
    return JSON.stringify({ water: waterBlock }, null, 2)
  }
  const exportBtn = document.createElement('button')
  exportBtn.type = 'button'
  exportBtn.className = 'action secondary'
  exportBtn.id = 'wd-export'
  exportBtn.textContent = 'EXPORT'
  exportBtn.title =
    scope.kind === 'track'
      ? `Copy this track's water block → paste into public/tracks/${scope.slug}.json`
      : 'Copy the current water look as a JSON block'
  resetBtn.parentElement?.insertBefore(exportBtn, resetBtn)
  let exportFlash = 0
  exportBtn.addEventListener('click', () => {
    const json = buildExportBlock()
    void navigator.clipboard?.writeText(json)
    const dest = scope.kind === 'track' ? `public/tracks/${scope.slug}.json` : '(global look)'
    console.log(`[water] export → ${dest}\n${json}`)
    exportBtn.textContent = 'COPIED ✓'
    window.clearTimeout(exportFlash)
    exportFlash = window.setTimeout(() => {
      exportBtn.textContent = 'EXPORT'
    }, 1200)
  })

  toggle.addEventListener('click', open)
  closeBtn.addEventListener('click', close)
  resetBtn.addEventListener('click', () => {
    // Track scope: drop the per-slug working overrides → back to this track's
    // shipped look (defaults + committed). Lab: back to constructor defaults.
    if (scope.kind === 'track') {
      clearTrackOverrides(scope.slug)
      Object.assign(settings, baseline)
    } else {
      Object.assign(settings, defaultsToSettings(water.debug.defaults))
    }
    muted.clear()
    soloed.clear()
    applyWaterSettings(water, settings)
    syncUI()
    persist()
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
