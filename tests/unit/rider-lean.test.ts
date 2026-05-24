/**
 * Rider drift-lean — pure-helper tests for `driftLeanTarget`.
 *
 * Pins the bank curve: the rider leans toward the drift direction,
 * deeper when steering INTO the turn, shallower on counter-steer, and
 * sits upright when not drifting. Sign + clamp behaviour are pinned so
 * a tuning edit can't silently invert or unbound the lean.
 */

import { describe, expect, it } from 'vitest'
import { driftLeanTarget, RIDER_POSE_TUNING } from '../../src/game/systems/rider-pose'

const T = RIDER_POSE_TUNING
// Player steer is pre-scaled to ~0.7 max before the sim sees it.
const FULL_STICK = 0.7

describe('driftLeanTarget — not drifting', () => {
  it('returns 0 when driftDir is 0 (rider stays upright)', () => {
    expect(driftLeanTarget(0, 0)).toBe(0)
    expect(driftLeanTarget(0, 0.7)).toBe(0)
    expect(driftLeanTarget(0, -0.7)).toBe(0)
  })
})

describe('driftLeanTarget — direction + symmetry', () => {
  it('left and right drift lean opposite ways with equal magnitude', () => {
    const left = driftLeanTarget(-1, 0)
    const right = driftLeanTarget(1, 0)
    expect(Math.sign(left)).toBe(-Math.sign(right))
    expect(Math.abs(left)).toBeCloseTo(Math.abs(right), 6)
  })

  it('neutral-steer mid-drift leans by the base amount', () => {
    expect(Math.abs(driftLeanTarget(-1, 0))).toBeCloseTo(T.driftLeanBase, 6)
    expect(Math.abs(driftLeanTarget(1, 0))).toBeCloseTo(T.driftLeanBase, 6)
  })
})

describe('driftLeanTarget — into vs counter steer', () => {
  it('steering INTO a left drift deepens the lean past neutral', () => {
    // Left drift → steering in = steer LEFT (negative).
    const neutral = Math.abs(driftLeanTarget(-1, 0))
    const into = Math.abs(driftLeanTarget(-1, -FULL_STICK))
    expect(into).toBeGreaterThan(neutral)
  })

  it('counter-steering a left drift shallows the lean below neutral', () => {
    const neutral = Math.abs(driftLeanTarget(-1, 0))
    const counter = Math.abs(driftLeanTarget(-1, +FULL_STICK))
    expect(counter).toBeLessThan(neutral)
  })

  it('the same gradient holds mirrored on a right drift', () => {
    const neutral = Math.abs(driftLeanTarget(1, 0))
    const into = Math.abs(driftLeanTarget(1, +FULL_STICK)) // into = steer RIGHT
    const counter = Math.abs(driftLeanTarget(1, -FULL_STICK))
    expect(into).toBeGreaterThan(neutral)
    expect(counter).toBeLessThan(neutral)
  })

  it('lean magnitude is monotonic from full-counter → full-into', () => {
    const dir = -1
    const hardCounter = Math.abs(driftLeanTarget(dir, +FULL_STICK))
    const neutral = Math.abs(driftLeanTarget(dir, 0))
    const hardInto = Math.abs(driftLeanTarget(dir, -FULL_STICK))
    expect(hardCounter).toBeLessThan(neutral)
    expect(neutral).toBeLessThan(hardInto)
  })
})

describe('driftLeanTarget — clamps', () => {
  it('never exceeds the max bank even on an over-range steer', () => {
    // Steer beyond the normal pre-scaled range — AI can feed ±1.
    expect(Math.abs(driftLeanTarget(-1, -1))).toBeLessThanOrEqual(T.driftLeanMax + 1e-9)
  })

  it('never drops below the min bank even on hard counter-steer', () => {
    expect(Math.abs(driftLeanTarget(-1, 1))).toBeGreaterThanOrEqual(T.driftLeanMin - 1e-9)
  })
})
