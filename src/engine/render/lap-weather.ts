import { beaufortToAmplitudeScale } from '@/engine/render/sky'
import type { Wave, WaveFieldState } from '@/engine/sim/water/wave-field'
import type { LapWeather } from '@/game/tracks/types'

/**
 * Per-lap weather progression. Lerps cloudiness, sun intensity, and
 * Beaufort wave-amplitude scale between authored snapshots as the player
 * crosses laps. Stays render-side: only mutates the sky's shader-uniform
 * setters and the wave field's amplitude scalar — both already isolated
 * from the deterministic sim path, so a player who joins mid-race sees
 * the same weather but doesn't desync.
 *
 * Authoring lives on `Track.lapWeather`: each entry is the *target* state
 * the system lerps to when the matching lap begins. Entry 0 (if present)
 * overrides the boot state at race start; later entries activate when
 * lap N begins.
 *
 * The system is allocation-free per frame — only one scratch number set
 * exists, and `step()` runs O(1) regardless of how many laps are queued.
 */

export type LapWeatherSystem = {
  /** Called when lap N starts (lap is 1-indexed in the race system —
   *  the first lap is `1`). Triggers a lerp from current state toward
   *  the matching `lapWeather[lap - 1]` entry over its
   *  `transitionSeconds`. Out-of-range lap indices are a no-op. */
  onLapStart(lap: number): void
  /** Advance the live state by `dt` seconds and push the result into
   *  the sky + wave field. Call once per frame from the main loop. */
  step(dt: number): void
  /** Read the current targets — primarily for debugging / UI overlays. */
  current(): { cloudiness: number; beaufort: number; sunIntensity: number }
}

export type LapWeatherDeps = {
  /** Authored progression. Empty/absent → system is a no-op. */
  schedule: readonly LapWeather[] | undefined
  /** Boot-time weather state (the static `sky` block). Used as the
   *  "current state" before any lap entries fire and as the fallback
   *  for any field a `LapWeather` entry leaves unset. */
  initial: {
    cloudiness: number
    /** Beaufort scale, before the per-lap multiplier. The system stores
     *  this as the baseline; `beaufort` in `LapWeather` entries
     *  replaces this value (not multiplies). */
    beaufort: number
    sunIntensity: number
  }
  sky: {
    setCloudiness(c: number): void
    setSunIntensity(s: number): void
  }
  /** Wave field whose amplitudes we scale per-lap. The system snapshots
   *  the boot-time amplitudes once at construction and re-derives the
   *  live `w.amplitude` each step from `snapshot[i] * scale(beaufort)`. */
  waveField: WaveFieldState
}

const DEFAULT_TRANSITION_S = 5

/**
 * Build the system. Returns a no-op stub when `schedule` is empty so
 * call-sites don't need to branch.
 */
export function createLapWeatherSystem(deps: LapWeatherDeps): LapWeatherSystem {
  const schedule = deps.schedule ?? []
  if (schedule.length === 0) {
    return {
      onLapStart: () => {},
      step: () => {},
      current: () => ({ ...deps.initial }),
    }
  }

  // Snapshot the wave-field amplitudes at construction. These are the
  // POST-Beaufort amplitudes (main.ts has already scaled them by the
  // boot Beaufort), so they represent the per-track baseline at
  // `deps.initial.beaufort`. To go from baseline → live target we
  // multiply by `scale(targetBeaufort) / scale(initial.beaufort)`.
  const ampBaseline = deps.waveField.waves.map((w) => w.amplitude)
  const initialBeaufortScale = beaufortToAmplitudeScale(deps.initial.beaufort)

  // Live state — what we're rendering this frame.
  const live = { ...deps.initial }
  // Lerp endpoints — when no transition is active, `from === target` and
  // `progress` is locked at 1.
  let fromCloud = deps.initial.cloudiness
  let fromBeaufort = deps.initial.beaufort
  let fromSun = deps.initial.sunIntensity
  let targetCloud = deps.initial.cloudiness
  let targetBeaufort = deps.initial.beaufort
  let targetSun = deps.initial.sunIntensity
  let transitionS = DEFAULT_TRANSITION_S
  let progress = 1 // 0..1; 1 = lerp finished

  // Honour entry 0 as the boot-state override — fire it immediately
  // with a zero-second transition so the player spawns into the
  // first-lap weather.
  const entry0 = schedule[0]
  if (entry0) {
    fromCloud = targetCloud = entry0.cloudiness ?? live.cloudiness
    fromBeaufort = targetBeaufort = entry0.beaufort ?? live.beaufort
    fromSun = targetSun = entry0.sunIntensity ?? live.sunIntensity
    live.cloudiness = targetCloud
    live.beaufort = targetBeaufort
    live.sunIntensity = targetSun
    pushToSky()
    pushToWaves()
  }

  function pushToSky(): void {
    deps.sky.setCloudiness(live.cloudiness)
    deps.sky.setSunIntensity(live.sunIntensity)
  }

  function pushToWaves(): void {
    const targetScale = beaufortToAmplitudeScale(live.beaufort)
    const mult = targetScale / Math.max(initialBeaufortScale, 1e-6)
    const waves = deps.waveField.waves
    for (let i = 0; i < waves.length; i++) {
      ;(waves[i] as Wave).amplitude = ampBaseline[i]! * mult
    }
  }

  function onLapStart(lap: number): void {
    if (lap < 1) return
    // Schedule index = lap (entry 0 is the start, entry 1 is the
    // *next* target after lap 1 finishes, i.e. lap 2's weather).
    const entry = schedule[lap]
    if (!entry) return
    // Capture current live values as the lerp's "from" so the next
    // ramp picks up wherever we left off (handles back-to-back lap
    // entries during a still-running transition).
    fromCloud = live.cloudiness
    fromBeaufort = live.beaufort
    fromSun = live.sunIntensity
    targetCloud = entry.cloudiness ?? live.cloudiness
    targetBeaufort = entry.beaufort ?? live.beaufort
    targetSun = entry.sunIntensity ?? live.sunIntensity
    transitionS = entry.transitionSeconds ?? DEFAULT_TRANSITION_S
    progress = transitionS > 0 ? 0 : 1
    if (transitionS <= 0) {
      live.cloudiness = targetCloud
      live.beaufort = targetBeaufort
      live.sunIntensity = targetSun
      pushToSky()
      pushToWaves()
    }
  }

  function step(dt: number): void {
    if (progress >= 1) return
    progress = Math.min(1, progress + dt / Math.max(transitionS, 1e-6))
    // Smoothstep eases the ramp at both ends — "the front of a storm"
    // reads better than a linear ramp at the same total duration.
    const k = progress * progress * (3 - 2 * progress)
    live.cloudiness = fromCloud + (targetCloud - fromCloud) * k
    live.beaufort = fromBeaufort + (targetBeaufort - fromBeaufort) * k
    live.sunIntensity = fromSun + (targetSun - fromSun) * k
    pushToSky()
    pushToWaves()
  }

  function current(): { cloudiness: number; beaufort: number; sunIntensity: number } {
    return { ...live }
  }

  return { onLapStart, step, current }
}
