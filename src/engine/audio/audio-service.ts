/**
 * Audio service singleton — the `AudioEngine` instance created at boot
 * lives behind this thin module so subsystems that need to call into
 * it (Settings overlay, pause menu, dev hooks) don't need a prop-drill
 * from `main.ts`.
 *
 * `main.ts` calls `setAudioEngine(audio)` immediately after creation.
 * Consumers either:
 *
 *   - call `getAudioEngine()?.…` and tolerate `null` (overlay opens
 *     before audio context exists in some test/headless paths), or
 *   - call the helpers in this module (e.g. `applyAudioBusVolume`)
 *     which do the null check themselves.
 *
 * No state of its own — just a holder.
 */

import type { AudioBus, AudioEngine } from './audio'

let instance: AudioEngine | null = null

export function setAudioEngine(engine: AudioEngine): void {
  instance = engine
}

export function getAudioEngine(): AudioEngine | null {
  return instance
}

/** Convenience: apply a bus volume to the live engine if one's
 *  registered. Called by `setAudioBusVolume` in player-settings.ts so
 *  every code path that mutates the volume value also re-applies it. */
export function applyAudioBusVolume(bus: AudioBus, volume: number): void {
  instance?.setBusVolume(bus, volume)
}

export function applyAudioMusicEnabled(enabled: boolean): void {
  instance?.setMusicEnabled(enabled)
}
