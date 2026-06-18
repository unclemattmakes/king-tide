/**
 * Pure-helper tests for the two hover state machines extracted during the
 * god-file split (docs/systems-review.md §4): the per-end grounded
 * hysteresis (`resolveCornerGrounded`) and the dive / release-kick timer
 * advance (`advanceDiveTimers`). Both are pure (no ECS, no Rapier), so they
 * can be pinned without spinning up a physics world.
 */

import { describe, expect, it } from 'vitest'
import {
  advanceDiveTimers,
  MIN_DIVE_FOR_RELEASE_S,
  RELEASE_KICK_DURATION_S,
  resolveCornerGrounded,
} from '@/game/systems/hover'

describe('resolveCornerGrounded — per-end grounded hysteresis', () => {
  const CUTOFF = 1.6

  it('grounds an airborne end only once it drops below the lowered re-ground threshold', () => {
    // prevGrounded=false → threshold = cutoff * NOSE_REGROUND_FRAC (0.85) = 1.36.
    // A distance between 1.36 and 1.6 must stay AIRBORNE (debounce gap).
    expect(resolveCornerGrounded(1.5, CUTOFF, false)).toBe(false)
    // Below the lowered threshold → grounds.
    expect(resolveCornerGrounded(1.3, CUTOFF, false)).toBe(true)
  })

  it('keeps a grounded end grounded until its distance exceeds the full cutoff', () => {
    // prevGrounded=true → threshold = full cutoff (1.6). The same 1.5 that
    // read airborne above stays GROUNDED here — that gap is the hysteresis.
    expect(resolveCornerGrounded(1.5, CUTOFF, true)).toBe(true)
    // Past the full cutoff → lifts off.
    expect(resolveCornerGrounded(1.7, CUTOFF, true)).toBe(false)
  })

  it('the hysteresis band is exactly [cutoff*0.85, cutoff)', () => {
    // A distance inside the band flips depending on prior state — the whole
    // point of the debounce.
    const inBand = CUTOFF * 0.92
    expect(resolveCornerGrounded(inBand, CUTOFF, true)).toBe(true)
    expect(resolveCornerGrounded(inBand, CUTOFF, false)).toBe(false)
  })
})

describe('advanceDiveTimers — dive-hold + release-kick state machine', () => {
  const DT = 1 / 60

  it('ticks diveHoldS up while nose-down input is held, releaseKick stays 0', () => {
    const a = advanceDiveTimers(-1, DT, 0, 0)
    expect(a.diveHoldS).toBeCloseTo(DT, 9)
    expect(a.releaseKickS).toBe(0)
    const b = advanceDiveTimers(-1, DT, a.diveHoldS, a.releaseKickS)
    expect(b.diveHoldS).toBeCloseTo(2 * DT, 9)
    expect(b.releaseKickS).toBe(0)
  })

  it('ignores nose-down input inside the deadzone (pitch > -0.05) but dives at the edge', () => {
    // `isDiving` is `pitch <= -0.05`, matching the deadzone in
    // applyPlayerPitchTorque. -0.04 is inside the deadzone → resets to 0.
    expect(advanceDiveTimers(-0.04, DT, 0.5, 0).diveHoldS).toBe(0)
    // The boundary -0.05 still counts as diving (preserved behaviour).
    expect(advanceDiveTimers(-0.05, DT, 0.5, 0).diveHoldS).toBeCloseTo(0.5 + DT, 9)
  })

  it('fires a release kick when a sustained dive is released', () => {
    // Prior dive longer than the min-dive threshold, no kick in flight.
    const r = advanceDiveTimers(0, DT, MIN_DIVE_FOR_RELEASE_S + 0.1, 0)
    expect(r.diveHoldS).toBe(0)
    expect(r.releaseKickS).toBe(RELEASE_KICK_DURATION_S)
  })

  it('does NOT fire a release kick after a too-short tap', () => {
    const r = advanceDiveTimers(0, DT, MIN_DIVE_FOR_RELEASE_S - 0.001, 0)
    expect(r.releaseKickS).toBe(0)
  })

  it('counts the release kick down to zero over subsequent ticks', () => {
    const start = advanceDiveTimers(0, DT, MIN_DIVE_FOR_RELEASE_S + 0.1, 0)
    const next = advanceDiveTimers(0, DT, 0, start.releaseKickS)
    expect(next.releaseKickS).toBeCloseTo(RELEASE_KICK_DURATION_S - DT, 9)
    // It never goes negative.
    const tiny = advanceDiveTimers(0, DT, 0, DT / 2)
    expect(tiny.releaseKickS).toBe(0)
  })

  it('re-pressing pitch-down cancels an in-flight release kick', () => {
    const r = advanceDiveTimers(-1, DT, 0, RELEASE_KICK_DURATION_S * 0.5)
    expect(r.releaseKickS).toBe(0)
    expect(r.diveHoldS).toBeCloseTo(DT, 9)
  })

  it('does not re-arm a release kick while one is already counting down', () => {
    // prevDiveHoldS qualifies but a kick is already in flight (prevReleaseKickS
    // > 0) → must keep counting down, not reset to full duration.
    const r = advanceDiveTimers(0, DT, MIN_DIVE_FOR_RELEASE_S + 0.1, RELEASE_KICK_DURATION_S * 0.5)
    expect(r.releaseKickS).toBeCloseTo(RELEASE_KICK_DURATION_S * 0.5 - DT, 9)
  })
})
