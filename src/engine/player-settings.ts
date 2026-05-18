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

const STORAGE_KEY = 'hoverbike.playerSettings.v1'

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

export type PlayerSettings = {
  wavePumpIntensity: WavePumpIntensity
  aiDifficulty: AIDifficulty
  /** Rubber-band assist toggle. When false, `rubberBandSystem` is a
   *  no-op (modulo settling AI back to baseline) — AI no longer
   *  catches up after falling behind. */
  rubberBandAssist: boolean
  antiGravCameraIntensity: AntiGravCameraIntensity
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
}

export const DEFAULT_PLAYER_SETTINGS: Readonly<PlayerSettings> = Object.freeze({
  wavePumpIntensity: 'full',
  aiDifficulty: 'standard',
  rubberBandAssist: true,
  antiGravCameraIntensity: 'full',
  tutorialSubtitles: true,
  tutorialCompleted: false,
  audioMasterVolume: 0.8,
  audioMusicVolume: 0.55,
  audioSfxVolume: 0.85,
  audioAmbientVolume: 0.7,
  audioMusicEnabled: true,
  leaderboardSubmit: true,
  leaderboardHandle: '',
})

/** Live, mutable copy. Consumers read this object every frame — no
 *  observer needed because reads are O(1) and the surface area is
 *  small. Writes go through the setter helpers so persistence stays
 *  honest. */
export const playerSettings: PlayerSettings = { ...DEFAULT_PLAYER_SETTINGS }

const VALID_WAVE_PUMP_INTENSITY: WavePumpIntensity[] = ['full', 'subtle', 'off']
const VALID_AI_DIFFICULTY: AIDifficulty[] = ['casual', 'standard', 'hard']
const VALID_ANTI_GRAV_CAMERA: AntiGravCameraIntensity[] = ['full', 'reduced', 'off']

/** Roll-follow scalar each intensity step contributes — multiplied by
 *  the live AntiGravOverride weight to get the per-frame camera follow
 *  weight passed to `ChaseCamera.setAntiGravFollow`. */
export const ANTI_GRAV_CAMERA_SCALAR: Readonly<Record<AntiGravCameraIntensity, number>> =
  Object.freeze({
    full: 1.0,
    reduced: 0.4,
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
