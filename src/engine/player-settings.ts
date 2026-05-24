/**
 * Player-facing settings (Audio / Video / Controls / Gameplay).
 *
 * Distinct from `dev-settings.ts`, which carries input-feel knobs that
 * only show up in the Dev Settings overlay. The values here back the
 * Settings overlay tabs and survive page reloads via localStorage.
 *
 * Each row in the Settings overlay (see `settings-overlay.ts`) reads /
 * writes a field on the `playerSettings` mutable object, then calls
 * `savePlayerSettings()` to persist. Render systems import the same
 * object so changes apply live without a reload.
 *
 * Schema versioning: bump `STORAGE_KEY` when a field's shape changes
 * (rename / type change) so stale blobs are ignored instead of
 * mis-coerced.
 */

import type { ColorblindMode } from './accessibility/palettes'
import {
  cloneGamepadBindings,
  cloneKeyboardBindings,
  defaultGamepadBindings,
  defaultKeyboardBindings,
  type GamepadBindings,
  type KeyboardBindings,
  parseGamepadBindings,
  parseKeyboardBindings,
} from './input/bindings'

// Bumped to v2 with the M-Step-8 accessibility fields. The load path
// remains tolerant — old v1 blobs would simply be ignored at the key
// level (different key), letting defaults win. If users hand-rolled v1
// state, they get a one-time reset to defaults which is fine for a
// pre-release build.
const STORAGE_KEY = 'hoverbike.playerSettings.v2'

export type { ColorblindMode }

/** Wave-pump prompt intensity — see the work-breakdown for the
 *  definition-of-done convention.
 *
 *  - `full`:    HUD widget flashes + audio cue plays
 *  - `subtle`:  small pulse dot + audio cue (quieter UI footprint)
 *  - `off`:     no HUD widget, no audio cue
 */
export type WavePumpIntensity = 'full' | 'subtle' | 'off'

/** AI difficulty — three tiers, plus a rubber-band assist toggle (see
 *  `rubberBandAssist`). The tuning bundles live in
 *  `src/game/ai/difficulty.ts` and are baked into each AI's controller
 *  at spawn time, so a difficulty change takes effect on the next race.
 *  The rubber-band toggle gates the per-tick assist in
 *  `rubber-band.ts`, so it can be flipped mid-race. */
export type AIDifficulty = 'casual' | 'standard' | 'hard'

/** Anti-grav camera intensity. The chase camera blends between its
 *  default yaw-only frame (no follow) and a full bike-frame follow
 *  during anti-grav sections; intensity scales how much it leans into
 *  the follow. Lower settings reduce the apparent roll → motion
 *  sickness mitigation knob.
 *
 *  - `full`:    100% roll-follow scalar (full inversion on loops)
 *  - `reduced`: ~40% — hints at the roll without inverting
 *  - `off`:     no roll-follow; camera stays yaw-only even on loops
 */
export type AntiGravCameraIntensity = 'full' | 'reduced' | 'off'

/** Emissive-landmarks intensity. Currently drives the lava-river runtime
 *  shader (Kilauea's hero waterfall + any future track that drops a
 *  `landmark_lava_river_strip` instance). Off falls back to the GLB's
 *  flat baked material so low-end GPUs or motion-sensitive players
 *  aren't forced to render the glow pass. The same knob is the future
 *  home for any other emissive-mask landmark material that lands.
 *
 *  - `full`:    full hot-core emissive boost
 *  - `reduced`: ~50% — visible glow without bloom-saturating the framebuffer
 *  - `off`:     no emissive contribution; lava reads as a flat band
 */
export type EmissiveLandmarksIntensity = 'full' | 'reduced' | 'off'

/** Tuck VFX intensity — the slipstream streaks that fan off the bike as
 *  the player leans into the tuck sweet spot (see the tuck mechanic in
 *  [hover.ts](./game/systems/hover.ts) + the `tuckStream` pool in
 *  [fx/index.ts](./render/fx/index.ts)). Render-only; the emission rate
 *  already tracks the live tuck factor, so this knob is the global
 *  ceiling on top of that.
 *
 *  - `full`:   streaks at full emission rate / size
 *  - `subtle`: ~half rate — a hint of slipstream without the fan
 *  - `off`:    no tuck particles at all
 */
