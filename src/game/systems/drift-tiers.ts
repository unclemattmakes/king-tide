// ============================================================================
// Drift mini-turbo tiers — pure charge curve + boost payloads.
//
// Extracted from drift.ts as a dependency-free leaf so the making-of
// "Drift" demo can import the real thresholds and boost values directly
// (drift.ts itself pulls in ECS component stores). Pinned by
// tests/unit/drift.test.ts via drift.ts's re-export.
// ============================================================================

/** Charge time (s) to reach tier 1 (blue MT). Below this, release fires
 *  no boost — the anti-snake floor that stops straight-line spam. */
export const TIER_1_THRESHOLD_S = 0.6
/** Charge time (s) to reach tier 2 (orange SMT). The skill-payoff
 *  threshold — sustaining a clean drift through a long corner. */
export const TIER_2_THRESHOLD_S = 1.4
/** Charge time (s) to reach tier 3 (purple UMT). Only reachable on
 *  the long sweeping corners — the expert-tier payoff that MK8 Deluxe
 *  added on top of the original two-tier MT/SMT system. The gap from
 *  SMT to UMT is intentionally large so a casual hold lands on SMT and
 *  only a committed long-arc drift hits UMT. */
export const TIER_3_THRESHOLD_S = 2.4

/** Throttle multiplier applied via `BoostEffect` on tier-1 release.
 *  Bumped from 1.30 (playtest: the blue-MT payoff was too faint to
 *  feel like a reward). */
export const DRIFT_BOOST_MUL_T1 = 1.45
/** Throttle multiplier on tier-2 release. */
export const DRIFT_BOOST_MUL_T2 = 1.75
/** Throttle multiplier on tier-3 (UMT) release. The big payoff — a
 *  long sweeping drift now reads as a real slingshot. Stacks with the
 *  bike's `boostMul` (1.6) only in the rare drift-into-held-boost case;
 *  the resulting brief ~3.1× cap is intentional flair, not the norm. */
export const DRIFT_BOOST_MUL_T3 = 1.95

/** Tier-1 boost duration (s). A quick punch out of a corner. */
export const DRIFT_BOOST_DURATION_T1 = 1.0
/** Tier-2 boost duration (s). Long enough to feel like a real reward. */
export const DRIFT_BOOST_DURATION_T2 = 1.6
/** Tier-3 (UMT) boost duration (s). Mushroom-grade — carries clean
 *  through the next corner. */
export const DRIFT_BOOST_DURATION_T3 = 2.3

/** Returns the tier (0, 1, 2, 3) achievable at a given charge time.
 *  Pure; doesn't peek at the drift state's `highestTier` field —
 *  callers use `Math.max(state.highestTier, tierFor(state.chargeS))`
 *  to preserve the highest tier ever reached this drift. */
export function tierFor(chargeS: number): number {
  if (chargeS >= TIER_3_THRESHOLD_S) return 3
  if (chargeS >= TIER_2_THRESHOLD_S) return 2
  if (chargeS >= TIER_1_THRESHOLD_S) return 1
  return 0
}

/** Look up the `BoostEffect` payload for a given tier. Returns null
 *  for tier 0 — drift release at no charge fires nothing. Tier > 3
 *  saturates at the UMT payload. */
export function driftBoostParams(tier: number): { multiplier: number; durationS: number } | null {
  if (tier <= 0) return null
  if (tier === 1) return { multiplier: DRIFT_BOOST_MUL_T1, durationS: DRIFT_BOOST_DURATION_T1 }
  if (tier === 2) return { multiplier: DRIFT_BOOST_MUL_T2, durationS: DRIFT_BOOST_DURATION_T2 }
  return { multiplier: DRIFT_BOOST_MUL_T3, durationS: DRIFT_BOOST_DURATION_T3 }
}
