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

export type PlayerSettings = {
  wavePumpIntensity: WavePumpIntensity
}

export const DEFAULT_PLAYER_SETTINGS: Readonly<PlayerSettings> = Object.freeze({
  wavePumpIntensity: 'full',
})

/** Live, mutable copy. Consumers read this object every frame — no
 *  observer needed because reads are O(1) and the surface area is
 *  small. Writes go through the setter helpers so persistence stays
 *  honest. */
export const playerSettings: PlayerSettings = { ...DEFAULT_PLAYER_SETTINGS }

const VALID_WAVE_PUMP_INTENSITY: WavePumpIntensity[] = ['full', 'subtle', 'off']

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