export type TuckVfxIntensity = 'full' | 'subtle' | 'off'

/** Pre-lap track introduction — cinematic camera shots + F1 start-lights
 *  before the race countdown arms. See
 *  [race-intro.ts](./render/race-intro.ts).
 *
 *  - `full`:    three shots — aerial pan, racing-line skim, descent (~8 s)
 *  - `short`:   single descent shot (~2 s) before the lights sequence
 *  - `off`:     skip the cinematic; start-lights still replace the 3/2/1
 *               banner so the F1-style countdown is preserved
 */
export type PreLapIntroMode = 'full' | 'short' | 'off'

export type PlayerSettings = {
  wavePumpIntensity: WavePumpIntensity
  aiDifficulty: AIDifficulty
  /** Rubber-band assist toggle. When false, `rubberBandSystem` is a
   *  no-op (modulo settling AI back to baseline) — AI no longer
   *  catches up after falling behind. */
  rubberBandAssist: boolean
  antiGravCameraIntensity: AntiGravCameraIntensity
  /** Emissive-landmarks intensity — see `EmissiveLandmarksIntensity`. */
  emissiveLandmarks: EmissiveLandmarksIntensity
  /** Tuck slipstream VFX intensity — see `TuckVfxIntensity`. */
  tuckVfxIntensity: TuckVfxIntensity
  /** Tuck meter HUD — the accuracy gauge that shows the live tuck factor
   *  + sweet-spot target. On by default (it's a teaching aid); players who
   *  have internalised the timing can switch it off. */
  tuckMeter: boolean
  /** Subtitles for the tutorial framework's prompt callouts.
   *  Affects only the tutorial HUD widget — race callouts and pump
   *  feedback are unaffected. */
  tutorialSubtitles: boolean
  /** Latch — flips to true the first time the player completes the
   *  tutorial cleanly. Cheap onboarding flag the menu/settings reads to
   *  show "REPLAY TUTORIAL" instead of "RUN TUTORIAL". */
  tutorialCompleted: boolean
  /** Audio mixer — four buses each storing a 0..1 slider value. Read
   *  per-frame by the AudioEngine via `busLevel(bus)`, which applies
   *  per-bus headroom on top so slider=1.0 maps to a comfortable
   *  ceiling instead of pinning to 0dB. */
  audioMasterVolume: number
  audioMusicVolume: number
  audioSfxVolume: number
  audioAmbientVolume: number
  /** Procedural music bed enable. When off the music bus stays
   *  routed but the bed nodes are muted via `musicBedGain` — keeps
   *  the licensed-music swap point a one-liner. */
  audioMusicEnabled: boolean
  /** Player-rebindable keyboard mapping. See `input/bindings.ts` for
   *  the action set + swap-on-rebind semantics. */
  keyboardBindings: KeyboardBindings
  /** Player-rebindable gamepad buttons (fire / boost only — sticks +
   *  triggers stay on the W3C standard mapping). */
  gamepadBindings: GamepadBindings
  /** Left-stick magnitude below which steer / pitch read as zero. */
  gamepadDeadzone: number
  /** Output multiplier applied to the deadzone-shaped stick magnitude,
   *  clamped to [-1, 1]. 1.0 = current shaped curve; >1 saturates
   *  earlier (twitchier); <1 caps below full deflection (softer). */
  gamepadSensitivity: number
  /** When true, dragging the mouse / pushing the right stick up tilts
   *  the camera **down** (flight-stick convention). Default false keeps
   *  the existing "push up = look up" feel. */
  invertCameraY: boolean
  /** Time Trial → local leaderboard submission. When on, a TT PB
   *  writes an entry to the per-track top-N board (see
   *  `leaderboard-state.ts`). When off, ghosts still save but no
   *  leaderboard entry is created. Defaults on — the surface is the
   *  Gameplay → "Submit times to leaderboard" toggle. */
  leaderboardSubmit: boolean
  /** Free-form alphanumeric handle (uppercased, ≤12 chars) used when a
   *  TT PB submits to the local leaderboard. Empty means "no handle
   *  set yet"; the writer falls back to `'YOU'` for the entry but the
   *  Settings → Leaderboard handle row prompts the player to pick a
   *  real one. */
  leaderboardHandle: string
  /** Accessibility — colorblind-aware HUD palette swap. The 'off'
   *  default preserves the current ship colors; the three named modes
   *  switch into hand-picked safe palettes from
   *  `accessibility/palettes.ts`. Affects the minimap dot colors today;
   *  CSS rules in `index.html` also pick up via `body[data-cb=…]`. */
  colorblindMode: ColorblindMode
  /** Accessibility — dampens HUD flash effects (wave-pump pulse,
   *  countdown pop, anti-grav glow). CSS rule in `index.html` kills
   *  the relevant `animation` properties via `body[data-reduced-flash=1]`. */
  reducedFlash: boolean
  /** Accessibility — scales HUD font sizes by 1.25× via a CSS rule
   *  driven by `body[data-large-text=1]`. */
  largeText: boolean
  /** Accessibility — forces opaque HUD shells + white text via a CSS
   *  rule driven by `body[data-high-contrast=1]`. Trades aesthetic for
   *  maximum legibility against any background. */
  highContrast: boolean
  /** Accessibility — forces the prefers-reduced-motion rules ON
   *  regardless of the OS setting. Useful for users on systems that
   *  don't expose the preference, or who want it for the game only. */
  reducedMotion: boolean
  /** Accessibility — dampens chase-cam roll + anti-grav inversion. A
   *  separate-but-related knob to `antiGravCameraIntensity`; render
   *  systems multiply their roll output by 0.5 when this is on. */
  motionSicknessReduction: boolean
  /** Accessibility — scalar in `[0..1]` multiplied into any screen
   *  shake amount (HUD shake, camera kick). `1.0` keeps the current
   *  feel; `0` disables shake entirely. */
  screenShakeIntensity: number
  /** Accessibility — keep the tutorial subtitle line visible during
   *  any captioned cue, not just during the tutorial flow. Layered
   *  on top of `tutorialSubtitles`, which controls *only* the
   *  tutorial-mode hint chyron. */
  subtitlesAlwaysOn: boolean
  /** Video — frame-rate cap in fps. `0` = Unlimited (rAF gate off, the
   *  browser paces to vsync). Non-zero values gate the
   *  `renderer.render()` + perf-HUD work behind a wall-clock deadline;
   *  fixed-step sim is unaffected so determinism is preserved.
   *
   *  The Steam Deck profile (`applyDeckProfile()` in
   *  `src/engine/steam-deck.ts`) writes `60` here so Gaming-Mode boots
   *  fit the LCD panel + the ≤12 W battery target without the player
   *  touching Settings. */
  framerateCap: number
  /** Video — render-pixel ratio. Scales the off-screen framebuffer
   *  relative to the canvas CSS size. `1.0` = native, `0.75` ≈ 56% of
   *  pixels, `0.5` ≈ 25%. The renderer caps the actual ratio at
   *  `min(devicePixelRatio, 2)` so this value is a *requested ceiling*
   *  rather than a guarantee on hi-DPI screens. */
  pixelRatio: number
  /** Video — when true the boot path requests fullscreen on the first
   *  user gesture. Default off; the Steam Deck profile flips it on so
   *  Gaming Mode launches don't strand the player in a windowed view. */
  fullscreenPreferred: boolean
  /** Video — when true the runtime drives ``landmark_mechanical_rig``
   *  arm subtrees with a per-instance sin pendulum. Off pins every arm
   *  to its authored rest pose; flipping it on resumes from the live
   *  ``elapsedSeconds`` (no jump). Render-only; arm trimesh colliders
   *  are static in either state. */
  animatedLandmarks: boolean
  /** Pre-lap track introduction mode — see `PreLapIntroMode`. The
   *  cinematic establishing shots play single-player only; the F1-style
   *  start-lights are used in every mode (the banner is suppressed
   *  whenever `preLapIntro !== 'off'` is honoured). Multiplayer skips
   *  the camera fly-by because the lobby gate already owns the pre-race
   *  beat — flipping this off in MP only hides the lights. */
  preLapIntro: PreLapIntroMode
}

