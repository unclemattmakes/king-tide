/**
 * Tuck sweet-spot curve — `tuckFactor` in `src/game/systems/hover.ts`.
 *
 * Tuck has no button: it's read off the nose-down (pitch-forward) lean,
 * the same `max(-intent.pitch, 0)` signal the dive-aid uses to sink ride
 * height. The factor is the skill curve — feather the lean toward the
 * sweet spot for the full speed payoff, bury the nose and it inverts into
 * a belly-scrape penalty. These tests pin the shape so a tuning nudge to
 * the constants can't silently flip the sign of the payoff.
 *
 * The sweet spot is slope-aware: on a downslope it slides toward the
 * feathered end (`slopeAwareSweetSpot`) so the rewarded lean matches the
 * pitch the slope leaves room for. The second + third describe blocks pin
 * that slide + that the curve's peak tracks it.
 */
import { describe, expect, it } from 'vitest'
import {
  slopeAwareSweetSpot,
  TUCK_SCRAPE_FLOOR,
  TUCK_SWEET_SPOT,
  tuckFactor,
} from '@/game/systems/hover'
import { SLOPE_TUCK_REF, TUCK_SWEET_SPOT_MIN } from '@/game/systems/tuck-curve'

const deg = (d: number) => (d * Math.PI) / 180

describe('tuckFactor', () => {
  it('is zero with no nose-down lean', () => {
    expect(tuckFactor(0)).toBe(0)
    // Negative input (nose UP / wheelie) never tucks.
    expect(tuckFactor(-0.5)).toBe(0)
  })

  it('peaks at exactly 1.0 at the sweet spot', () => {
    expect(tuckFactor(TUCK_SWEET_SPOT)).toBeCloseTo(1, 12)
  })

  it('ramps up monotonically into the sweet spot', () => {
    const quarter = tuckFactor(TUCK_SWEET_SPOT * 0.25)
    const half = tuckFactor(TUCK_SWEET_SPOT * 0.5)
    const full = tuckFactor(TUCK_SWEET_SPOT)
    expect(quarter).toBeGreaterThan(0)
    expect(half).toBeGreaterThan(quarter)
    expect(full).toBeGreaterThan(half)
  })

  it('winds back down past the sweet spot and crosses zero before full lean', () => {
    // Just past the sweet spot it is still positive but falling.
    const justPast = tuckFactor(TUCK_SWEET_SPOT + (1 - TUCK_SWEET_SPOT) * 0.1)
    expect(justPast).toBeLessThan(1)
    expect(justPast).toBeGreaterThan(0)
    // Deep in the over-tuck band the factor has passed through zero (no
    // payoff, no penalty) and gone negative on its way to the scrape floor.
    expect(tuckFactor(TUCK_SWEET_SPOT + (1 - TUCK_SWEET_SPOT) * 0.85)).toBeLessThan(0)
  })

  it('bottoms out at the scrape floor when the nose is buried', () => {
    expect(tuckFactor(1)).toBeCloseTo(TUCK_SCRAPE_FLOOR, 12)
    // Clamps — input past full deflection stays at the floor.
    expect(tuckFactor(1.5)).toBeCloseTo(TUCK_SCRAPE_FLOOR, 12)
  })

  it('a feathered lean beats jamming the nose down', () => {
    // The whole mechanic in one assertion: just-shy-of-too-far is faster
    // than flooring the lean.
    expect(tuckFactor(TUCK_SWEET_SPOT)).toBeGreaterThan(tuckFactor(1))
  })

  it('defaults the sweet-spot argument to the flat-ground constant', () => {
    // The slope-aware overload must not change flat-ground behaviour: the
    // optional arg defaults to TUCK_SWEET_SPOT, so every legacy call site
    // (and the tests above) keep the exact same curve.
    for (const d of [0, 0.2, TUCK_SWEET_SPOT, 0.9, 1]) {
      expect(tuckFactor(d)).toBe(tuckFactor(d, TUCK_SWEET_SPOT))
    }
  })
})

describe('slopeAwareSweetSpot', () => {
  it('is the flat-ground sweet spot on level terrain', () => {
    expect(slopeAwareSweetSpot(0)).toBe(TUCK_SWEET_SPOT)
  })

  it('does not shift on an upslope (nose-up tangent)', () => {
    // Uphill = negative surfacePitchTarget. You rarely tuck climbing and
    // there is no scrape risk, so the notch stays put.
    expect(slopeAwareSweetSpot(deg(-10))).toBe(TUCK_SWEET_SPOT)
    expect(slopeAwareSweetSpot(deg(-30))).toBe(TUCK_SWEET_SPOT)
  })

  it('slides toward the feathered end on a downslope', () => {
    const shifted = slopeAwareSweetSpot(deg(14))
    expect(shifted).toBeLessThan(TUCK_SWEET_SPOT)
    expect(shifted).toBeGreaterThan(TUCK_SWEET_SPOT_MIN)
  })

  it('decreases monotonically as the descent steepens', () => {
    const sweets = [0, 5, 10, 18, 26].map((d) => slopeAwareSweetSpot(deg(d)))
    for (let i = 1; i < sweets.length; i++) {
      expect((sweets[i] as number) < (sweets[i - 1] as number)).toBe(true)
    }
  })

  it('saturates at the floor at and beyond the reference slope', () => {
    expect(slopeAwareSweetSpot(SLOPE_TUCK_REF)).toBeCloseTo(TUCK_SWEET_SPOT_MIN, 12)
    // Steeper than the reference stays pinned — no negative / sub-floor notch.
    expect(slopeAwareSweetSpot(SLOPE_TUCK_REF * 2)).toBeCloseTo(TUCK_SWEET_SPOT_MIN, 12)
  })
})

describe('tuckFactor with a slope-shifted sweet spot', () => {
  it('moves the peak to the shifted sweet spot', () => {
    const sweet = slopeAwareSweetSpot(deg(20))
    expect(tuckFactor(sweet, sweet)).toBeCloseTo(1, 12)
  })

  it('re-reads the flat-ground sweet input as over-tucked on a descent', () => {
    // The core fix: a 0.8 lean is the peak on flat ground, but on a steep
    // descent the sweet spot has slid below it — so the SAME deep lean now
    // reads as past-peak (lower factor), and feathering to the shifted
    // sweet spot is what pays.
    const sweet = slopeAwareSweetSpot(deg(24))
    expect(tuckFactor(sweet, sweet)).toBeGreaterThan(tuckFactor(TUCK_SWEET_SPOT, sweet))
  })

  it('still rewards feathering over jamming at the shifted sweet spot', () => {
    const sweet = slopeAwareSweetSpot(deg(24))
    expect(tuckFactor(sweet, sweet)).toBeGreaterThan(tuckFactor(1, sweet))
  })
})
