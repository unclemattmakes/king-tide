/**
 * Shared "does this gate float?" predicate, used by BOTH the gate render
 * (bobs the visual onto the wave surface — `track-mesh.ts`) and the race
 * trigger (widens the vertical crossing window — `race.ts`), so the two
 * always agree on which gates float and where the water line is.
 *
 * Pure (no Three.js, no Rapier, no ECS) so both the render and sim layers
 * can import it.
 */

import type { Checkpoint, Track } from './types'

/** A gate whose base sits at most this far above the water line still
 *  counts as "on water" and bobs; gates raised higher (onto bridges,
 *  piers, rooftops) read as standing on dry structure and stay static
 *  even when `track.floatGates` is on ("auto-off over land"). */
export const GATE_FLOAT_WATER_BAND_M = 4

/**
 * Whether a checkpoint gate floats on the wave surface. True only when the
 * track opts in (`floatGates`) AND the gate's base is near the water line.
 * The water level mirrors the runtime's `waveField.baseY`
 * (= `track.water?.height ?? 0`), so render and trigger stay consistent.
 */
export function gateFloatsOnWaves(track: Track, cp: Checkpoint): boolean {
  if (!track.floatGates) return false
  const waterLevel = track.water?.height ?? 0
  return cp.position.y - waterLevel <= GATE_FLOAT_WATER_BAND_M
}