export const DEFAULT_PLAYER_SETTINGS: Readonly<PlayerSettings> = Object.freeze({
  wavePumpIntensity: 'full',
  aiDifficulty: 'standard',
  rubberBandAssist: true,
  antiGravCameraIntensity: 'full',
  emissiveLandmarks: 'full',
  tuckVfxIntensity: 'full',
  tuckMeter: true,
  tutorialSubtitles: true,
  tutorialCompleted: false,
  audioMasterVolume: 0.8,
  audioMusicVolume: 0.55,
  audioSfxVolume: 0.85,
  audioAmbientVolume: 0.7,
  audioMusicEnabled: true,
  keyboardBindings: defaultKeyboardBindings(),
  gamepadBindings: defaultGamepadBindings(),
  gamepadDeadzone: 0.12,
  gamepadSensitivity: 1.0,
  invertCameraY: false,
  leaderboardSubmit: true,
  leaderboardHandle: '',
  // Accessibility defaults all preserve the current ship behavior so
  // shipping this PR is a pure add — no user sees a behavior change
  // until they opt in via the new tab.
  colorblindMode: 'off',
  reducedFlash: false,
  largeText: false,
  highContrast: false,
  reducedMotion: false,
  motionSicknessReduction: false,
  screenShakeIntensity: 1.0,
  subtitlesAlwaysOn: false,
  // Video / platform defaults preserve current shipping behaviour. The
  // Steam Deck profile mutates these via the dedicated setters so a
  // detection flip lights up the persisted UI rows.
  framerateCap: 0,
  pixelRatio: 1.0,
  fullscreenPreferred: false,
  animatedLandmarks: true,
  preLapIntro: 'full',
})

