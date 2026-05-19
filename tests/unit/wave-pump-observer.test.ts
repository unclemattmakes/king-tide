import { describe, expect, it } from 'vitest'
import {
  createWavePumpObserver,
  DEFAULT_DETECTOR_TUNING,
  type WavePumpSample,
} from '../../src/engine/wave-pump-observer'

/**
 * The crest-pass trigger walks the bike through a vy curve:
 *
 *   rise → peak → fall
 *
 * `rideSample` produces an "actively lifting on the rising face" tick.
 * `crestSample` produces the moment the peak passes — vy crossed back
 * down to ≤ 0. The observer fires on `crestSample` if the prior ticks
 * built up enough peak vy and the rider has throttle + speed.
 */
function rideSample(over: Partial<WavePumpSample> = {}): WavePumpSample {
  return {
    surfaceIsWater: true,
    isGrounded: true,
    vy: 2.0,
    forwardSpeed: 22,
    topSpeed: 28,
    throttle: 0.9,
    ...over,
  }
}

function crestSample(over: Partial<WavePumpSample> = {}): WavePumpSample {
  return {
    surfaceIsWater: true,
    isGrounded: true,
    vy: -0.1,
    forwardSpeed: 22,
    topSpeed: 28,
    throttle: 0.9,
    ...over,
  }
}

describe('createWavePumpObserver', () => {
  it('fires when a rising crest peaks and falls back through zero', () => {
    const obs = createWavePumpObserver()
    expect(obs.detect(0, rideSample())).toBeNull()
    const ev = obs.detect(50, crestSample())
    expect(ev).not.toBeNull()
    expect(ev?.strength).toBeGreaterThan(0)
    expect(ev?.strength).toBeLessThanOrEqual(1)
    expect(ev?.t).toBe(50)
  })

  it('does not fire on a downgoing tick without a prior rising tick', () => {
    const obs = createWavePumpObserver()
    expect(obs.detect(0, crestSample())).toBeNull()
  })

  it('does not fire when the lift never cleared the peak floor', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample({ vy: 0.4 }))
    expect(obs.detect(50, crestSample())).toBeNull()
  })

  it('does not fire when forward speed is too low', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample({ forwardSpeed: 4 }))
    expect(obs.detect(50, crestSample({ forwardSpeed: 4 }))).toBeNull()
  })

  it('does not fire when the player is coasting (throttle below floor)', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample({ throttle: 0.1 }))
    expect(obs.detect(50, crestSample({ throttle: 0.1 }))).toBeNull()
  })

  it('does not fire when leaving a hard surface (surfaceIsWater === false)', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample({ surfaceIsWater: false }))
    expect(obs.detect(50, crestSample({ surfaceIsWater: false }))).toBeNull()
  })

  it('does not fire while the bike is airborne (not grounded)', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample())
    expect(obs.detect(50, crestSample({ isGrounded: false }))).toBeNull()
  })

  it('respects the cooldown — back-to-back crests do not double-fire', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample())
    const first = obs.detect(50, crestSample())
    expect(first).not.toBeNull()
    // A second crest well inside the cooldown.
    obs.detect(100, rideSample())
    const second = obs.detect(150, crestSample())
    expect(second).toBeNull()
  })

  it('allows a second pump once the cooldown has elapsed', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample())
    expect(obs.detect(50, crestSample())).not.toBeNull()

    obs.detect(700, rideSample())
    expect(obs.detect(750, crestSample())).not.toBeNull()
  })

  it('saturates strength to 1 at high vy peak + max speed', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample({ vy: 6 }))
    const ev = obs.detect(50, crestSample({ forwardSpeed: 28 }))
    expect(ev).not.toBeNull()
    expect(ev?.strength).toBeCloseTo(1, 2)
  })

  it('reset() clears the peak tracker and the cooldown', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample())
    obs.detect(50, crestSample())
    obs.reset()
    expect(obs.debug().vyPeakInWindow).toBe(0)
    expect(obs.debug().vyPrev).toBe(0)
    // After reset, a fresh crest tick with no prior rise should not fire.
    expect(obs.detect(60, crestSample())).toBeNull()
  })

  it('tunables override the defaults', () => {
    const obs = createWavePumpObserver({
      ...DEFAULT_DETECTOR_TUNING,
      minVyPeak: 4,
    })
    obs.detect(0, rideSample({ vy: 2 }))
    // Peak of 2 cleared the default 0.7 floor but not the custom 4.
    expect(obs.detect(50, crestSample())).toBeNull()
  })
})
