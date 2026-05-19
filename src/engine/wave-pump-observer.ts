/**
 * Wave-pump event detector.
 *
 * Watches the player bike each render frame and fires a `pump` event
 * on the moment a rising wave-crest just passed under the chassis —
 * the "ride the wave" beat of the Wave-Race-style loop.
 *
 * The trigger is a **vy peak**: the bike was lifting (vy > MIN_VY_PEAK)
 * a moment ago, and right now vy has crossed back to ≤ 0 (the swell
 * crested and is starting to fall away). At race speed under throttle
 * on water, that's exactly the instant a pump pays off.
 *
 * This replaces the original "transitioned from on-water to airborne"
 * trigger — which never fired with the v4 tame-swell preset because
 * the bike clings to the surface and rarely launches. Crest detection
 * still rewards the same player action (rode the swell at speed) but
 * fires continuously through a swell train, not just on the occasional
 * jump.
 *
 * Lives in the render-side loop, not the sim, because the rendered
 * surface (and therefore the precise vy curve under the chassis) can
 * drift from the sim's deterministic wave field. The game loop reads
 * this event to:
 *   - flash the wave-pump HUD widget
 *   - kick the audio engine
 *   - notify the tutorial director
 *   - apply a small forward impulse to the player's rigid body via
 *     the sim — see `pumpImpulse` in `game-loop.ts`
 */

export type PumpEvent = {
  /** Event firing time, performance.now() — used for HUD widget timing. */
  t: number
  /** 0..1 strength score. Blends the peak upward velocity reached
   *  before the crest with the forward-speed fraction. HUD scales
   *  flash intensity off this; audio picks chord layer; physics
   *  scales the forward kick. */
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
  /** Peak upward velocity (m/s) the bike must reach during the lift
   *  phase for a crest-pass to count as a real pump. Below this it
   *  was just surface chop, not a pumpable swell. */
  minVyPeak: number
  /** Minimum forward speed as a fraction of bike top speed. Filters
   *  out lazy crest-floats while keeping the bar low enough that mid-
   *  game wave-reading still rewards the player. */
  minSpeedFrac: number
  /** Minimum throttle this tick. The signal is "you rode the wave
   *  *intentionally*", which means hands on the gas. */
  minThrottle: number
  /** Per-bike cooldown (ms). 500 ms is long enough that successive
   *  wavelets on the same set don't double-fire, short enough that a
   *  deliberate pump every other wave on a moderate swell still reads. */
  cooldownMs: number
  /** vy peak at which strength saturates to 1.0. */
  vyCeiling: number
}

export const DEFAULT_DETECTOR_TUNING: Readonly<DetectorTuning> = Object.freeze({
  minVyPeak: 0.7,
  minSpeedFrac: 0.35,
  minThrottle: 0.3,
  cooldownMs: 500,
  vyCeiling: 3.5,
})

export type WavePumpObserver = {
  /** Feed this frame's sample. Returns a `PumpEvent` on the tick the
   *  bike just crossed a rising wave-crest under throttle; otherwise null. */
  detect(now: number, sample: WavePumpSample): PumpEvent | null
  /** Reset between races / respawns. */
  reset(): void
  /** Read-only view of internal state — exposed for tests. */
  debug(): { vyPeakInWindow: number; lastFireAt: number; vyPrev: number }
}

export function createWavePumpObserver(
  tuning: DetectorTuning = DEFAULT_DETECTOR_TUNING,
): WavePumpObserver {
  // Peak vy seen during the current lift phase. Resets to 0 every time
  // vy crosses below the rising threshold so a fresh swell can start
  // tracking. Without this we'd miss the strength of fast-rising crests
  // that briefly clear `minVyPeak` then drop.
  let vyPeakInWindow = 0
  let vyPrev = 0
  let lastFireAt = Number.NEGATIVE_INFINITY

  return {
    detect(now, s) {
      const wasRising = vyPrev > 0
      const crossedDown = wasRising && s.vy <= 0
      // Track the peak vy reached while the bike is lifting. Reset
      // whenever we're no longer in a rising phase so the next swell
      // starts clean.
      if (s.vy > 0) {
        if (s.vy > vyPeakInWindow) vyPeakInWindow = s.vy
      } else if (!crossedDown) {
        // We were already past the crest — keep the peak around for
        // the eventual `crossedDown` tick (typically same frame, but
        // jitter can push it a frame later). Reset once it's been
        // consumed below.
      }

      const localPeak = vyPeakInWindow
      vyPrev = s.vy

      if (!crossedDown) return null

      // Must have been on water, grounded, and under throttle at the
      // crest moment. The crest-pass is the visible reward beat; if
      // any of these miss the player didn't earn it.
      if (!s.surfaceIsWater || !s.isGrounded) {
        vyPeakInWindow = 0
        return null
      }
      if (s.throttle < tuning.minThrottle) {
        vyPeakInWindow = 0
        return null
      }
      if (s.topSpeed <= 0) {
        vyPeakInWindow = 0
        return null
      }
      const speedFrac = Math.max(0, Math.min(1, s.forwardSpeed / s.topSpeed))
      if (speedFrac < tuning.minSpeedFrac) {
        vyPeakInWindow = 0
        return null
      }
      if (localPeak < tuning.minVyPeak) {
        vyPeakInWindow = 0
        return null
      }

      // Reset the peak tracker so the next swell starts clean —
      // even if the cooldown gates this firing, the *next* pump
      // should be timed off a fresh lift.
      vyPeakInWindow = 0

      // Cooldown gate — keeps a rapid chain of small chop crests
      // from spamming the HUD/audio.
      if (now - lastFireAt < tuning.cooldownMs) return null

      // Strength blends "how high did the peak go" with "how fast
      // were you going". Both clamped to [0,1] before multiplication,
      // then floored at 0.2 so even minimum-credible crests still
      // produce a perceptible flash.
      const vyT = Math.max(
        0,
        Math.min(
          1,
          (localPeak - tuning.minVyPeak) / Math.max(0.0001, tuning.vyCeiling - tuning.minVyPeak),
        ),
      )
      const strength = Math.max(0.2, Math.min(1, vyT * speedFrac + 0.2))

      lastFireAt = now
      return { t: now, strength }
    },
    reset() {
      vyPeakInWindow = 0
      vyPrev = 0
      lastFireAt = Number.NEGATIVE_INFINITY
    },
    debug() {
      return { vyPeakInWindow, lastFireAt, vyPrev }
    },
  }
}
