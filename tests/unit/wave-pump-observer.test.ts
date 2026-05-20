import { describe, expect, it } from 'vitest'
import {
  createWavePumpObserver,
  MIN_VY_PEAK,
  strengthFromTakeoffVy,
  VY_STRENGTH_CEILING,
  type WavePumpSample,
} from '../../src/engine/wave-pump-observer'

/**
 * Under the airborne-gated trick model the wave-pump observer is a thin
 * shim: the sim's `trickHopSystem` has already decided whether this tick
 * fires a credible trick, and the observer's job is to translate that
 * flag into a `PumpEvent` for the HUD / audio / FX layer. End-to-end
 * trick eligibility is exercised in `trick-hop.test.ts`.
 */

function sample(over: Partial<WavePumpSample> = {}): WavePumpSample {
  return {
    trickFiredThisTick: false,
    trickFiredStrength: 0,
    trickFiredDirection: 0,
    ...over,
  }
}

describe('strengthFromTakeoffVy', () => {
  it('returns 0 below the qualifying threshold', () => {
    expect(strengthFromTakeoffVy(0)).toBe(0)
    expect(strengthFromTakeoffVy(MIN_VY_PEAK - 0.01)).toBe(0)
  })

  it('floors at 0.4 at the qualifying threshold so a minimal trick still feels rewarding', () => {
    expect(strengthFromTakeoffVy(MIN_VY_PEAK)).toBeCloseTo(0.4, 2)
  })

  it('scales linearly from threshold to ceiling', () => {
    const mid = (MIN_VY_PEAK + VY_STRENGTH_CEILING) / 2
    expect(strengthFromTakeoffVy(mid)).toBeCloseTo(0.7, 2)
  })

  it('saturates at 1.0 once vy reaches the ceiling', () => {
    expect(strengthFromTakeoffVy(VY_STRENGTH_CEILING)).toBeCloseTo(1, 5)
    expect(strengthFromTakeoffVy(VY_STRENGTH_CEILING + 5)).toBeCloseTo(1, 5)
  })
})

describe('createWavePumpObserver (sim → render shim)', () => {
  it('returns null on a quiet tick', () => {
    const obs = createWavePumpObserver()
    expect(obs.detect(0, sample())).toBeNull()
    expect(obs.detect(50, sample())).toBeNull()
  })

  it('relays the sim fire flag as a PumpEvent', () => {
    const obs = createWavePumpObserver()
    const ev = obs.detect(
      100,
      sample({
        trickFiredThisTick: true,
        trickFiredStrength: 0.7,
        trickFiredDirection: +1,
      }),
    )
    expect(ev).not.toBeNull()
    expect(ev?.t).toBe(100)
    expect(ev?.strength).toBeCloseTo(0.7, 5)
    expect(ev?.direction).toBe('right')
  })

  it('maps -1 to "left" and +1 to "right"', () => {
    const obs = createWavePumpObserver()
    const left = obs.detect(
      0,
      sample({
        trickFiredThisTick: true,
        trickFiredStrength: 0.5,
        trickFiredDirection: -1,
      }),
    )
    expect(left?.direction).toBe('left')
    const right = obs.detect(
      100,
      sample({
        trickFiredThisTick: true,
        trickFiredStrength: 0.5,
        trickFiredDirection: +1,
      }),
    )
    expect(right?.direction).toBe('right')
  })

  it('clamps strength to [0,1]', () => {
    const obs = createWavePumpObserver()
    const high = obs.detect(
      0,
      sample({
        trickFiredThisTick: true,
        trickFiredStrength: 2.5,
        trickFiredDirection: +1,
      }),
    )
    expect(high?.strength).toBe(1)
    const low = obs.detect(
      100,
      sample({
        trickFiredThisTick: true,
        trickFiredStrength: -0.5,
        trickFiredDirection: +1,
      }),
    )
    expect(low?.strength).toBe(0)
  })

  it('records the last fire time for the debug view', () => {
    const obs = createWavePumpObserver()
    expect(obs.debug().lastFireAt).toBe(Number.NEGATIVE_INFINITY)
    obs.detect(
      42,
      sample({
        trickFiredThisTick: true,
        trickFiredStrength: 0.5,
        trickFiredDirection: +1,
      }),
    )
    expect(obs.debug().lastFireAt).toBe(42)
  })

  it('reset() clears the debug last-fire timestamp', () => {
    const obs = createWavePumpObserver()
    obs.detect(
      50,
      sample({
        trickFiredThisTick: true,
        trickFiredStrength: 0.5,
        trickFiredDirection: +1,
      }),
    )
    obs.reset()
    expect(obs.debug().lastFireAt).toBe(Number.NEGATIVE_INFINITY)
  })
})
