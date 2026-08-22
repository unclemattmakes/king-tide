/**
 * AI wave mastery — the pure halves of the v2 signature loop on rivals
 * (evaluation game-design #2): the airborne pitch-to-tangent landing
 * controller and the meter-vent decision. The grounded takeoff shaping
 * is exercised through the sim (it's a two-line closed loop against
 * launch-grade's pop band); what needs pinning here is the control
 * math and the difficulty gating.
 *
 * Sign conventions under test (same as launch-grade):
 *   pitchAngle = asin(-fwd.y)  — positive = nose DOWN
 *   intent.pitch = +1          — nose UP (drives the angle DOWN)
 */

import { describe, expect, it } from 'vitest'
import { DIFFICULTY_TUNING } from '../../src/game/ai/difficulty'
import { defaultAIController } from '../../src/game/components/ai'
import {
  AI_LANDING_DAMP_RATIO,
  AI_LANDING_PREP_MIN_AIR_S,
  decideAILandingPitch,
  decideAIVent,
} from '../../src/game/systems/ai-control'
import { MIN_AIRTIME_SEC } from '../../src/game/systems/launch-grade'

describe('decideAILandingPitch', () => {
  // Args: (pitchAngle, pitchRate, targetPitch, gain) — positional
  // scalars because this runs per airborne AI per sim tick.
  it('commands nose-up when the nose hangs below the target attitude', () => {
    // Nose-down 0.3 rad over flat water (target 0): positive error →
    // positive (nose-up) input.
    expect(decideAILandingPitch(0.3, 0, 0, 3)).toBeGreaterThan(0)
  })

  it('commands nose-down when over-rotated past the target', () => {
    expect(decideAILandingPitch(-0.4, 0, 0, 3)).toBeLessThan(0)
  })

  it('is quiet at the target with no rotation — a matched landing needs no input', () => {
    expect(decideAILandingPitch(-0.2, 0, -0.2, 3)).toBe(0)
  })

  it('damps an approach: rotation toward the target reduces the command', () => {
    // Same error, but the nose is already rotating up (rate < 0 in the
    // angle convention): the D term must shrink the nose-up command so
    // the controller settles instead of oscillating.
    const still = decideAILandingPitch(0.3, 0, 0, 3)
    const rotating = decideAILandingPitch(0.3, -1.5, 0, 3)
    expect(rotating).toBeLessThan(still)
  })

  it('tracks a downslope target — landing on a wave back face aims nose-down', () => {
    // Descending face: forward slope negative → target = -atan(slope) > 0
    // (nose down, matching the water). Level bike must be pushed
    // nose-DOWN toward it.
    const target = -Math.atan(-0.35)
    expect(decideAILandingPitch(0, 0, target, 3)).toBeLessThan(0)
  })

  it('clamps to the intent range', () => {
    expect(decideAILandingPitch(1.2, 0, -0.3, 10)).toBe(1)
    expect(decideAILandingPitch(-1.2, 0, 0.3, 10)).toBe(-1)
  })

  it('damp ratio keeps a single tuning knob per difficulty', () => {
    expect(AI_LANDING_DAMP_RATIO).toBeGreaterThan(0)
    expect(AI_LANDING_DAMP_RATIO).toBeLessThan(1)
  })

  it('prep window engages before a gradeable landing can happen', () => {
    // The controller must have time to act on every jump the sim will
    // actually grade (airtime >= MIN_AIRTIME_SEC).
    expect(AI_LANDING_PREP_MIN_AIR_S).toBeLessThan(MIN_AIRTIME_SEC)
  })
})

describe('decideAIVent', () => {
  const standard = DIFFICULTY_TUNING.standard
  const base = {
    charge: 1,
    meterActive: false,
    grounded: true,
    drifting: false,
    stunned: false,
    curvatureAhead: 0,
  }

  it('vents a charged meter on a straight', () => {
    expect(decideAIVent(standard, base)).toBe(true)
  })

  it('never vents on Casual — Infinity short-circuit', () => {
    expect(decideAIVent(DIFFICULTY_TUNING.casual, base)).toBe(false)
  })

  it('banks the charge below the difficulty threshold', () => {
    expect(decideAIVent(standard, { ...base, charge: standard.ventChargeMin - 0.05 })).toBe(false)
  })

  it('keeps the button held while the meter is actively venting', () => {
    // Below the start threshold but mid-vent: hold until dry.
    expect(decideAIVent(standard, { ...base, charge: 0.2, meterActive: true })).toBe(true)
    expect(decideAIVent(standard, { ...base, charge: 0, meterActive: true })).toBe(false)
  })

  it('suppresses venting airborne, mid-drift, stunned, and into a drift-worthy corner', () => {
    expect(decideAIVent(standard, { ...base, grounded: false })).toBe(false)
    expect(decideAIVent(standard, { ...base, drifting: true })).toBe(false)
    // Stunned: the shared stun override zeroes throttle but leaves the
    // boost button alone, so without this gate a stunned AI would
    // drain its earned meter into a spinout at zero speed.
    expect(decideAIVent(standard, { ...base, stunned: true })).toBe(false)
    expect(decideAIVent(standard, { ...base, stunned: true, meterActive: true })).toBe(false)
    expect(
      decideAIVent(standard, { ...base, curvatureAhead: standard.driftCurvatureThreshold }),
    ).toBe(false)
  })

  it('releases into a corner even mid-vent — bank the rest', () => {
    expect(
      decideAIVent(standard, {
        ...base,
        charge: 0.4,
        meterActive: true,
        curvatureAhead: standard.driftCurvatureThreshold,
      }),
    ).toBe(false)
  })
})

describe('difficulty gating of the wave-mastery loop', () => {
  it('Casual is fully out; Standard demonstrates; Hard is the role model', () => {
    const c = DIFFICULTY_TUNING.casual
    const s = DIFFICULTY_TUNING.standard
    const h = DIFFICULTY_TUNING.hard
    expect(c.landingPitchGain).toBe(0)
    expect(c.ventChargeMin).toBe(Number.POSITIVE_INFINITY)
    expect(s.landingPitchGain).toBeGreaterThan(0)
    expect(h.landingPitchGain).toBeGreaterThan(s.landingPitchGain)
    // Hard vents earlier (lower threshold = spends more aggressively).
    expect(h.ventChargeMin).toBeLessThan(s.ventChargeMin)
    // Standard still vents at some real fill level.
    expect(s.ventChargeMin).toBeLessThanOrEqual(1)
  })

  it('bakes onto the controller at spawn', () => {
    const c = defaultAIController('main', { difficulty: 'casual' })
    expect(c.landingPitchGain).toBe(0)
    expect(c.ventChargeMin).toBe(Number.POSITIVE_INFINITY)
    const h = defaultAIController('main', { difficulty: 'hard' })
    expect(h.landingPitchGain).toBe(DIFFICULTY_TUNING.hard.landingPitchGain)
    expect(h.ventChargeMin).toBe(DIFFICULTY_TUNING.hard.ventChargeMin)
  })
})
