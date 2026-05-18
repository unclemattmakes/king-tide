import { describe, expect, it } from 'vitest'
import {
  createWavePumpObserver,
  DEFAULT_DETECTOR_TUNING,
  type WavePumpSample,
} from '../../src/engine/wave-pump-observer'

/** Sensible default sample — "riding a wave with throttle held, not
 *  yet airborne". Tests override the fields relevant to each scenario. */
function rideSample(over: Partial<WavePumpSample> = {}): WavePumpSample {
  return {
    surfaceIsWater: true,
    isGrounded: true,
    vy: 0,
    forwardSpeed: 22,
    topSpeed: 28,
    throttle: 0.9,
    ...over,
  }
}

/** Default sample for the airborne tick that follows. */
function airSample(over: Partial<WavePumpSample> = {}): WavePumpSample {
  return {
    surfaceIsWater: true,
    isGrounded: false,
    vy: 4,
    forwardSpeed: 22,
    topSpeed: 28,
    throttle: 0.9,
    ...over,
  }
}

describe('createWavePumpObserver', () => {
  it('fires on a clean crest launch (water+grounded → airborne with vy)', () => {
    const obs = createWavePumpObserver()
    expect(obs.detect(0, rideSample())).toBeNull()
    const ev = obs.detect(50, airSample())
    expect(ev).not.toBeNull()
    expect(ev?.strength).toBeGreaterThan(0)
    expect(ev?.strength).toBeLessThanOrEqual(1)
    expect(ev?.t).toBe(50)
  })

  it('does not fire on the first airborne sample when never on water', () => {
    const obs = createWavePumpObserver()
    // First call sees an airborne sample with no prior "on water" tick.
    expect(obs.detect(0, airSample())).toBeNull()
  })

  it('does not fire when vy is below the floor', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample())
    expect(obs.detect(50, airSample({ vy: 1.0 }))).toBeNull()
  })

  it('does not fire when forward speed is too low', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample({ forwardSpeed: 4 }))
    // At topSpeed 28 the floor is 0.45 → ~12.6 m/s; 8 m/s is below it.
    expect(obs.detect(50, airSample({ forwardSpeed: 8 }))).toBeNull()
  })

  it('does not fire when the player is coasting (throttle below floor)', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample({ throttle: 0.1 }))
    expect(obs.detect(50, airSample({ throttle: 0.1 }))).toBeNull()
  })

  it('does not fire when leaving a hard surface (surfaceIsWater === false)', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample({ surfaceIsWater: false }))
    // Even though the bike transitions to airborne with all the speed
    // and vy a water pump would need, the previous surface was land.
    expect(obs.detect(50, airSample({ surfaceIsWater: false }))).toBeNull()
  })

  it('respects the cooldown — back-to-back launches do not double-fire', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample())
    const first = obs.detect(50, airSample())
    expect(first).not.toBeNull()

    // Touch back down + relaunch well inside the cooldown window.
    obs.detect(120, rideSample())
    const second = obs.detect(170, airSample())
    expect(second).toBeNull()
  })

  it('allows a second pump once the cooldown has elapsed', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample())
    expect(obs.detect(50, airSample())).not.toBeNull()

    obs.detect(700, rideSample())
    expect(obs.detect(750, airSample())).not.toBeNull()
  })

  it('saturates strength to 1 at high vy + max speed', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample())
    const ev = obs.detect(50, airSample({ vy: 12, forwardSpeed: 28 }))
    expect(ev).not.toBeNull()
    expect(ev?.strength).toBeCloseTo(1, 2)
  })

  it('reset() clears the on-water memory and the cooldown', () => {
    const obs = createWavePumpObserver()
    obs.detect(0, rideSample())
    obs.detect(50, airSample())
    obs.reset()
    expect(obs.debug().wasOnWater).toBe(false)
    // After reset the next airborne tick alone should not fire (we need
    // a prior on-water tick to record the launch transition).
    expect(obs.detect(60, airSample())).toBeNull()
  })

  it('tunables override the defaults', () => {
    const obs = createWavePumpObserver({
      ...DEFAULT_DETECTOR_TUNING,
      minVy: 3.5,
    })
    obs.detect(0, rideSample())
    // vy=2 cleared the default 1.5 floor but not the custom 3.5 one.
    expect(obs.detect(50, airSample({ vy: 2 }))).toBeNull()
  })
})
