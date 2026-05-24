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
  /** Surface vy (m/s) at which the AI will fire a pump while its spline
   *  cursor sits inside a heavy wave zone (see `pump-hints.ts`). `Infinity`
   *  disables pumping entirely — Casual coasts crests; Hard pumps the
   *  smallest rising swells inside a hint zone. Matches the wave-pump
   *  observer's `minVy` (1.5) and `vyCeiling` (7) range so the AI fires
   *  in the same window where a player's pump would register. */
  pumpVyThreshold: number
  /** `intent.pitch` magnitude held during a pump burst. Player flicks E
   *  briefly; the AI matches with a 0.5–0.8 nose-up tilt that hover.ts's
   *  pitch-torque integrates into a clear launch over the burst window. */
  pumpPitchStrength: number
  /** Curvature (1/m) above which the AI will initiate a drift on the
   *  upcoming corner. `Infinity` disables AI drift entirely (Casual).
   *  Standard triggers on tight 90° corners (~30 m radius → 0.033 1/m);
   *  Hard widens the trigger envelope to medium corners so the AI
   *  exits more corners on a mini-turbo. */
  driftCurvatureThreshold: number
  /** Minimum horizontal speed (m/s) for an AI drift to fire. Below this
   *  the bike isn't going fast enough for the boost-on-release to pay
   *  for the slip, and the AI would just spin out. */
  driftMinSpeed: number
  /** Maximum seconds the AI will hold a single drift before releasing,
   *  even if the corner is still ahead. Calibrated to just clear the
   *  next tier — Standard hits SMT (1.4 s threshold), Hard reaches UMT
   *  (2.4 s threshold) on the longest sweeps. */
  driftMaxHoldS: number
}>

export const DIFFICULTY_TUNING: Readonly<Record<AIDifficulty, DifficultyTuning>> = Object.freeze({
  casual: Object.freeze({
    baselineTopSpeedFactor: 0.82,
    maxLateralAccel: 9.0,
    curvatureLookaheadSec: 1.4,
    rubberBandBoostCap: 1.1,
    rubberBandPenaltyFloor: 0.95,
    // Casual reads as "newer driver who hasn't internalised wave-mastery
    // yet" — they ride crests rather than pumping them. `Infinity`
    // short-circuits the per-tick vy check in ai-control without
    // branching on difficulty there.
    pumpVyThreshold: Number.POSITIVE_INFINITY,
    pumpPitchStrength: 0,
    // Same Infinity short-circuit for drift — Casual AI doesn't drift.
    driftCurvatureThreshold: Number.POSITIVE_INFINITY,
    driftMinSpeed: Number.POSITIVE_INFINITY,
    driftMaxHoldS: 0,
  }),
  standard: Object.freeze({
    baselineTopSpeedFactor: 0.95,
    maxLateralAccel: 11.0,
    curvatureLookaheadSec: 1.6,
    rubberBandBoostCap: 1.18,
    rubberBandPenaltyFloor: 0.92,
    pumpVyThreshold: 1.5,
    pumpPitchStrength: 0.5,
    // Triggers on sharp 90° corners (~30 m radius → 0.033 1/m). Holds
    // long enough to clear the SMT threshold (1.4 s) on the typical
    // corner length, but releases short of UMT so the orange MT is
    // the visible Standard ceiling. Mirrors how a competent player
    // hits the second tier consistently but rarely the third.
    driftCurvatureThreshold: 0.033,
    driftMinSpeed: 14,
    driftMaxHoldS: 1.6,
  }),
  hard: Object.freeze({
    baselineTopSpeedFactor: 1.04,
    maxLateralAccel: 12.5,
    curvatureLookaheadSec: 1.8,
    rubberBandBoostCap: 1.22,
    rubberBandPenaltyFloor: 0.9,
    pumpVyThreshold: 0.6,
    pumpPitchStrength: 0.8,
    // Wider trigger envelope (drifts on medium corners too — radius
    // up to ~50 m). Longer hold ceiling so the AI reaches the purple
    // UMT tier (2.4 s) on long sweeps, matching the design-doc claim
    // that UMT is "only reachable on long sweeping corners" — Hard AI
    // earns those exits, Standard doesn't.
    driftCurvatureThreshold: 0.02,
    driftMinSpeed: 10,
    driftMaxHoldS: 2.5,
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