/** Live, mutable copy. Consumers read this object every frame — no
 *  observer needed because reads are O(1) and the surface area is
 *  small. Writes go through the setter helpers so persistence stays
 *  honest. Nested objects (bindings) are cloned so a setter mutating
 *  the live copy doesn't trample the frozen defaults. */
export const playerSettings: PlayerSettings = {
  ...DEFAULT_PLAYER_SETTINGS,
  keyboardBindings: cloneKeyboardBindings(DEFAULT_PLAYER_SETTINGS.keyboardBindings),
  gamepadBindings: cloneGamepadBindings(DEFAULT_PLAYER_SETTINGS.gamepadBindings),
}

const VALID_WAVE_PUMP_INTENSITY: WavePumpIntensity[] = ['full', 'subtle', 'off']
const VALID_AI_DIFFICULTY: AIDifficulty[] = ['casual', 'standard', 'hard']
const VALID_ANTI_GRAV_CAMERA: AntiGravCameraIntensity[] = ['full', 'reduced', 'off']
const VALID_EMISSIVE_LANDMARKS: EmissiveLandmarksIntensity[] = ['full', 'reduced', 'off']
const VALID_PRE_LAP_INTRO: PreLapIntroMode[] = ['full', 'short', 'off']
const VALID_COLORBLIND_MODE: ColorblindMode[] = ['off', 'deuteranopia', 'protanopia', 'tritanopia']

/** Roll-follow scalar each intensity step contributes — multiplied by
 *  the live AntiGravOverride weight to get the per-frame camera follow
 *  weight passed to `ChaseCamera.setAntiGravFollow`. */
export const ANTI_GRAV_CAMERA_SCALAR: Readonly<Record<AntiGravCameraIntensity, number>> =
  Object.freeze({
    full: 1.0,
    reduced: 0.4,
    off: 0,
  })

