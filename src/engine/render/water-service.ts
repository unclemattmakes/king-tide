/**
 * Water-mesh service singleton — same pattern as `renderer-service.ts`. The
 * `WaterMesh` created during boot is stashed here so the Settings overlay can
 * re-apply the wave-spray (crest-mist) strength live, without prop-drilling the
 * mesh handle through `main.ts → game-loop → settings`.
 *
 * `main.ts` calls `setWaterMesh(waterMesh)` right after `createWaterMesh()`.
 * Consumers tolerate `null` (the overlay can open on procedural / edit-mode
 * tracks that never built a water mesh).
 */

import type { WaveSprayIntensity } from '../player-settings'
import { WAVE_SPRAY_SCALAR } from '../player-settings'
import type { WaterMesh } from './water'

let instance: WaterMesh | null = null

export function setWaterMesh(mesh: WaterMesh | null): void {
  instance = mesh
}

export function getWaterMesh(): WaterMesh | null {
  return instance
}

/** Apply the wave-spray setting's GPU half — the crest-mist ribbon strength —
 *  to the live water mesh. The particle half reads the setting per frame, so
 *  this only touches the shader uniform. No-op when no water mesh exists. */
export function applyWaveSprayIntensity(v: WaveSprayIntensity): void {
  instance?.debug.setCrestMistStrength(WAVE_SPRAY_SCALAR[v])
}
