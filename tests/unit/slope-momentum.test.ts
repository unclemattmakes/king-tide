/**
 * Slope-momentum regression — ac1bd4e introduced asymmetric "motocross"
 * slope momentum. The first cut keyed off the chassis's current `fwd.y`,
 * which folds in the player's Q/E pitch input. That let the rider farm
 * free downhill thrust on flat ground by diving the nose. The helper
 * `slopeMomentumAccel` now reads only the terrain-tracking pitch target,
 * so flat ground is flat ground no matter how the chassis is angled.
 */
import { describe, expect, it } from 'vitest'
import { SLOPE_DOWN_GAIN, SLOPE_UP_BRAKE, slopeMomentumAccel } from '@/game/systems/hover'

const GRAVITY = 25
const deg = (d: number) => (d * Math.PI) / 180

describe('slopeMomentumAccel', () => {
  it('is zero on flat terrain', () => {
    // The whole regression in one assertion: flat terrain → zero slope
    // contribution, regardless of any other state. The helper's signature
    // only accepts the surface-tracking pitch, so player input cannot
    // reach this calculation at all.
    expect(slopeMomentumAccel(0)).toBe(0)
  })

  it('accelerates the bike forward on a downslope', () => {
    // 16° descending ramp: surfacePitchTarget > 0 (nose-down).
    const a = slopeMomentumAccel(deg(16))
    expect(a).toBeGreaterThan(0)
    // Expected magnitude: sin(16°) · GRAVITY · DOWN_GAIN ≈ 6.89 m/s²
    expect(a).toBeCloseTo(Math.sin(deg(16)) * GRAVITY * SLOPE_DOWN_GAIN, 5)
  })

  it('decelerates the bike on an upslope', () => {
    // 16° climbing ramp: surfacePitchTarget < 0 (nose-up).
    const a = slopeMomentumAccel(deg(-16))
    expect(a).toBeLessThan(0)
    expect(a).toBeCloseTo(Math.sin(deg(-16)) * GRAVITY * SLOPE_UP_BRAKE, 5)
  })

  it('pushes downhill harder than it brakes uphill at the same angle', () => {
    // Motocross asymmetry: the slingshot exceeds the climb tax.
    const down = slopeMomentumAccel(deg(16))
    const up = slopeMomentumAccel(deg(-16))
    expect(down).toBeGreaterThan(Math.abs(up))
    // And specifically by the gain ratio.
    expect(down / Math.abs(up)).toBeCloseTo(SLOPE_DOWN_GAIN / SLOPE_UP_BRAKE, 5)
  })

  it('scales monotonically with slope steepness', () => {
    const accels = [2, 6, 12, 20, 30].map((d) => slopeMomentumAccel(deg(d)))
    for (let i = 1; i < accels.length; i++) {
      const curr = accels[i] as number
      const prev = accels[i - 1] as number
      expect(curr).toBeGreaterThan(prev)
    }
  })

  it('does not exceed gravity even at a 90° dive', () => {
    // Upper bound sanity: sin(π/2) · GRAVITY · DOWN_GAIN = 25 m/s².
    expect(slopeMomentumAccel(Math.PI / 2)).toBeCloseTo(GRAVITY * SLOPE_DOWN_GAIN, 5)
  })

  it('accepts custom gravity / gain overrides for tuning sweeps', () => {
    // Sanity: helper is pure and parameterizable so tuning experiments
    // don't have to fork the production constants.
    expect(slopeMomentumAccel(deg(16), 10, 2.0, 0.0)).toBeCloseTo(Math.sin(deg(16)) * 10 * 2.0, 5)
  })
})
