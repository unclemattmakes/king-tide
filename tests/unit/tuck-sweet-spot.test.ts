/**
 * Tuck sweet-spot curve — `tuckFactor` in `src/game/systems/hover.ts`.
 *
 * Tuck has no button: it's read off the nose-down (pitch-forward) lean,
 * the same `max(-intent.pitch, 0)` signal the dive-aid uses to sink ride
 * height. The factor is the skill curve — feather the lean toward the
 * sweet spot for the full speed payoff, bury the nose and it inverts into
 * a belly-scrape penalty. These tests pin the shape so a tuning nudge to
 * the constants can't silently flip the sign of the payoff.
 */
import { describe, expect, it } from 'vitest'
import { TUCK_SCRAPE_FLOOR, TUCK_SWEET_SPOT, tuckFactor } from '@/game/systems/hover'

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
})