/** Emissive intensity multiplier each landmark-emissive step contributes.
 *  Multiplied into the lava material's hot-core ↔ band-edge gradient at
 *  the `emissive` output, so `off` collapses the contribution to zero
 *  (the band reads as flat albedo) and `full` is the trailer-shot glow. */
export const EMISSIVE_LANDMARKS_SCALAR: Readonly<Record<EmissiveLandmarksIntensity, number>> =
  Object.freeze({
    full: 1.0,
    reduced: 0.5,
    off: 0,
  })

const VALID_TUCK_VFX: TuckVfxIntensity[] = ['full', 'subtle', 'off']

/** Global ceiling on the tuck slipstream emission, multiplied into the
 *  live (per-frame) tuck factor before the rate / size are computed. `off`
 *  collapses emission to zero; `subtle` halves it. */
export const TUCK_VFX_SCALAR: Readonly<Record<TuckVfxIntensity, number>> = Object.freeze({
  full: 1.0,
  subtle: 0.5,
  off: 0,
})

/** Restore persisted values into `playerSettings`. Tolerant of missing
 *  fields and of schema drift — anything missing or invalid keeps the
 *  default. Safe to call multiple times. */
export function loadPlayerSettings(): void {
  let parsed: unknown
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object') return
  const p = parsed as Record<string, unknown>
  if (
    typeof p.wavePumpIntensity === 'string' &&
    (VALID_WAVE_PUMP_INTENSITY as string[]).includes(p.wavePumpIntensity)
  ) {
    playerSettings.wavePumpIntensity = p.wavePumpIntensity as WavePumpIntensity
  }
  if (
    typeof p.aiDifficulty === 'string' &&
    (VALID_AI_DIFFICULTY as string[]).includes(p.aiDifficulty)
  ) {
    playerSettings.aiDifficulty = p.aiDifficulty as AIDifficulty
  }
  if (typeof p.rubberBandAssist === 'boolean') {
    playerSettings.rubberBandAssist = p.rubberBandAssist
  }
  if (
    typeof p.antiGravCameraIntensity === 'string' &&
    (VALID_ANTI_GRAV_CAMERA as string[]).includes(p.antiGravCameraIntensity)
  ) {
    playerSettings.antiGravCameraIntensity = p.antiGravCameraIntensity as AntiGravCameraIntensity
  }
  if (
    typeof p.tuckVfxIntensity === 'string' &&
    (VALID_TUCK_VFX as string[]).includes(p.tuckVfxIntensity)
  ) {
    playerSettings.tuckVfxIntensity = p.tuckVfxIntensity as TuckVfxIntensity
  }
  if (typeof p.tuckMeter === 'boolean') {
    playerSettings.tuckMeter = p.tuckMeter
  }
  if (
    typeof p.emissiveLandmarks === 'string' &&
    (VALID_EMISSIVE_LANDMARKS as string[]).includes(p.emissiveLandmarks)
  ) {
    playerSettings.emissiveLandmarks = p.emissiveLandmarks as EmissiveLandmarksIntensity
  }
  if (typeof p.tutorialSubtitles === 'boolean') {
    playerSettings.tutorialSubtitles = p.tutorialSubtitles
  }
  if (typeof p.tutorialCompleted === 'boolean') {
    playerSettings.tutorialCompleted = p.tutorialCompleted
  }
  const loadVol = (key: keyof PlayerSettings, val: unknown) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return
    const clamped = Math.max(0, Math.min(1, val))
    ;(playerSettings as Record<string, unknown>)[key as string] = clamped
  }
  loadVol('audioMasterVolume', p.audioMasterVolume)
  loadVol('audioMusicVolume', p.audioMusicVolume)
  loadVol('audioSfxVolume', p.audioSfxVolume)
  loadVol('audioAmbientVolume', p.audioAmbientVolume)
  if (typeof p.audioMusicEnabled === 'boolean') {
    playerSettings.audioMusicEnabled = p.audioMusicEnabled
  }
  playerSettings.keyboardBindings = parseKeyboardBindings(p.keyboardBindings)
  playerSettings.gamepadBindings = parseGamepadBindings(p.gamepadBindings)
  if (typeof p.gamepadDeadzone === 'number' && Number.isFinite(p.gamepadDeadzone)) {
    playerSettings.gamepadDeadzone = Math.max(0, Math.min(0.5, p.gamepadDeadzone))
  }
  if (typeof p.gamepadSensitivity === 'number' && Number.isFinite(p.gamepadSensitivity)) {
    playerSettings.gamepadSensitivity = Math.max(0.5, Math.min(3.0, p.gamepadSensitivity))
  }
  if (typeof p.invertCameraY === 'boolean') {
    playerSettings.invertCameraY = p.invertCameraY
  }
  if (typeof p.leaderboardSubmit === 'boolean') {
    playerSettings.leaderboardSubmit = p.leaderboardSubmit
  }
  if (typeof p.leaderboardHandle === 'string') {
    // Re-normalize at load so a hand-edited blob can't smuggle in
    // forbidden characters or oversize strings.
    const cleaned = p.leaderboardHandle
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '')
      .slice(0, 12)
    playerSettings.leaderboardHandle = cleaned
  }
  if (
    typeof p.colorblindMode === 'string' &&
    (VALID_COLORBLIND_MODE as string[]).includes(p.colorblindMode)
  ) {
    playerSettings.colorblindMode = p.colorblindMode as ColorblindMode
  }
  if (typeof p.reducedFlash === 'boolean') {
    playerSettings.reducedFlash = p.reducedFlash
  }
  if (typeof p.largeText === 'boolean') {
    playerSettings.largeText = p.largeText
  }
  if (typeof p.highContrast === 'boolean') {
    playerSettings.highContrast = p.highContrast
  }
  if (typeof p.reducedMotion === 'boolean') {
    playerSettings.reducedMotion = p.reducedMotion
  }
  if (typeof p.motionSicknessReduction === 'boolean') {
    playerSettings.motionSicknessReduction = p.motionSicknessReduction
  }
  if (typeof p.screenShakeIntensity === 'number' && Number.isFinite(p.screenShakeIntensity)) {
    playerSettings.screenShakeIntensity = Math.max(0, Math.min(1, p.screenShakeIntensity))
  }
  if (typeof p.subtitlesAlwaysOn === 'boolean') {
    playerSettings.subtitlesAlwaysOn = p.subtitlesAlwaysOn
  }
  if (typeof p.framerateCap === 'number' && Number.isFinite(p.framerateCap)) {
    // Clamp to a sane envelope. 0 means Unlimited. Anything outside
    // [30, 240] is almost certainly a malformed save.
    const v = p.framerateCap
    playerSettings.framerateCap = v <= 0 ? 0 : Math.max(30, Math.min(240, v))
  }
  if (typeof p.pixelRatio === 'number' && Number.isFinite(p.pixelRatio)) {
    playerSettings.pixelRatio = Math.max(0.5, Math.min(2.0, p.pixelRatio))
  }
  if (typeof p.fullscreenPreferred === 'boolean') {
    playerSettings.fullscreenPreferred = p.fullscreenPreferred
  }
  if (typeof p.animatedLandmarks === 'boolean') {
    playerSettings.animatedLandmarks = p.animatedLandmarks
  }
  if (
    typeof p.preLapIntro === 'string' &&
    (VALID_PRE_LAP_INTRO as string[]).includes(p.preLapIntro)
  ) {
    playerSettings.preLapIntro = p.preLapIntro as PreLapIntroMode
  }
  // Apply accessibility settings to the DOM as early as we can after
  // load. Lazy-imported so `player-settings.ts` stays a tiny
  // pre-render-init module — the accessibility service pulls in palette
  // data we don't want hot-loaded for tests that never paint a HUD.
  void import('./accessibility/accessibility-service').then(({ applyAccessibilityToDom }) => {
    applyAccessibilityToDom()
  })
}

