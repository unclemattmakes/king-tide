import { createStore } from '@/engine/sim/ecs/store'
import { type AIDifficulty, difficultyTuning } from '@/game/ai/difficulty'

export const AITag = { name: 'AITag' as const }

/**
 * Per-AI controller state. The system reads the spline by id from the active
 * track each tick — keeping the spline OUT of the component so we don't
 * duplicate state.
 *
 * Per-difficulty tuning (baseline top speed, lateral-accel ceiling,
 * curvature lookahead, rubber-band bounds) is baked in here at spawn
 * time from the player's selected difficulty. This means changing the
 * difficulty setting takes effect on the next race rather than mid-lap,
 * which avoids surprising the player with a sudden AI personality flip.
 */
export const AIController = { name: 'AIController' as const }
export type AIControllerData = {
  /** Which AI spline to follow. */
  splineId: string
  /** Cached index of the closest spline point — speeds up the next tick's search. */
  lastClosestIndex: number
  /** Look-ahead distance along the spline, meters. */
  lookAhead: number
  /** Effective top-speed factor (mutated by rubber-band; settles to
   *  `baselineTopSpeedFactor` when the assist is off or the field is
   *  bunched). */
  topSpeedFactor: number
  /** Per-difficulty rest point for `topSpeedFactor` — set on spawn from
   *  the player's chosen difficulty. */
  baselineTopSpeedFactor: number
  /** Max lateral acceleration the AI will plan for in the curvature
   *  scan (m/s²). Higher = aggressive cornering. */
  maxLateralAccel: number
  /** Curvature-scan lookahead (s). Longer = sees corners sooner. */
  curvatureLookaheadSec: number
  /** Rubber-band assist ceiling (multiplier on baseline when far behind). */
  rubberBandBoostCap: number
  /** Rubber-band assist floor (multiplier on baseline when leading). */
  rubberBandPenaltyFloor: number
  /**
   * Lateral offset (m) perpendicular to the racing line. Each AI gets a
   * slightly different value so they don't all converge on the same point.
   * Positive = right of travel direction.
   */
  lineOffset: number
}
export const AIControllerStore = createStore<AIControllerData>('AIController')

export function defaultAIController(
  splineId: string,
  opts?: { lineOffset?: number; difficulty?: AIDifficulty },
): AIControllerData {
  const tuning = difficultyTuning(opts?.difficulty ?? 'standard')
  return {
    splineId,
    lastClosestIndex: 0,
    lookAhead: 12,
    topSpeedFactor: tuning.baselineTopSpeedFactor,
    baselineTopSpeedFactor: tuning.baselineTopSpeedFactor,
    maxLateralAccel: tuning.maxLateralAccel,
    curvatureLookaheadSec: tuning.curvatureLookaheadSec,
    rubberBandBoostCap: tuning.rubberBandBoostCap,
    rubberBandPenaltyFloor: tuning.rubberBandPenaltyFloor,
    lineOffset: opts?.lineOffset ?? 0,
  }
}

// Re-export so AIController-adjacent callers don't have to reach into
// the difficulty module directly.
export type { AIDifficulty }
