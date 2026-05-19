/**
 * Trick-boost event detector.
 *
 * Replaces the original auto-fire crest detector. The new model is
 * MK8-style: the player presses a trick button (L1 / R1 on gamepad,
 * Z / C on keyboard) and the observer decides whether that press
 * deserves an immediate boost.
 *
 * Gating, same as the old observer's reward rules:
 *
 *   - **vy peak** — the bike must have been climbing (vy > minVyPeak)
 *     in the recent past. Pressing while riding up a swell or cresting
 *     a ramp pays off; flat-ground presses fire the hop but no boost.
 *   - **speed + throttle** — the player has to be moving and on the
 *     gas. Catches the "deliberate" cases and rejects coasting/parked
 *     bikes.
 *   - **trick-button rising edge** — only fresh presses count. Holding
 *     L1 doesn't auto-arm every crest.
 *
 * Boost fires **on the press**, not on landing — the older landing-
 * gated model felt laggy because the speed payoff arrived after the
 * spin had already played out. Fire-on-press tightens the feedback
 * loop: press the button at the apex → immediate FOV punch + forward
 * impulse while the bike is still mid-trick, exactly like MK8.
 *
 * Lives on the render side, not the sim. Pump events are pure feedback
 * — no determinism dependency, no replay obligation — so they don't
 * belong in `simulateStep`. The game loop reads the trick observer
 * each render frame and forwards the boost event to FX + audio +
 * physics-impulse.
 */

export type PumpEvent = {
  /** Event firing time, performance.now() — used for HUD widget timing. */
  t: number
  /** 0..1 strength score. Blends the peak upward velocity reached
   *  before the trick was armed with the forward-speed fraction. HUD
   *  scales flash intensity off this; audio picks chord layer; physics
   *  scales the forward kick. */
  strength: number
  /** Which side the player pressed for the trick — drives the visual
   *  spin direction in the bike render and the HUD's left/right
   *  indicator. */
  direction: 'left' | 'right'
}

export type WavePumpSample = {
  /** Bike-on-water-and-grounded for this tick, per HoverState. Routed
   *  to audio palette choices downstream; no longer gates firing. */
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
  /** Held state of the two trick buttons. The observer detects rising
   *  edges internally — held-down does not re-arm. */
  trickLeft: boolean
  trickRight: boolean
  /** True when the bike is in the airborne arc of a previous hop —
   *  the sim sets this on `TrickState.hopLockoutActive`. While locked,
   *  the observer's vy-peak tracker ignores updates because the
   *  bike's lift comes from its own impulse, not a surface climb.
   *  Without this gate every hop's velocity registers as a credible
   *  "peak" for the next press, turning flat-road bunny-hops into
   *  free tricks. */
  hopLockedOut: boolean
}

export type DetectorTuning = {
  /** Peak upward velocity (m/s) the bike must have reached recently for
   *  a trick to count as a crest hop. Below this it was just chop / a
   *  flat hop, no boost. */
  minVyPeak: number
  /** Minimum forward speed as a fraction of bike top speed. Catches
   *  "deliberate" tricks; rejects coasting / parked bikes. */
  minSpeedFrac: number
  /** Minimum throttle this tick. */
  minThrottle: number
  /** Per-bike cooldown (ms) between boost events. Long enough that
   *  back-to-back trick spam doesn't double-fire; short enough that
   *  chaining tricks across a swell train still reads. */
  cooldownMs: number
  /** vy peak at which strength saturates to 1.0. */
  vyCeiling: number
  /** How long (ms) a "recent climb" peak stays valid for arming. After
   *  this window the peak resets — protects against landing a boost
   *  from a crest the player rode 3 seconds ago. */
  peakStaleMs: number
}

export const DEFAULT_DETECTOR_TUNING: Readonly<DetectorTuning> = Object.freeze({
  // Raised to 5.0 m/s — 2.5 was still tripping on wave chop during
  // top-speed runs across The Maw, so almost every hop registered as
  // a trick. 5.0 m/s requires either a real wave crest climb or a
  // ramp launch — the kind of vertical velocity you only see when
  // the surface is genuinely lifting the bike.
  minVyPeak: 5.0,
  minSpeedFrac: 0.35,
  minThrottle: 0.3,
  cooldownMs: 500,
  // Bumped alongside `minVyPeak` so the strength score has room to
  // scale between "ridable swell" (5–6 m/s) and "seaplane ramp"
  // (~9 m/s). Saturation reserved for the biggest launches.
  vyCeiling: 9.0,
  // Tightened from 800 → 300 ms. The press has to land WHILE the
  // bike is still on the rising face of the crest, not a beat after
  // it's already started falling — turns the trick into a deliberate
  // apex-timing input instead of "you crested half a second ago,
  // here's your reward".
  peakStaleMs: 300,
})