export function savePlayerSettings(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(playerSettings))
  } catch {
    // localStorage unavailable — settings still take effect for this session.
  }
}

export function setWavePumpIntensity(v: WavePumpIntensity): void {
  playerSettings.wavePumpIntensity = v
  savePlayerSettings()
}

export function setTuckVfxIntensity(v: TuckVfxIntensity): void {
  playerSettings.tuckVfxIntensity = v
  savePlayerSettings()
}

export function setTuckMeter(on: boolean): void {
  playerSettings.tuckMeter = on
  savePlayerSettings()
}

export function setAIDifficulty(v: AIDifficulty): void {
  playerSettings.aiDifficulty = v
  savePlayerSettings()
}

export function setRubberBandAssist(on: boolean): void {
  playerSettings.rubberBandAssist = on
  savePlayerSettings()
}

export function setAntiGravCameraIntensity(v: AntiGravCameraIntensity): void {
  playerSettings.antiGravCameraIntensity = v
  savePlayerSettings()
}

export function setEmissiveLandmarks(v: EmissiveLandmarksIntensity): void {
  playerSettings.emissiveLandmarks = v
  savePlayerSettings()
  // Lazy import so this module stays cheap for tests / early boot paths
  // that never reach the render layer.
  void import('./render/lava-river-material').then(({ applyEmissiveLandmarksSetting }) => {
    applyEmissiveLandmarksSetting(v)
  })
}

