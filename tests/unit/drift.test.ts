/**
 * Drift system — pure-helper tuning + state-machine transitions.
 *
 * Pins the tier curve, boost-payload table, and the start/end-drift
 * predicates without spinning up Rapier. See
 * [docs/drift-deep-dive.md](../../docs/drift-deep-dive.md) for the
 * design rationale; this suite is the canonical test of what the
 * exported tuning constants mean.
 */

import { describe, expect, it } from 'vitest'
import { emptyIntent } from '../../src/engine/input/intent'
import type { DriftStateData, HoverStateData } from '../../src/game/components'
import {
  BRAKE_CANCEL_THRESHOLD,
  DRIFT_BOOST_DURATION_T1,
  DRIFT_BOOST_DURATION_T2,
  DRIFT_BOOST_DURATION_T3,
  DRIFT_BOOST_MUL_T1,
  DRIFT_BOOST_MUL_T2,
  DRIFT_BOOST_MUL_T3,
  DRIFT_COOLDOWN_S,
  driftBoostParams,
  STEER_COMMIT_THRESHOLD,
  shouldEndDrift,
  shouldStartDrift,
  TIER_1_THRESHOLD_S,
  TIER_2_THRESHOLD_S,
  TIER_3_THRESHOLD_S,
  tierFor,
  UNGROUNDED_CANCEL_S,
} from '../../src/game/systems/drift'

function groundedHover(): HoverStateData {
  return {
    groundDistance: 0.4,
    isGrounded: true,
    surfaceIsWater: false,
    surfaceType: 'default',
    forwardSlope: 0,
    diveHoldS: 0,
    releaseKickS: 0,
  }
}

function airborneHover(): HoverStateData {
  return { ...groundedHover(), groundDistance: 4, isGrounded: false }
}

function idleDrift(): DriftStateData {
  return {
    driftDir: 0,
    chargeS: 0,
    highestTier: 0,
    sinceReleaseS: DRIFT_COOLDOWN_S + 1, // cooldown elapsed
    ungroundedDuringDriftS: 0,
    prevLeftDown: false,
    prevRightDown: false,
    releasedThisTick: false,
    releasedTier: 0,
  }
}

describe('tierFor', () => {
  it('returns 0 below the tier-1 threshold', () => {
    expect(tierFor(0)).toBe(0)
    expect(tierFor(TIER_1_THRESHOLD_S - 0.01)).toBe(0)
  })

  it('returns 1 at the tier-1 threshold and through the tier-2 floor', () => {
    expect(tierFor(TIER_1_THRESHOLD_S)).toBe(1)
    expect(tierFor(TIER_2_THRESHOLD_S - 0.01)).toBe(1)
  })

  it('returns 2 once the tier-2 threshold is reached, through the tier-3 floor', () => {
    expect(tierFor(TIER_2_THRESHOLD_S)).toBe(2)
    expect(tierFor(TIER_3_THRESHOLD_S - 0.01)).toBe(2)
  })

  it('returns 3 (UMT) once the tier-3 threshold is reached', () => {
    expect(tierFor(TIER_3_THRESHOLD_S)).toBe(3)
    expect(tierFor(TIER_3_THRESHOLD_S + 5)).toBe(3)
  })

  it('orders thresholds correctly (sanity)', () => {
    expect(TIER_1_THRESHOLD_S).toBeLessThan(TIER_2_THRESHOLD_S)
    expect(TIER_2_THRESHOLD_S).toBeLessThan(TIER_3_THRESHOLD_S)
  })
})

describe('driftBoostParams', () => {
  it('returns null for tier 0 — no charge = no boost', () => {
    expect(driftBoostParams(0)).toBeNull()
    expect(driftBoostParams(-1)).toBeNull()
  })

  it('returns the tier-1 (blue MT) payload', () => {
    expect(driftBoostParams(1)).toEqual({
      multiplier: DRIFT_BOOST_MUL_T1,
      durationS: DRIFT_BOOST_DURATION_T1,
    })
  })

  it('returns the tier-2 (orange SMT) payload', () => {
    expect(driftBoostParams(2)).toEqual({
      multiplier: DRIFT_BOOST_MUL_T2,
      durationS: DRIFT_BOOST_DURATION_T2,
    })
  })

  it('returns the tier-3 (purple UMT) payload', () => {
    expect(driftBoostParams(3)).toEqual({
      multiplier: DRIFT_BOOST_MUL_T3,
      durationS: DRIFT_BOOST_DURATION_T3,
    })
  })

  it('saturates at the UMT payload for tier > 3 — defensive against future expansion', () => {
    expect(driftBoostParams(99)).toEqual({
      multiplier: DRIFT_BOOST_MUL_T3,
      durationS: DRIFT_BOOST_DURATION_T3,
    })
  })

  it('each tier is meaningfully stronger than the last', () => {
    expect(DRIFT_BOOST_MUL_T2).toBeGreaterThan(DRIFT_BOOST_MUL_T1)
    expect(DRIFT_BOOST_DURATION_T2).toBeGreaterThan(DRIFT_BOOST_DURATION_T1)
    expect(DRIFT_BOOST_MUL_T3).toBeGreaterThan(DRIFT_BOOST_MUL_T2)
    expect(DRIFT_BOOST_DURATION_T3).toBeGreaterThan(DRIFT_BOOST_DURATION_T2)
  })
})

