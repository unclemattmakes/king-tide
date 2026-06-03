/**
 * Out-of-bounds tuning — one place to adjust the feel of the boundary and the
 * shark escalation. See docs/out-of-bounds-design.md for the rationale.
 *
 * Pure constants, no imports — safe for sim, render, and tests alike.
 */

/** Soft-wall multiplier on the per-track corridor half-width (the buoy
 *  placement distance). Cross this and Phase 1 begins: warning popup +
 *  autopilot + forfeited race credit. */
export const SOFT_LEASH_MULT = 1.5

/** Hard-wall multiplier on the corridor half-width. Cross this and the lethal
 *  phase arms immediately, regardless of the grace timer ("either one"). */
export const HARD_LEASH_MULT = 2.5

/** Corridor half-width (m) used when a track ships no `waveRiderBuoys` (no
 *  channel walls to measure). Sized to a typical authored corridor. */
export const DEFAULT_CORRIDOR_HALF_WIDTH_M = 45

/** Floor on the measured corridor half-width so a freak tight cluster of buoys
 *  can't produce a punishingly small leash. */
export const MIN_CORRIDOR_HALF_WIDTH_M = 18

/** Default grace seconds the WARN phase counts down before escalating. The
 *  player-facing Settings "OOB grace timer" overrides this. */
export const WARN_GRACE_S = 5

/** Settings grace-timer presets (seconds) — decision #5's adjustable timing. */
export const GRACE_PRESETS = { short: 3, normal: 5, long: 8 } as const
export type GracePreset = keyof typeof GRACE_PRESETS

/** The "incoming" beat between the grace timer expiring and the attack
 *  resolving — the shark's wind-up, and the player's last chance to recover
 *  into a near-miss. */
export const BRACE_S = 1.5

/** Re-entry hysteresis: you're "back in bounds" only once your distance drops
 *  below this fraction of the soft leash, so you don't flicker on the edge. */
export const REENTRY_FRAC = 0.92

/** Low-pass factor (per tick) for the inward-speed estimate that drives the
 *  near-miss test. */
export const INWARD_SMOOTH = 0.25

/** Minimum inward speed (m/s, toward the line) for the "recovering" test that
 *  turns an attack into a near-miss. */
export const NEAR_MISS_MIN_INWARD_SPEED = 8

/** Lookahead (s) for the recovering test: if the bike is projected to be back
 *  inside the soft leash within this window, the attack misses. */
export const NEAR_MISS_LOOKAHEAD_S = 1.2
