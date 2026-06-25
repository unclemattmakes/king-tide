/**
 * Live water re-config for the editor. The water mesh live-mirrors wave
 * amplitudes and watches `field.zones` by reference, so the two biggest
 * water params the editor authors can update the *visible* surface the moment
 * they're edited (height is already live via `setWaterHeight`):
 *
 *   - Sea state (`sky.seaStateBeaufort`) — the master wave-height dial.
 *   - Wave zones (`waveZones[]`) — the per-patch amplitude/frequency mastery
 *     volumes.
 *
 * Boot applied the track's beaufort destructively to `field.waves[].amplitude`,
 * so we capture the amplitudes at editor-init as the base and re-scale RELATIVE
 * to that base each time — robust to repeated edits and self-contained (it only
 * touches amplitudes, exactly what the boot scaling does). Wavelength / phase /
 * direction are baked into the shader at construction and are NOT live; those
 * sky knobs still apply on Play.
 */

import { beaufortToAmplitudeScale } from '@/engine/render/sky'
import { setWaveZones, type WaveFieldState } from '@/engine/sim/water/wave-field'
import type { Track } from '@/game/tracks/types'

/** Default Beaufort the field is treated as when a track authors none —
 *  matches the boot (Beaufort 4 ≈ 1.0× = the historical no-knob look). */
const DEFAULT_BEAUFORT = 4

/**
 * Re-scale every wave amplitude to `newBeaufort`, relative to the amplitudes
 * captured at `baseBeaufort`. Pure — mutates the `amplitude` of each wave in
 * place. `out` and `baseAmps` are index-aligned.
 */
export function rescaleSeaState(
  waves: { amplitude: number }[],
  baseAmps: readonly number[],
  baseBeaufort: number,
  newBeaufort: number,
): void {
  const baseScale = beaufortToAmplitudeScale(baseBeaufort) || 1
  const factor = beaufortToAmplitudeScale(newBeaufort) / baseScale
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i]
    if (w) w.amplitude = (baseAmps[i] ?? 0) * factor
  }
}

export type EditorLiveWater = {
  /** Re-scale the live wave amplitudes to a new Beaufort sea state. Call from
   *  the sea-state slider (which doesn't rebuild helpers). */
  applySeaState(beaufort: number): void
  /** Re-apply BOTH zones + sea state from the draft's current values. Call on
   *  every helper rebuild (placement / delete / undo / zone edit) so the
   *  visible water always tracks the draft. */
  sync(): void
}

export function createEditorLiveWater(field: WaveFieldState, draft: Track): EditorLiveWater {
  // Pristine amplitudes as the field stands at editor open (already scaled to
  // the track's authored beaufort by the boot).
  const baseAmps = field.waves.map((w) => w.amplitude)
  const baseBeaufort = draft.sky?.seaStateBeaufort ?? DEFAULT_BEAUFORT
  function applySeaState(beaufort: number): void {
    rescaleSeaState(field.waves, baseAmps, baseBeaufort, beaufort)
  }
  return {
    applySeaState,
    sync(): void {
      // `setWaveZones` installs a fresh array; the water mesh detects the new
      // reference and re-uploads its zone uniforms next tick.
      setWaveZones(field, draft.waveZones)
      applySeaState(draft.sky?.seaStateBeaufort ?? DEFAULT_BEAUFORT)
    },
  }
}
