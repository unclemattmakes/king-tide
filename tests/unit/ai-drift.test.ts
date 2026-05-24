/**
 * AI drift decision — pure state-machine tests for `decideAIDrift`.
 *
 * Pins the activation / cancel rules without spinning up the spline
 * or physics loop. The transitions tested mirror the design doc:
 *
 *  - Casual (`Infinity` curvature threshold) never enters drift.
 *  - Standard/Hard enter drift when curvature + speed + steer commit.
 *  - Drift cancels on corner widen, steer flip, speed drop, or max hold.
 *  - Cooldown after release gates re-entry on the next tick.
 *
 * Edge cases tested: cooldown decay across ticks; `Math.sign(steer)`
 * directly determines `driftDir` so the player-side `driftSystem`'s
 * activation gate passes on the very next tick.
 */

import { describe, expect, it } from 'vitest'
import { DIFFICULTY_TUNING } from '../../src/game/ai/difficulty'
import {
  type AIDriftState,
  type AIDriftTuning,
  decideAIDrift,
} from '../../src/game/systems/ai-control'

const HARD: AIDriftTuning = {
  driftCurvatureThreshold: DIFFICULTY_TUNING.hard.driftCurvatureThreshold,
  driftMinSpeed: DIFFICULTY_TUNING.hard.driftMinSpeed,
  driftMaxHoldS: DIFFICULTY_TUNING.hard.driftMaxHoldS,
}

const STANDARD: AIDriftTuning = {
  driftCurvatureThreshold: DIFFICULTY_TUNING.standard.driftCurvatureThreshold,
  driftMinSpeed: DIFFICULTY_TUNING.standard.driftMinSpeed,
  driftMaxHoldS: DIFFICULTY_TUNING.standard.driftMaxHoldS,
}

const CASUAL: AIDriftTuning = {
  driftCurvatureThreshold: DIFFICULTY_TUNING.casual.driftCurvatureThreshold,
  driftMinSpeed: DIFFICULTY_TUNING.casual.driftMinSpeed,
  driftMaxHoldS: DIFFICULTY_TUNING.casual.driftMaxHoldS,
}

const IDLE: AIDriftState = { driftDir: 0, driftHoldS: 0, driftCooldownS: 0 }
const DT = 1 / 60

describe('decideAIDrift — activation', () => {
  it('enters drift right when steer is positive, curvature sharp, speed OK', () => {
    const out = decideAIDrift(HARD, IDLE, {
      curvatureAhead: 0.05,
      speed: 22,
      steer: 0.6,
      dt: DT,
    })
    expect(out.driftDir).toBe(1)
    expect(out.driftHoldS).toBe(0)
  })

  it('enters drift left when steer is negative', () => {
    const out = decideAIDrift(HARD, IDLE, {
      curvatureAhead: 0.05,
      speed: 22,
      steer: -0.6,
      dt: DT,
    })
    expect(out.driftDir).toBe(-1)
  })

  it('Casual never enters drift — threshold is +Infinity', () => {
    const out = decideAIDrift(CASUAL, IDLE, {
      curvatureAhead: 0.5,
      speed: 100,
      steer: 0.9,
      dt: DT,
    })
    expect(out.driftDir).toBe(0)
  })

  it('refuses to enter while in cooldown', () => {
    const out = decideAIDrift(
      HARD,
      { ...IDLE, driftCooldownS: 0.2 },
      { curvatureAhead: 0.05, speed: 22, steer: 0.6, dt: DT },
    )
    expect(out.driftDir).toBe(0)
    // Cooldown decays each tick toward zero so the next eligible
    // window opens once the cooldown drains.
    expect(out.driftCooldownS).toBeLessThan(0.2)
  })

  it('refuses to enter when corner is too gentle (below curvature threshold)', () => {
    const out = decideAIDrift(HARD, IDLE, {
      curvatureAhead: HARD.driftCurvatureThreshold - 0.001,
      speed: 22,
      steer: 0.6,
      dt: DT,
    })
    expect(out.driftDir).toBe(0)
  })

  it('refuses to enter when speed is below threshold (would just spin out)', () => {
    const out = decideAIDrift(HARD, IDLE, {
      curvatureAhead: 0.05,
      speed: HARD.driftMinSpeed - 1,
      steer: 0.6,
      dt: DT,
    })
    expect(out.driftDir).toBe(0)
  })

  it('refuses to enter without a committed steer (|steer| < 0.3)', () => {
    const out = decideAIDrift(HARD, IDLE, {
      curvatureAhead: 0.05,
      speed: 22,
      steer: 0.15,
      dt: DT,
    })
    expect(out.driftDir).toBe(0)
  })
})