export type WavePumpObserver = {
  /** Feed this frame's sample. Returns a `PumpEvent` on the tick a
   *  good-timing trick press is detected; otherwise null. */
  detect(now: number, sample: WavePumpSample): PumpEvent | null
  /** Reset between races / respawns. */
  reset(): void
  /** Read-only view of internal state — exposed for tests. */
  debug(): {
    vyPeakInWindow: number
    vyPeakAt: number
    lastFireAt: number
  }
}

export function createWavePumpObserver(
  tuning: DetectorTuning = DEFAULT_DETECTOR_TUNING,
): WavePumpObserver {
  // Peak vy seen during the current lift phase. Holds for `peakStaleMs`
  // so the player can press the button at the very top of the climb
  // OR a beat after the crest passes and still be inside the window.
  let vyPeakInWindow = 0
  let vyPeakAt = Number.NEGATIVE_INFINITY
  // Edge-detect bookkeeping for the trick buttons.
  let prevLeftDown = false
  let prevRightDown = false
  let lastFireAt = Number.NEGATIVE_INFINITY

  return {
    detect(now, s) {
      // Track the highest vy seen during this lift phase. Reset the
      // peak once it goes stale so an old crest can't pay off a much-
      // later flat-ground press. While the bike is in a post-hop
      // lockout, all updates are ignored AND any existing peak is
      // drained — the lift comes from the hop's own impulse, not a
      // surface climb, and counting it would let every hop self-arm
      // a credible trick for the next press.
      if (s.hopLockedOut) {
        vyPeakInWindow = 0
        vyPeakAt = Number.NEGATIVE_INFINITY
      } else {
        if (s.vy > 0) {
          if (s.vy > vyPeakInWindow) {
            vyPeakInWindow = s.vy
            vyPeakAt = now
          }
        }
        if (now - vyPeakAt > tuning.peakStaleMs) {
          vyPeakInWindow = 0
          vyPeakAt = Number.NEGATIVE_INFINITY
        }
      }

      // Trick-button rising edges. Held-down does NOT re-fire —
      // released-and-re-pressed is the only way to register intent.
      const leftEdge = s.trickLeft && !prevLeftDown
      const rightEdge = s.trickRight && !prevRightDown
      prevLeftDown = s.trickLeft
      prevRightDown = s.trickRight

      if (!leftEdge && !rightEdge) return null

      // Cooldown — keep a rapid chain of credible presses from stacking
      // boosts inside the same half-second window.
      if (now - lastFireAt < tuning.cooldownMs) return null

      const speedFrac = s.topSpeed > 0 ? Math.max(0, Math.min(1, s.forwardSpeed / s.topSpeed)) : 0
      const inApex = vyPeakInWindow >= tuning.minVyPeak
      const credible =
        inApex && speedFrac >= tuning.minSpeedFrac && s.throttle >= tuning.minThrottle
      if (!credible) return null

      // Strength blends "how high did the peak go" with "how fast are
      // you going". Floor at 0.2 so even a minimum-credible trick
      // still produces a perceptible flash + kick.
      const vyT = Math.max(
        0,
        Math.min(
          1,
          (vyPeakInWindow - tuning.minVyPeak) /
            Math.max(0.0001, tuning.vyCeiling - tuning.minVyPeak),
        ),
      )
      const strength = Math.max(0.2, Math.min(1, vyT * speedFrac + 0.2))
      // Left wins a same-tick double-press, matching the sim-side
      // trick-hop system's tie-break so the visual spin direction and
      // the boost event agree.
      const direction: 'left' | 'right' = leftEdge ? 'left' : 'right'

      lastFireAt = now
      // Drain the peak so a single climb only pays off once — the next
      // boost needs a fresh climb to arm.
      vyPeakInWindow = 0
      vyPeakAt = Number.NEGATIVE_INFINITY

      return { t: now, strength, direction }
    },
    reset() {
      vyPeakInWindow = 0
      vyPeakAt = Number.NEGATIVE_INFINITY
      prevLeftDown = false
      prevRightDown = false
      lastFireAt = Number.NEGATIVE_INFINITY
    },
    debug() {
      return { vyPeakInWindow, vyPeakAt, lastFireAt }
    },
  }
}
