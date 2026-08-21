/**
 * What the cold-boot menu's live backdrop shows: which venue, and the two
 * menu-only departures the attract feed makes from that venue's authored
 * water. Split out of `attract-mode.ts` — which can only be exercised with a
 * real GPU and hydrated assets — so the decisions themselves are pure,
 * documented and unit-testable.
 *
 * Everything else about the backdrop's sea (look, bearing, set envelope,
 * wave zones, stamps, shore field) is the track's own, applied verbatim.
 */

import { createTide } from '@/engine/sim/water/tide'
import type { Track } from '@/game/tracks/types'

/** The venue behind every menu / lobby surface: Mayday Bay (slug `sandbar`),
 *  the dressed tutorial lagoon. The cold-boot menu is a shop window, so it
 *  shows a real, art-passed track rather than the procedural `lagoon` dev
 *  fixture that used to stand in here. */
export const ATTRACT_TRACK_ID = 'sandbar'

/** Tide phase the attract feed holds, as a 0..1 fraction of the cycle.
 *  0.75 is full LOW water (`TideConfig.phase`). Nothing advances the tide
 *  clock in the menu, so the backdrop sits at the track's lowest tide for
 *  the whole session — on Mayday Bay that's the exposed-sandbar read. */
export const ATTRACT_TIDE_PHASE = 0.75

/** Sea-state floor for the backdrop, on the Beaufort scale that drives
 *  `beaufortToAmplitudeScale`. Tracks author their own calm — Mayday Bay is a
 *  sheltered training cove at Beaufort 1 (0.3x) which its cove wave-zone
 *  halves again — and that reads as glass in a backdrop nobody is racing on.
 *  Floor the menu at 4 (the 1.0x scale `defaultWaves()` was authored at) so
 *  the cove lands around 0.7 m peak: a live slight chop with legible crests,
 *  well short of whitecaps. Tracks authored rougher keep their own sea. */
export const ATTRACT_MIN_SEA_STATE_BEAUFORT = 4

/**
 * Absolute sea level for the backdrop: the bottom of the track's authored
 * tide swing, or its mean `water.height` when the track ships no tide.
 *
 * Goes to the same three consumers the race's live tide drives — buoyancy
 * (`waveField.baseY`), the water shader (mesh Y) and the terrain shader's
 * wet band / waterline trio — so the whole surface agrees on low water.
 */
export function attractSeaLevel(water: Track['water']): number {
  const tide = water?.tide
  const held = tide ? { ...tide, phase: ATTRACT_TIDE_PHASE } : undefined
  return createTide(water?.height ?? 0, held).height
}

/**
 * Beaufort number the backdrop runs at: the track's own, floored at
 * `ATTRACT_MIN_SEA_STATE_BEAUFORT`. An absent `seaStateBeaufort` means
 * Beaufort 4 in the race boot too (no scaling = the 1.0x default bank), so
 * the fallback here keeps the two paths reading the same sea.
 */
export function attractSeaStateBeaufort(sky: Track['sky']): number {
  return Math.max(sky?.seaStateBeaufort ?? 4, ATTRACT_MIN_SEA_STATE_BEAUFORT)
}
