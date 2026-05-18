/**
 * AI difficulty tuning — Casual / Standard / Hard.
 *
 * Lands the second Foundation Systems row from
 * `docs/v1-work-breakdown.md` and the design-targets requirement
 * (#6, design-targets.md:98) for "Three settings + a discrete
 * rubber-band toggle".
 *
 * Each difficulty bakes one tuning bundle:
 *
 *  - `baselineTopSpeedFactor` — the rest point for `topSpeedFactor`
 *    on the AIController. Used by `ai-control` (throttle ceiling) and
 *    by `rubber-band` as the target the smoothed factor decays toward
 *    when nobody's pulling ahead or falling back.
 *  - `maxLateralAccel` — m/s² the AI plans for in the curvature scan.
 *    Higher = aggressive cornering, lower = wider lines + earlier
 *    braking.
 *  - `curvatureLookaheadSec` — how far ahead the curvature scan walks
 *    the spline. Longer = sees corners sooner = brakes earlier.
 *  - `rubberBandBoostCap` / `rubberBandPenaltyFloor` — bounds on the
 *    speed-factor modulation when the rubber-band assist is on. Casual
 *    keeps the band narrow so a strong human run still feels like a
 *    win; Hard widens it slightly so a stumble lets the field catch up.
 *
 * Reading at spawn time (vs. each tick) means changing the difficulty
 * setting takes effect on the next race — matches how every kart game
 * the planning trio cites handles the equivalent slider.
 */

export type AIDifficulty = 'casual' | 'standard' | 'hard'

export type DifficultyTuning = Readonly<{
  baselineTopSpeedFactor: number
  maxLateralAccel: number
  curvatureLookaheadSec: number
  rubberBandBoostCap: number
  rubberBandPenaltyFloor: number
}>

export const DIFFICULTY_TUNING: Readonly<Record<AIDifficulty, DifficultyTuning>> = Object.freeze({
  casual: Object.freeze({
    baselineTopSpeedFactor: 0.82,
    maxLateralAccel: 9.0,
    curvatureLookaheadSec: 1.4,
    rubberBandBoostCap: 1.1,
    rubberBandPenaltyFloor: 0.95,
  }),
  standard: Object.freeze({
    baselineTopSpeedFactor: 0.95,
    maxLateralAccel: 11.0,
    curvatureLookaheadSec: 1.6,
    rubberBandBoostCap: 1.18,
    rubberBandPenaltyFloor: 0.92,
  }),
  hard: Object.freeze({
    baselineTopSpeedFactor: 1.04,
    maxLateralAccel: 12.5,
    curvatureLookaheadSec: 1.8,
    rubberBandBoostCap: 1.22,
    rubberBandPenaltyFloor: 0.9,
  }),
})

export const VALID_AI_DIFFICULTIES: readonly AIDifficulty[] = Object.freeze([
  'casual',
  'standard',
  'hard',
])

export function difficultyTuning(d: AIDifficulty): DifficultyTuning {
  return DIFFICULTY_TUNING[d]
}
