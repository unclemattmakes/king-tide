/**
 * Drift yaw — pure-helper tests for `driftYawFraction`.
 *
 * This is the math that decides how hard the bike carves while
 * drifting. The headline behaviours pinned here (and the bug they
 * fix): holding AWAY from the corner must OPEN the drift to a wide /
 * straight line rather than spiralling tighter, and a drift that has
 * bled speed must stop auto-rotating so the bike doesn't whip to a
 * 180.
 *
 * Returned value is a fraction of `stats.turnTorque` (the hover
 * system multiplies by turnTorque + the water turnMul). Sign matches
 * the non-drift path: a left drift (driftDir=-1) yields a positive
 * fraction, same as a left steer.
 */

import { describe, expect, it } from 'vitest'
import {
  DRIFT_YAW_BIAS_FRAC,
  DRIFT_YAW_SPEED_REF,
  driftYawFraction,
} from '../../src/game/systems/hover'

// Player steer is pre-scaled by PLAYER_STEER_SCALE (0.7) before it
// reaches the sim, so a "full" stick reads ~0.7 here.
const FULL_STICK = 0.7
const FAST = DRIFT_YAW_SPEED_REF + 5 // above the speed-taper knee

describe('driftYawFraction — direction + sign', () => {
  it('a left drift with no steer carves left (positive fraction)', () => {
    const f = driftYawFraction(-1, 0, 1, undefined, FAST)
    expect(f).toBeGreaterThan(0)
    expect(f).toBeCloseTo(DRIFT_YAW_BIAS_FRAC, 5)
  })

  it('a right drift with no steer carves right (negative fraction)', () => {
    const f = driftYawFraction(1, 0, 1, undefined, FAST)
    expect(f).toBeLessThan(0)
    expect(f).toBeCloseTo(-DRIFT_YAW_BIAS_FRAC, 5)
  })
})

describe('driftYawFraction — counter-steer opens the drift (the bug fix)', () => {
  it('holding AWAY from a left drift cancels the turn-in to ~0 (wide/straight line)', () => {
    // Left drift (driftDir=-1); counter-steer = steer RIGHT (positive).
    const f = driftYawFraction(-1, +FULL_STICK, 1, undefined, FAST)
    // Near zero — the bike opens to a wide line instead of spiralling.
    expect(Math.abs(f)).toBeLessThan(0.1)
  })

  it('holding AWAY from a right drift cancels the turn-in to ~0', () => {
    const f = driftYawFraction(1, -FULL_STICK, 1, undefined, FAST)
    expect(Math.abs(f)).toBeLessThan(0.1)
  })

  it('steering INTO a left drift tightens it well past the neutral bias', () => {
    const neutral = driftYawFraction(-1, 0, 1, undefined, FAST)
    const into = driftYawFraction(-1, -FULL_STICK, 1, undefined, FAST)
    expect(into).toBeGreaterThan(neutral)
    // Both carve the same way (positive); steering in is the larger.
    expect(into).toBeGreaterThan(0)
  })

  it('monotonic across the steer range — counter-steer always opens, steer-in always tightens', () => {
    const dir = -1 // left drift
    const hardCounter = driftYawFraction(dir, +FULL_STICK, 1, undefined, FAST)
    const softCounter = driftYawFraction(dir, +0.3, 1, undefined, FAST)
    const neutral = driftYawFraction(dir, 0, 1, undefined, FAST)
    const softInto = driftYawFraction(dir, -0.3, 1, undefined, FAST)
    const hardInto = driftYawFraction(dir, -FULL_STICK, 1, undefined, FAST)
    // Strictly increasing turn-in from counter → into.
    expect(hardCounter).toBeLessThan(softCounter)
    expect(softCounter).toBeLessThan(neutral)
    expect(neutral).toBeLessThan(softInto)
    expect(softInto).toBeLessThan(hardInto)
  })
})

describe('driftYawFraction — low-speed taper (no 180 spin-out)', () => {
  it('the auto-turn-in bias vanishes at zero speed', () => {
    const f = driftYawFraction(-1, 0, 1, undefined, 0)
    expect(f).toBe(0)
  })

  it('bias scales linearly up to the reference speed', () => {
    const half = driftYawFraction(-1, 0, 1, undefined, DRIFT_YAW_SPEED_REF / 2)
    expect(half).toBeCloseTo(DRIFT_YAW_BIAS_FRAC / 2, 5)
  })

  it('bias saturates at full strength above the reference speed', () => {
    const atRef = driftYawFraction(-1, 0, 1, undefined, DRIFT_YAW_SPEED_REF)
    const wayPast = driftYawFraction(-1, 0, 1, undefined, DRIFT_YAW_SPEED_REF * 4)
    expect(atRef).toBeCloseTo(DRIFT_YAW_BIAS_FRAC, 5)
    expect(wayPast).toBeCloseTo(DRIFT_YAW_BIAS_FRAC, 5)
  })

  it('counter-steer keeps FULL authority even at low speed (player can always straighten)', () => {
    // At zero speed the bias is gone, so a counter-steer should still
    // produce a real opposite-direction yaw (not be tapered away).
    const f = driftYawFraction(-1, +FULL_STICK, 1, undefined, 0)
    expect(f).toBeLessThan(0)
  })
})

describe('driftYawFraction — inward archetype', () => {
  it('inward bikes spike the bias inside the initial window, then ease off', () => {
    const earlyOutward = driftYawFraction(-1, 0, 0.1, 'outward', FAST)
    const earlyInward = driftYawFraction(-1, 0, 0.1, 'inward', FAST)
    const lateInward = driftYawFraction(-1, 0, 1.0, 'inward', FAST)
    // Early in the drift the inward bike cuts harder than the kart.
    expect(earlyInward).toBeGreaterThan(earlyOutward)
    // Later it eases below the early spike (wider tail).
    expect(lateInward).toBeLessThan(earlyInward)
  })
})
