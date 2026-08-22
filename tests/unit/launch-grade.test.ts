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
  DRIFT_BOOST_DURATION_T2,
  DRIFT_BOOST_MUL_T2,
} from '../../src/game/systems/drift-tiers'
import {
  CLEAN_JUMP_BURST_MUL,
  CLEAN_JUMP_BURST_S,
  gradeLanding,
  gradeTakeoff,
  JUMP_LANDING_WEIGHT,
  JUMP_REWARD_FLOOR,
  JUMP_REWARD_SCALE,
  JUMP_TAKEOFF_WEIGHT,
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

  it('recovers a pure pitch rotation (positive = nose down: asin(-fwd.y))', () => {
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

  it('rewards a nose-UP pop, not a dive — pinned through the quat path', () => {
    // Physical anchor for the sign convention: the ideal pop is the
    // nose pointing ABOVE the horizon at the lip. Build the ideal-pop
    // quat, confirm its forward axis genuinely climbs (fwd.y > 0),
    // and confirm it grades 1 while the same-magnitude dive grades 0.
    // (The ideal shipped as +0.24 for a while, which graded a 14° dive
    // as the perfect pop — this is the regression pin.)
    const idealQuat = pitchQuat(TAKEOFF_IDEAL_PITCH_RAD)
    // quatRotate(q, +Z), reduced for a pure-pitch quat: fwd.y = -sin(angle).
    const fwdY = -Math.sin(TAKEOFF_IDEAL_PITCH_RAD)
    expect(fwdY).toBeGreaterThan(0) // nose up = climbing forward axis
    expect(gradeTakeoff(pitchAngleFromQuat(idealQuat))).toBeCloseTo(1, 10)
    // Mirror-image dive (nose 14° below horizon) is fully outside the band.
    expect(gradeTakeoff(pitchAngleFromQuat(pitchQuat(-TAKEOFF_IDEAL_PITCH_RAD)))).toBe(0)
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

describe('jump economy', () => {
  it('blend weights are a landing-dominant convex combination', () => {
    expect(JUMP_TAKEOFF_WEIGHT + JUMP_LANDING_WEIGHT).toBeCloseTo(1, 10)
    expect(JUMP_LANDING_WEIGHT).toBeGreaterThan(JUMP_TAKEOFF_WEIGHT)
    expect(JUMP_TAKEOFF_WEIGHT).toBeGreaterThan(0) // takeoff converts to reward
  })

  it('a perfect jump out-earns one SMT drift in gained speed-time', () => {
    // The hero skill has to pay better than the sidekick
    // (design-targets §2 / evaluation game-design #4). Compare in
    // "multiplier-seconds above 1×":
    //   SMT release: (1.75 - 1) × 1.6 s, automatic.
    //   Perfect jump: full meter slice held at the default 1.6×
    //   boostMul (drains at 1/3 charge per second — boost-meter.ts),
    //   PLUS the clean-jump auto-vent burst.
    const smtGain = (DRIFT_BOOST_MUL_T2 - 1) * DRIFT_BOOST_DURATION_T2
    const DEFAULT_BOOST_MUL = 1.6 // bikes/variants.ts default stats.boostMul
    const METER_DRAIN_PER_SEC = 1 / 3 // boost-meter.ts DRAIN_PER_SEC
    const perfectCharge = JUMP_REWARD_FLOOR + JUMP_REWARD_SCALE
    const meterGain = (perfectCharge / METER_DRAIN_PER_SEC) * (DEFAULT_BOOST_MUL - 1)
    const burstGain = (CLEAN_JUMP_BURST_MUL - 1) * CLEAN_JUMP_BURST_S
    expect(meterGain + burstGain).toBeGreaterThan(smtGain)
    // ...and the meter slice alone clears SMT, so the ranking holds
    // even if the player banks the charge instead of venting it fresh.
    expect(meterGain).toBeGreaterThan(smtGain)
  })

  it('a perfect jump still costs a button press worth less than UMT — drift keeps corners', () => {
    // Anti-goal guard: the rebalance must not delete drift's identity.
    // A single perfect jump stays below the free UMT slingshot
    // (1.95×/2.3 s); wave tracks out-earn via repetition, not one hit.
    const umtGain = (1.95 - 1) * 2.3
    const DEFAULT_BOOST_MUL = 1.6
    const METER_DRAIN_PER_SEC = 1 / 3
    const perfectCharge = JUMP_REWARD_FLOOR + JUMP_REWARD_SCALE
    const meterGain = (perfectCharge / METER_DRAIN_PER_SEC) * (DEFAULT_BOOST_MUL - 1)
    expect(meterGain).toBeLessThan(umtGain)
  })
})