export function setPreLapIntro(v: PreLapIntroMode): void {
  playerSettings.preLapIntro = v
  savePlayerSettings()
}

export function setTutorialSubtitles(on: boolean): void {
  playerSettings.tutorialSubtitles = on
  savePlayerSettings()
}

export function markTutorialCompleted(): void {
  playerSettings.tutorialCompleted = true
  savePlayerSettings()
}

export type AudioBusKey = 'master' | 'music' | 'sfx' | 'ambient'

const AUDIO_BUS_FIELD: Readonly<Record<AudioBusKey, keyof PlayerSettings>> = Object.freeze({
  master: 'audioMasterVolume',
  music: 'audioMusicVolume',
  sfx: 'audioSfxVolume',
  ambient: 'audioAmbientVolume',
})

/** Settings overlay slider writer — clamps, persists, and re-applies
 *  to the live AudioEngine in one call so a slider drag both takes
 *  effect immediately AND survives a reload. */
export function setAudioBusVolume(bus: AudioBusKey, volume: number): void {
  const v = Math.max(0, Math.min(1, volume))
  const field = AUDIO_BUS_FIELD[bus]
  ;(playerSettings as unknown as Record<string, number>)[field as string] = v
  savePlayerSettings()
  // Lazy import so player-settings stays a small module the early-boot
  // path can import without dragging the audio module in too.
  import('./audio/audio-service').then(({ applyAudioBusVolume }) => {
    applyAudioBusVolume(bus, v)
  })
}

export function setAudioMusicEnabled(on: boolean): void {
  playerSettings.audioMusicEnabled = on
  savePlayerSettings()
  import('./audio/audio-service').then(({ applyAudioMusicEnabled }) => {
    applyAudioMusicEnabled(on)
  })
}

/** Replace the live keyboard binding table — caller is responsible for
 *  building the new table via `assignKeyboardPrimary` (which preserves
 *  swap semantics + uniqueness). Persists immediately so the next reload
 *  sees the new mapping. */
export function setKeyboardBindings(next: KeyboardBindings): void {
  playerSettings.keyboardBindings = cloneKeyboardBindings(next)
  savePlayerSettings()
}

export function setGamepadBindings(next: GamepadBindings): void {
  playerSettings.gamepadBindings = cloneGamepadBindings(next)
  savePlayerSettings()
}

export function resetKeyboardBindings(): void {
  playerSettings.keyboardBindings = defaultKeyboardBindings()
  savePlayerSettings()
}

export function resetGamepadBindings(): void {
  playerSettings.gamepadBindings = defaultGamepadBindings()
  savePlayerSettings()
}

export function setGamepadDeadzone(v: number): void {
  playerSettings.gamepadDeadzone = Math.max(0, Math.min(0.5, v))
  savePlayerSettings()
}

