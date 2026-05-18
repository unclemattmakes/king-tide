/**
 * Wave-pump event detector.
 *
 * Watches the player bike each render frame and fires a `pump` event
 * when it completes a successful crest launch — i.e. transitions from
 * riding-on-water-grounded to airborne with meaningful upward velocity
 * at meaningful forward speed.
 *
 * This is the "wave-pump signal" half of the wave-mastery pillar from
 * `docs/v1-work-breakdown.md`. Today it's a heuristic on existing
 * hover/water/velocity state — when the full pump-physics tuning pass
 * lands (M11–12), the detector's `detectPump()` keeps its event
 * contract but the trigger condition gets upgraded so the HUD / audio
 * pipeline doesn't need to change.
 *
 * Lives in the render-side loop, not the sim, because pump events are
 * pure audio + UI feedback. Keeping it off the deterministic sim path
 * means tests + replays + lockstep MP don't need to agree on pumps.
 */

export type PumpEvent = {
  /** Event firing time, performance.now() — used for HUD widget timing. */
  t: number
  /** 0..1 strength score, blends upward-velocity excess with forward-
   *  speed fraction. The HUD widget uses this to scale its flash
   *  intensity; the audio engine uses it to pick the chord layer. */
  strength: number
}

export type WavePumpSample = {
  /** Bike-on-water-and-grounded for this tick, per HoverState. */
  surfaceIsWater: boolean
  isGrounded: boolean
  /** World-Y velocity component (positive = upward). */
  vy: number
  /** Horizontal speed in m/s. */
  forwardSpeed: number
  /** Bike's configured top speed (m/s). */
  topSpeed: number
  /** This-frame throttle, 0..1. */
  throttle: number
}

export type DetectorTuning = {
  /** Minimum upward velocity at launch (m/s). Below this the bike just
   *  skipped off the wave rather than getting lifted. */
  minVy: number
  /** Minimum forward speed as a fraction of bike top speed. Filters
   *  out lazy crest-floats while keeping the bar low enough that mid-
   *  game wave-reading still rewards the player. */
  minSpeedFrac: number
  /** Minimum throttle this tick. The signal is "you rode the wave
   *  *intentionally*", which means hands on the gas. */
  minThrottle: number
  /** Per-bike cooldown (ms). 500 ms is long enough that back-to-back
   *  wavelet hops don't double-fire, short enough that a deliberate
   *  pump every other wave on a heavy swell still reads. */
  cooldownMs: number
  /** vy at which strength saturates to 1.0. */
  vyCeiling: number
}

export const DEFAULT_DETECTOR_TUNING: Readonly<DetectorTuning> = Object.freeze({
  minVy: 1.5,
  minSpeedFrac: 0.45,
  minThrottle: 0.4,
  cooldownMs: 500,
  vyCeiling: 7,
})

export type WavePumpObserver = {
  /** Feed this frame's sample. Returns a `PumpEvent` on the tick the
   *  bike just launched off a crest cleanly; otherwise null. */
  detect(now: number, sample: WavePumpSample): PumpEvent | null
  /** Reset between races / respawns. */
  reset(): void
  /** Read-only view of internal state — exposed for tests. */
  debug(): { wasOnWater: boolean; lastFireAt: number }
}

export function createWavePumpObserver(
  tuning: DetectorTuning = DEFAULT_DETECTOR_TUNING,
): WavePumpObserver {
  let wasOnWater = false
  let lastFireAt = Number.NEGATIVE_INFINITY

  return {
    detect(now, s) {
      // Edge: just transitioned from on-water-grounded to airborne.
      const transitionedOff = wasOnWater && !s.isGrounded
      wasOnWater = s.surfaceIsWater && s.isGrounded
      if (!transitionedOff) return null

      // Cooldown gate — keeps a rapid chain of wavelet hops from
      // spamming the HUD/audio.
      if (now - lastFireAt < tuning.cooldownMs) return null

      // Must be going up at speed under throttle.
      if (s.vy < tuning.minVy) return null
      if (s.topSpeed <= 0) return null
      const speedFrac = Math.max(0, Math.min(1, s.forwardSpeed / s.topSpeed))
      if (speedFrac < tuning.minSpeedFrac) return null
      if (s.throttle < tuning.minThrottle) return null

      // Strength = how much vy clears the floor × how fast we're going.
      // Squared on the vy side so really clean crests pop visually.
      const vyT = Math.max(
        0,
        Math.min(1, (s.vy - tuning.minVy) / (tuning.vyCeiling - tuning.minVy)),
      )
      const strength = Math.max(0.2, Math.min(1, vyT * speedFrac + 0.2))

      lastFireAt = now
      return { t: now, strength }
    },
    reset() {
      wasOnWater = false
      lastFireAt = Number.NEGATIVE_INFINITY
    },
    debug() {
      return { wasOnWater, lastFireAt }
    },
  }
}