describe('shouldStartDrift', () => {
  it('fires when left button held + grounded + steering left, past cooldown', () => {
    const intent = emptyIntent()
    intent.trickLeft = true
    intent.steer = -0.6
    const result = shouldStartDrift(intent, groundedHover(), DRIFT_COOLDOWN_S + 1)
    expect(result).toEqual({ dir: -1 })
  })

  it('fires for right-side drift with the right button', () => {
    const intent = emptyIntent()
    intent.trickRight = true
    intent.steer = 0.6
    const result = shouldStartDrift(intent, groundedHover(), DRIFT_COOLDOWN_S + 1)
    expect(result).toEqual({ dir: 1 })
  })

  it('returns null when the bike is airborne', () => {
    const intent = emptyIntent()
    intent.trickLeft = true
    intent.steer = -0.6
    expect(shouldStartDrift(intent, airborneHover(), DRIFT_COOLDOWN_S + 1)).toBeNull()
  })

  it('returns null inside the cooldown window — anti-snake gate', () => {
    const intent = emptyIntent()
    intent.trickLeft = true
    intent.steer = -0.6
    expect(shouldStartDrift(intent, groundedHover(), DRIFT_COOLDOWN_S - 0.05)).toBeNull()
  })

  it('returns null when the player steer points opposite the button', () => {
    const intent = emptyIntent()
    intent.trickLeft = true
    intent.steer = +0.6 // wrong direction
    expect(shouldStartDrift(intent, groundedHover(), DRIFT_COOLDOWN_S + 1)).toBeNull()
  })

  it('returns null when steer magnitude is below the commit threshold', () => {
    const intent = emptyIntent()
    intent.trickLeft = true
    intent.steer = -(STEER_COMMIT_THRESHOLD - 0.01)
    expect(shouldStartDrift(intent, groundedHover(), DRIFT_COOLDOWN_S + 1)).toBeNull()
  })

  it('returns null when both trick buttons are held — ambiguous, defer to trick path', () => {
    const intent = emptyIntent()
    intent.trickLeft = true
    intent.trickRight = true
    intent.steer = -0.6
    expect(shouldStartDrift(intent, groundedHover(), DRIFT_COOLDOWN_S + 1)).toBeNull()
  })

  it('returns null when no trick button is held', () => {
    const intent = emptyIntent()
    intent.steer = -0.6
    expect(shouldStartDrift(intent, groundedHover(), DRIFT_COOLDOWN_S + 1)).toBeNull()
  })
})

describe('shouldEndDrift', () => {
  it('returns null when no drift is active', () => {
    const intent = emptyIntent()
    expect(shouldEndDrift(intent, idleDrift())).toBeNull()
  })

  it("ends with 'released' when the matching button is no longer held", () => {
    const intent = emptyIntent()
    // intent.trickLeft = false → no longer held
    const state: DriftStateData = { ...idleDrift(), driftDir: -1 }
    expect(shouldEndDrift(intent, state)).toBe('released')
  })

  it("ends with 'released' when the player slams the OPPOSITE button", () => {
    const intent = emptyIntent()
    intent.trickRight = true // wrong button while drifting left
    const state: DriftStateData = { ...idleDrift(), driftDir: -1 }
    expect(shouldEndDrift(intent, state)).toBe('released')
  })

  it("ends with 'braked' when brake is held past the threshold", () => {
    const intent = emptyIntent()
    intent.trickLeft = true
    intent.brake = BRAKE_CANCEL_THRESHOLD + 0.01
    const state: DriftStateData = { ...idleDrift(), driftDir: -1 }
    expect(shouldEndDrift(intent, state)).toBe('braked')
  })

  it("ends with 'ungrounded' once the ungrounded counter exceeds the threshold", () => {
    const intent = emptyIntent()
    intent.trickLeft = true
    const state: DriftStateData = {
      ...idleDrift(),
      driftDir: -1,
      ungroundedDuringDriftS: UNGROUNDED_CANCEL_S + 0.01,
    }
    expect(shouldEndDrift(intent, state)).toBe('ungrounded')
  })

  it('continues drift when button is held, no brake, grounded', () => {
    const intent = emptyIntent()
    intent.trickLeft = true
    const state: DriftStateData = { ...idleDrift(), driftDir: -1 }
    expect(shouldEndDrift(intent, state)).toBeNull()
  })

  it('tolerates brief ungrounded time below the cancel threshold', () => {
    const intent = emptyIntent()
    intent.trickLeft = true
    const state: DriftStateData = {
      ...idleDrift(),
      driftDir: -1,
      ungroundedDuringDriftS: UNGROUNDED_CANCEL_S - 0.01,
    }
    expect(shouldEndDrift(intent, state)).toBeNull()
  })
})

describe('drift tuning sanity', () => {
  it("tier-1 charge time is faster than a half-second corner (so drift pays off in 'normal' corners)", () => {
    expect(TIER_1_THRESHOLD_S).toBeLessThan(1.0)
    expect(TIER_1_THRESHOLD_S).toBeGreaterThan(0.3)
  })

  it('cooldown is short enough to be invisible during natural play', () => {
    expect(DRIFT_COOLDOWN_S).toBeLessThan(0.5)
    expect(DRIFT_COOLDOWN_S).toBeGreaterThan(0)
  })

  it('ungrounded grace tolerates ramp lips (~150 ms) but kills committed jumps', () => {
    expect(UNGROUNDED_CANCEL_S).toBeGreaterThan(0.2)
    expect(UNGROUNDED_CANCEL_S).toBeLessThan(0.6)
  })
})