describe('decideAIDrift — continuation + cancel', () => {
  const ACTIVE: AIDriftState = { driftDir: 1, driftHoldS: 0.3, driftCooldownS: 0 }

  it('continues drift and accumulates hold time when conditions hold', () => {
    const out = decideAIDrift(HARD, ACTIVE, {
      curvatureAhead: 0.05,
      speed: 22,
      steer: 0.6,
      dt: DT,
    })
    expect(out.driftDir).toBe(1)
    expect(out.driftHoldS).toBeCloseTo(0.3 + DT, 5)
  })

  it("cancels with 'corner widened' when curvature drops below 60% of threshold", () => {
    const out = decideAIDrift(HARD, ACTIVE, {
      curvatureAhead: HARD.driftCurvatureThreshold * 0.5,
      speed: 22,
      steer: 0.6,
      dt: DT,
    })
    expect(out.driftDir).toBe(0)
    expect(out.driftCooldownS).toBeGreaterThan(0)
  })

  it('cancels when steer flips opposite the drift direction', () => {
    const out = decideAIDrift(HARD, ACTIVE, {
      curvatureAhead: 0.05,
      speed: 22,
      steer: -0.6,
      dt: DT,
    })
    expect(out.driftDir).toBe(0)
  })

  it('cancels when speed drops below 70% of trigger threshold (lost momentum)', () => {
    const out = decideAIDrift(HARD, ACTIVE, {
      curvatureAhead: 0.05,
      speed: HARD.driftMinSpeed * 0.6,
      steer: 0.6,
      dt: DT,
    })
    expect(out.driftDir).toBe(0)
  })

  it('cancels when hold time exceeds the per-difficulty max', () => {
    const nearMax: AIDriftState = {
      ...ACTIVE,
      driftHoldS: HARD.driftMaxHoldS - DT * 0.5,
    }
    const out = decideAIDrift(HARD, nearMax, {
      curvatureAhead: 0.05,
      speed: 22,
      steer: 0.6,
      dt: DT,
    })
    expect(out.driftDir).toBe(0)
  })

  it('Standard max-hold caps short of UMT — AI ceiling is orange SMT', () => {
    const TIER_3_THRESHOLD_S = 2.4
    const standardActive: AIDriftState = {
      driftDir: 1,
      driftHoldS: STANDARD.driftMaxHoldS - DT * 0.5,
      driftCooldownS: 0,
    }
    const out = decideAIDrift(STANDARD, standardActive, {
      curvatureAhead: 0.05,
      speed: 22,
      steer: 0.6,
      dt: DT,
    })
    // Standard's max hold has expired this tick — drift cancels
    // before reaching UMT.
    expect(out.driftDir).toBe(0)
    // The hold time at cancel is well below the UMT threshold.
    expect(STANDARD.driftMaxHoldS).toBeLessThan(TIER_3_THRESHOLD_S)
  })

  it('Hard can hold past the UMT threshold on a sustained sweep', () => {
    const TIER_3_THRESHOLD_S = 2.4
    const hardAlmostDone: AIDriftState = {
      driftDir: 1,
      driftHoldS: TIER_3_THRESHOLD_S + 0.05,
      driftCooldownS: 0,
    }
    // Still ongoing — corner still wide enough, speed OK, steer
    // committed, and we haven't yet hit Hard's max-hold ceiling.
    const out = decideAIDrift(HARD, hardAlmostDone, {
      curvatureAhead: 0.05,
      speed: 22,
      steer: 0.6,
      dt: DT,
    })
    expect(out.driftDir).toBe(1)
    expect(out.driftHoldS).toBeGreaterThanOrEqual(TIER_3_THRESHOLD_S)
  })
})

describe('decideAIDrift — cooldown decay', () => {
  it('cooldown decays each tick toward zero', () => {
    let state: AIDriftState = { driftDir: 0, driftHoldS: 0, driftCooldownS: 0.35 }
    for (let i = 0; i < 30; i++) {
      state = decideAIDrift(HARD, state, {
        curvatureAhead: 0,
        speed: 0,
        steer: 0,
        dt: DT,
      })
    }
    expect(state.driftCooldownS).toBe(0)
  })

  it('does not go negative when ticked past zero', () => {
    const state = decideAIDrift(
      HARD,
      { driftDir: 0, driftHoldS: 0, driftCooldownS: 0.01 },
      { curvatureAhead: 0, speed: 0, steer: 0, dt: 1 },
    )
    expect(state.driftCooldownS).toBe(0)
  })
})