export function setGamepadSensitivity(v: number): void {
  playerSettings.gamepadSensitivity = Math.max(0.5, Math.min(3.0, v))
  savePlayerSettings()
}

export function setInvertCameraY(on: boolean): void {
  playerSettings.invertCameraY = on
  savePlayerSettings()
}

export function setLeaderboardSubmit(on: boolean): void {
  playerSettings.leaderboardSubmit = on
  savePlayerSettings()
}

/** Persist a normalized handle. Empty (or only-invalid) input clears
 *  the handle back to "" so the submitter falls through to its 'YOU'
 *  fallback — matches the settings input's behaviour when the player
 *  blanks the row. */
export function setLeaderboardHandle(raw: string): void {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 12)
  playerSettings.leaderboardHandle = cleaned
  savePlayerSettings()
}

// ─── Accessibility setters ───────────────────────────────────────────
//
// Each setter follows the same three-step pattern: mutate the live
// struct, re-apply the data-attrs to the DOM, notify the pub/sub so
// canvas-painting HUDs can repaint, then persist. The lazy import keeps
// `player-settings.ts` cheap to import from boot paths that don't paint.

function applyAndNotifyAccessibility(): void {
  void import('./accessibility/accessibility-service').then(
    ({ applyAccessibilityToDom, notifyAccessibilityChange }) => {
      applyAccessibilityToDom()
      notifyAccessibilityChange()
    },
  )
}

export function setColorblindMode(mode: ColorblindMode): void {
  playerSettings.colorblindMode = mode
  applyAndNotifyAccessibility()
  savePlayerSettings()
}

export function setReducedFlash(on: boolean): void {
  playerSettings.reducedFlash = on
  applyAndNotifyAccessibility()
  savePlayerSettings()
}

export function setLargeText(on: boolean): void {
  playerSettings.largeText = on
  applyAndNotifyAccessibility()
  savePlayerSettings()
}

export function setHighContrast(on: boolean): void {
  playerSettings.highContrast = on
  applyAndNotifyAccessibility()
  savePlayerSettings()
}

export function setReducedMotion(on: boolean): void {
  playerSettings.reducedMotion = on
  applyAndNotifyAccessibility()
  savePlayerSettings()
}

export function setMotionSicknessReduction(on: boolean): void {
  playerSettings.motionSicknessReduction = on
  applyAndNotifyAccessibility()
  savePlayerSettings()
}

export function setScreenShakeIntensity(v: number): void {
  playerSettings.screenShakeIntensity = Math.max(0, Math.min(1, v))
  applyAndNotifyAccessibility()
  savePlayerSettings()
}

export function setSubtitlesAlwaysOn(on: boolean): void {
  playerSettings.subtitlesAlwaysOn = on
  applyAndNotifyAccessibility()
  savePlayerSettings()
}

export function setFramerateCap(cap: number): void {
  // 0 means Unlimited. Anything else clamps to [30, 240] to keep the
  // rAF gate sane — values lower than 30 are essentially "don't render"
  // and higher than 240 over-promise on any current panel.
  if (!Number.isFinite(cap) || cap <= 0) {
    playerSettings.framerateCap = 0
  } else {
    playerSettings.framerateCap = Math.max(30, Math.min(240, cap))
  }
  savePlayerSettings()
}

export function setPixelRatio(v: number): void {
  if (!Number.isFinite(v)) return
  playerSettings.pixelRatio = Math.max(0.5, Math.min(2.0, v))
  savePlayerSettings()
  // Apply to the live renderer if it's been registered. Lazy-imported
  // for the same reason as the audio bus setter — keeps this module
  // cheap for tests that never touch the renderer.
  void import('./render/renderer-service').then(({ applyPixelRatio }) => {
    applyPixelRatio(playerSettings.pixelRatio)
  })
}

export function setFullscreenPreferred(on: boolean): void {
  playerSettings.fullscreenPreferred = on
  savePlayerSettings()
}

export function setAnimatedLandmarks(on: boolean): void {
  playerSettings.animatedLandmarks = on
  savePlayerSettings()
}
