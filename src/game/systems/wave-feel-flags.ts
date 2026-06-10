/**
 * Dev-flag gates for the P4.2 water-feel prototypes
 * (water-next-research §7.6): catch-the-wave momentum and wake drafting.
 * BOTH DEFAULT OFF — they change race balance, so they exist to be felt
 * in a playtest (`?wavepush=1&draft=1`, or fractional gains like
 * `?wavepush=0.5`), not to ship silently. Matt's hands decide
 * (feedback_playtest_truth); adoption means AI/lap-time rebalance work.
 *
 * Boot-set from URL params in main.ts (constant for the session →
 * deterministic sim); the sim layer reads this module only.
 */
export const WAVE_FEEL = {
  /** Catch-the-wave gain, 0..2. Scales a forward push when riding WITH
   *  the swell on a rising face (dot(forward, travel) × ∂h/∂t). */
  wavePush: 0,
  /** Wake-drafting gain, 0..2. Scales a forward boost inside the calm
   *  center trough of a rival's wake (the Hydro Thunder mechanic). */
  draft: 0,
}

export function setWaveFeelFlags(p: {
  wavePush?: number | undefined
  draft?: number | undefined
}): void {
  if (p.wavePush !== undefined && Number.isFinite(p.wavePush)) {
    WAVE_FEEL.wavePush = Math.max(0, Math.min(2, p.wavePush))
  }
  if (p.draft !== undefined && Number.isFinite(p.draft)) {
    WAVE_FEEL.draft = Math.max(0, Math.min(2, p.draft))
  }
}
