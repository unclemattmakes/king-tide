/**
 * Trick-event shim + shared tuning module.
 *
 * Previously this module owned a render-side observer that
 * independently reproduced the sim's vy-peak tracker and ran its own
 * credibility check at press time. The airborne-gated trick model
 * collapsed those decisions into the sim (`trickHopSystem`): the sim
 * sets `TrickState.trickFiredThisTick` on the tick a credible trick
 * fires, and this module's `createWavePumpObserver()` now does
 * nothing more than translate that flag into a `PumpEvent` for the
 * existing HUD / audio / FX wiring.
 *
 * Why it still exists:
 *
 *   - The `PumpEvent` type is the shared lingua franca between sim
 *     and render. FX, audio, and HUD all consume it.
 *   - The tuning constants (`MIN_VY_PEAK`, `MIN_SPEED_FRAC`, etc.)
 *     are imported by both the sim and the render's HUD-prompt logic
 *     so they stay in lockstep.
 *   - `strengthFromTakeoffVy()` is the wave-mastery reward curve and
 *     belongs in shared code so the sim and any HUD readouts agree.
 *
 * The observer interface (`detect`, `reset`, `debug`) is preserved
 * so the game-loop's existing call sites don't move. `detect()` now
 * takes a minimal sample carrying just the sim's fire flag + the
 * takeoff strength / direction.
 */

export type PumpEvent = {
  /** Event firing time, performance.now() — used for HUD widget timing. */
  t: number
  /** 0..1 strength — drives HUD flash intensity, audio chord layer,
   *  and the forward-impulse magnitude. Comes straight from the sim's
   *  `trickFiredStrength`, which is `strengthFromTakeoffVy(vy)`. */
  strength: number
  /** Which side the player committed to: 'left' for trickLeft / L1,
   *  'right' for trickRight / R1. Captured at press time even for
   *  buffered presses, so the spin direction reflects intent. */
  direction: 'left' | 'right'
}

export type WavePumpSample = {
  /** True on the single tick the sim's `trickHopSystem` fires a
   *  credible trick. Read once, then cleared by the sim next tick. */
  trickFiredThisTick: boolean
  /** Sim-supplied strength (0..1) for this fire. */
  trickFiredStrength: number
  /** Sim-supplied direction: -1 left, +1 right. */
  trickFiredDirection: number
}

// ── Shared tuning ────────────────────────────────────────────────────
// These values are the single source of truth for the trick model.
// `trickHopSystem` reads them for its eligibility gates; the HUD-
// prompt logic in `game-loop` reads them to decide when to show the
// "TRICK READY" cue. Changing a value here changes both behaviors.

/** Vertical velocity (m/s) the bike must reach at the moment of
 *  takeoff for a trick window to open. Same threshold gates the
 *  pre-press buffer (a recent `vyPeak ≥ MIN_VY_PEAK` indicates a
 *  qualifying takeoff is plausible). 3.5 m/s catches a ridable wave
 *  climb or ramp lip without arming on flat-ground chop. */
export const MIN_VY_PEAK = 3.5

/** Minimum forward speed (as a fraction of the bike's `topSpeed`) for
 *  a takeoff to qualify. 35% rejects coasting / parked bikes — tricks
 *  are a commitment move, not a stationary input. */
export const MIN_SPEED_FRAC = 0.35

/** Minimum throttle this tick for a takeoff to qualify. */
export const MIN_THROTTLE = 0.3

/** Vy ceiling for the strength curve. At this takeoff vy the reward
 *  saturates to 1.0. Between `MIN_VY_PEAK` and this, strength scales
 *  linearly from 0.4 → 1.0 — a stronger climb visibly pays better. */
export const VY_STRENGTH_CEILING = 8.0

/** Seconds the pre-input buffer holds a grounded press while waiting
 *  for a qualifying takeoff. MK-style "early press" forgiveness:
 *  commit on the upslope, the trick fires the moment you leave the
 *  ground. Buffer expires to a small flatground hop if no takeoff
 *  arrives in time. */
export const PRE_PRESS_BUFFER_SEC = 0.2

/**
 * Wave-mastery reward curve. Maps takeoff vy (m/s) → boost strength
 * (0..1). Bucketing:
 *
 *   - `vy < MIN_VY_PEAK`     → 0   (no boost; never called in
 *                                   practice — qualifying takeoff
 *                                   guarantees vy ≥ MIN_VY_PEAK.)
 *   - `MIN_VY_PEAK`          → 0.4 (the "I made it count" floor)
 *   - `MIN_VY_PEAK..ceiling` → 0.4 → 1.0 linear ramp
 *   - `≥ VY_STRENGTH_CEILING` → 1.0 saturate
 */
export function strengthFromTakeoffVy(vy: number): number {
  if (vy < MIN_VY_PEAK) return 0
  const span = VY_STRENGTH_CEILING - MIN_VY_PEAK
  const t = span > 0 ? Math.min(1, Math.max(0, (vy - MIN_VY_PEAK) / span)) : 1
  return 0.4 + t * 0.6
}

export type WavePumpObserver = {
  /** Translate the sim's `trickFiredThisTick` flag into a `PumpEvent`.
   *  Returns null on ticks where the sim did not fire a trick. */
  detect(now: number, sample: WavePumpSample): PumpEvent | null
  /** No-op preserved for the existing race-respawn call sites. The
   *  shim has no per-instance state to reset. */
  reset(): void
  /** Read-only view — kept for symmetry with the old observer but
   *  there's nothing interesting to report now that the sim owns
   *  the state. */
  debug(): { lastFireAt: number }
}

export function createWavePumpObserver(): WavePumpObserver {
  let lastFireAt = Number.NEGATIVE_INFINITY

  return {
    detect(now, s) {
      if (!s.trickFiredThisTick) return null
      const direction: 'left' | 'right' = s.trickFiredDirection < 0 ? 'left' : 'right'
      const strength = Math.max(0, Math.min(1, s.trickFiredStrength))
      lastFireAt = now
      return { t: now, strength, direction }
    },
    reset() {
      lastFireAt = Number.NEGATIVE_INFINITY
    },
    debug() {
      return { lastFireAt }
    },
  }
}
