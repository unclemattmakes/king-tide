import { describe, expect, it } from 'vitest'
import {
  createWavePumpObserver,
  DEFAULT_DETECTOR_TUNING,
  type WavePumpSample,
} from '../../src/engine/wave-pump-observer'

/**
 * Fire-on-press observer: a boost event fires the moment a trick-button
 * rising edge arrives while the bike is in a valid apex window (recent
 * vy peak + speed + throttle). No landing detection — the player gets
 * the speed payoff while still mid-trick, matching MK8 feel.
 *
 * `climbSample` is a rising tick (vy > 0). `restSample` is flat / no
 * recent climb. Tests compose presses against these states.
 */
function climbSample(over: Partial<WavePumpSample> = {}): WavePumpSample {
  return {
    surfaceIsWater: true,
    isGrounded: true,
    // Default vy=3.0 sits comfortably above the credibility floor
    // (2.5) so a generic "rising tick" represents a real wave climb
    // rather than borderline chop.
    vy: 3.0,
    forwardSpeed: 22,
    topSpeed: 28,
    throttle: 0.9,
    trickLeft: false,
    trickRight: false,
    ...over,
  }
}

function restSample(over: Partial<WavePumpSample> = {}): WavePumpSample {
  return {
    surfaceIsWater: true,
    isGrounded: true,
    vy: 0,
    forwardSpeed: 22,
    topSpeed: 28,
    throttle: 0.9,
    trickLeft: false,
    trickRight: false,
    ...over,
  }
}

describe('createWavePumpObserver (trick-driven, fire-on-press)', () => {
  it('fires on the press tick during a credible climb', () => {
    const obs = createWavePumpObserver()
    expect(obs.detect(0, climbSample())).toBeNull()
    // Press trickRight while still climbing → fires this same tick.
    const ev = obs.detect(50, climbSample({ vy: 3.0, trickRight: true }))
    expect(ev).not.toBeNull()
    expect(ev?.strength).toBeGreaterThan(0)
    expect(ev?.strength).toBeLessThanOrEqual(1)
    expect(ev?.direction).toBe('right')
    expect(ev?.t).toBe(50)
  })

  it('does not fire on a flat-ground press', () => {
    // Bike has been cruising on flat ground (vy 0). Press → no fire.
    // (The sim's trick-hop system still applies a hop impulse; the
    //  observer just doesn't grant the boost.)
    const obs = createWavePumpObserver()
    obs.detect(0, restSample())
    expect(obs.detect(50, restSample({ trickRight: true }))).toBeNull()
  })

  it('does not fire when the climb peak is too small', () => {
    const obs = createWavePumpObserver()
    // Tiny chop — vy peaks at 0.4, well below the default 0.7 floor.
    obs.detect(0, climbSample({ vy: 0.4 }))
    expect(obs.detect(50, climbSample({ vy: 0.4, trickRight: true }))).toBeNull()
  })

  it('does not fire when the player is coasting', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, climbSample({ throttle: 0.1 }))
    expect(obs.detect(50, climbSample({ throttle: 0.1, trickRight: true }))).toBeNull()
  })

  it('does not fire when forward speed is too low', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, climbSample({ forwardSpeed: 4 }))
    expect(obs.detect(50, climbSample({ forwardSpeed: 4, trickRight: true }))).toBeNull()
  })

  it('captures direction from the pressed button (left)', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, climbSample())
    const ev = obs.detect(50, climbSample({ vy: 3.0, trickLeft: true }))
    expect(ev?.direction).toBe('left')
  })

  it('left wins a same-tick double-press', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, climbSample())
    const ev = obs.detect(50, climbSample({ vy: 3.0, trickLeft: true, trickRight: true }))
    expect(ev?.direction).toBe('left')
  })

  it('held-down buttons do not re-fire — only fresh presses count', () => {
    const obs = createWavePumpObserver()
    // Hold trickRight from t=0 onward. The first sample's rising edge
    // would fire (if credible), but here the *first* tick has the
    // button already held → no edge.
    obs.detect(0, climbSample({ trickRight: true }))
    // Subsequent ticks: button still held, no fresh edge.
    expect(obs.detect(50, climbSample({ vy: 3.0, trickRight: true }))).toBeNull()
    expect(obs.detect(100, climbSample({ vy: 3.0, trickRight: true }))).toBeNull()
  })

  it('does not fire without a trick press, even on a clean crest', () => {
    // Headline behaviour change vs. the old auto-pump. Riding a crest
    // with no input gives no reward — no input, no boost.
    const obs = createWavePumpObserver()
    obs.detect(0, climbSample())
    expect(obs.detect(50, climbSample({ vy: 3.0 }))).toBeNull()
    expect(obs.detect(100, climbSample({ vy: 3.0 }))).toBeNull()
  })

  it('respects the cooldown between back-to-back tricks', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, climbSample())
    const first = obs.detect(50, climbSample({ vy: 3.0, trickRight: true }))
    expect(first).not.toBeNull()

    // Second press well inside the cooldown — release between presses
    // (rising-edge gate) and re-press; should be suppressed by cooldown.
    obs.detect(100, climbSample({ vy: 3.0, trickRight: false }))
    expect(obs.detect(200, climbSample({ vy: 3.0, trickRight: true }))).toBeNull()
  })

  it('allows another trick once the cooldown has elapsed', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, climbSample())
    expect(obs.detect(50, climbSample({ vy: 3.0, trickRight: true }))).not.toBeNull()

    // Release, rebuild the climb (firing drained the peak), wait past
    // the cooldown, then press again.
    obs.detect(100, climbSample({ vy: 0, trickRight: false }))
    obs.detect(550, climbSample({ vy: 3.0 }))
    expect(obs.detect(700, climbSample({ vy: 3.0, trickRight: true }))).not.toBeNull()
  })

  it('drains the climb peak after firing — same climb cannot pay off twice', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, climbSample())
    expect(obs.detect(50, climbSample({ vy: 3.0, trickRight: true }))).not.toBeNull()
    // Wait past the cooldown; bike still on the descending tail of the
    // same crest (vy now flat) and presses again — peak was drained on
    // the first fire, so no second boost.
    obs.detect(600, climbSample({ vy: 0, trickRight: false }))
    expect(obs.detect(700, climbSample({ vy: 0, trickRight: true }))).toBeNull()
  })

  it('saturates strength to 1 at high vy peak + max speed', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, climbSample({ vy: 6 }))
    const ev = obs.detect(50, climbSample({ vy: 6, forwardSpeed: 28, trickRight: true }))
    expect(ev).not.toBeNull()
    expect(ev?.strength).toBeCloseTo(1, 2)
  })

  it('reset() clears the peak + cooldown', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, climbSample({ vy: 3.0, trickRight: true }))
    obs.reset()
    const d = obs.debug()
    expect(d.vyPeakInWindow).toBe(0)
    expect(d.lastFireAt).toBe(Number.NEGATIVE_INFINITY)
  })

  it('tunables override the defaults', () => {
    const obs = createWavePumpObserver({
      ...DEFAULT_DETECTOR_TUNING,
      minVyPeak: 4,
    })
    // Peak of 2 cleared the default 0.7 floor but not the custom 4.
    obs.detect(0, climbSample({ vy: 2 }))
    expect(obs.detect(50, climbSample({ vy: 2, trickRight: true }))).toBeNull()
  })
})
