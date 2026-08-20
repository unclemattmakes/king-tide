/**
 * Launch/landing grade — pure curve + pitch-extraction pins for the
 * wave-mastery feedback loop (src/game/systems/launch-grade.ts).
 *
 * The system itself is exercised through the sim (it only wires these
 * helpers to HoverState edges); what needs pinning is the math the
 * verdicts hang off: the quaternion→pitch convention (must match
 * hover-attitude's grounded PD), the takeoff plateau curve, the
 * landing slope-match curve, and the verdict breakpoints.
 */

import { describe, expect, it } from 'vitest'
import {
  gradeLanding,
  gradeTakeoff,
  LANDING_ERR_MAX_RAD,
  pitchAngleFromQuat,
  TAKEOFF_IDEAL_PITCH_RAD,
  TAKEOFF_PITCH_TOL_RAD,
  VERDICT_CLEAN_MIN,
  VERDICT_OK_MIN,
  verdictFor,
} from '../../src/game/systems/launch-grade'

type Quat = { x: number; y: number; z: number; w: number }

/** Hamilton product a*b. */
function mul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  }
}

const pitchQuat = (a: number): Quat => ({ x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) })
const yawQuat = (a: number): Quat => ({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) })

describe('pitchAngleFromQuat', () => {
  it('reads 0 for the identity pose', () => {
    expect(pitchAngleFromQuat({ x: 0, y: 0, z: 0, w: 1 })).toBeCloseTo(0, 10)
  })

  it('recovers a pure pitch rotation (positive = nose up)', () => {
    expect(pitchAngleFromQuat(pitchQuat(0.3))).toBeCloseTo(0.3, 6)
    expect(pitchAngleFromQuat(pitchQuat(-0.25))).toBeCloseTo(-0.25, 6)
  })

  it('recovers pitch under an arbitrary yaw (yaw ∘ pitch composition)', () => {
    // A racing bike is always yawed somewhere; the extraction must not
    // bleed yaw into pitch.
    const q = mul(yawQuat(2.1), pitchQuat(0.18))
    expect(pitchAngleFromQuat(q)).toBeCloseTo(0.18, 6)
  })
})

describe('gradeTakeoff', () => {
  it('peaks at the ideal pop pitch', () => {
    expect(gradeTakeoff(TAKEOFF_IDEAL_PITCH_RAD)).toBe(1)
  })

  it('fades to 0 at the tolerance edge and clamps beyond', () => {
    expect(gradeTakeoff(TAKEOFF_IDEAL_PITCH_RAD + TAKEOFF_PITCH_TOL_RAD)).toBeCloseTo(0, 10)
    expect(gradeTakeoff(TAKEOFF_IDEAL_PITCH_RAD - TAKEOFF_PITCH_TOL_RAD)).toBeCloseTo(0, 10)
    expect(gradeTakeoff(TAKEOFF_IDEAL_PITCH_RAD + 2 * TAKEOFF_PITCH_TOL_RAD)).toBe(0)
  })

  it('grades a flat, unpitched takeoff below the clean band', () => {
    // Riding off a crest without touching pitch should read mediocre,
    // not clean — that gap is the whole skill signal.
    expect(gradeTakeoff(0)).toBeLessThan(VERDICT_CLEAN_MIN)
    expect(gradeTakeoff(0)).toBeGreaterThan(0)
  })
})

describe('gradeLanding', () => {
  it('is perfect when the nose matches the landing tangent', () => {
    // Flat water, level bike.
    expect(gradeLanding(0, 0)).toBe(1)
    // Downslope face: the matching pitch is -atan(slope) — same
    // convention as hover-attitude's surfacePitchTarget.
    const slope = 0.3
    expect(gradeLanding(-Math.atan(slope), slope)).toBeCloseTo(1, 10)
  })

  it('decays linearly to 0 at the max error', () => {
    expect(gradeLanding(LANDING_ERR_MAX_RAD, 0)).toBeCloseTo(0, 10)
    expect(gradeLanding(LANDING_ERR_MAX_RAD / 2, 0)).toBeCloseTo(0.5, 10)
  })
})

describe('verdictFor', () => {
  it('maps the tier boundaries', () => {
    expect(verdictFor(VERDICT_CLEAN_MIN)).toBe('clean')
    expect(verdictFor(VERDICT_CLEAN_MIN - 0.01)).toBe('ok')
    expect(verdictFor(VERDICT_OK_MIN)).toBe('ok')
    expect(verdictFor(VERDICT_OK_MIN - 0.01)).toBe('sloppy')
    expect(verdictFor(0)).toBe('sloppy')
  })
})
