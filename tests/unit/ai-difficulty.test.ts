/**
 * AI difficulty + rubber-band toggle — verifies the tuning curve, the
 * controller bake-in, and the rubber-band system's behavior under each
 * setting.
 *
 * Owns the `docs/v1-work-breakdown.md` Foundation Systems row:
 *   - 3 difficulties — `DIFFICULTY_TUNING` is monotonic on speed +
 *     cornering aggression.
 *   - Rubber-band — toggling off settles AI back to baseline.
 *   - Per-AI bounds — boost cap + penalty floor scale around baseline
 *     so a Casual AI's "boost" stays slower than a Standard AI's
 *     baseline.
 */

import { addComponent, addEntity } from 'bitecs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PLAYER_SETTINGS,
  loadPlayerSettings,
  playerSettings,
  setRubberBandAssist,
} from '../../src/engine/player-settings'
import { createSimWorld } from '../../src/engine/sim/ecs/world'
import { DIFFICULTY_TUNING } from '../../src/game/ai/difficulty'
import {
  AIController,
  AIControllerStore,
  AITag,
  defaultAIController,
} from '../../src/game/components/ai'
import { Racer, RacerStore } from '../../src/game/components/race'
import { rubberBandSystem } from '../../src/game/systems/rubber-band'
import type { Track } from '../../src/game/tracks/types'

/** Minimal Track stub — rubberBandSystem only reads `checkpoints.length`. */
const trackStub = (checkpointCount: number): Track =>
  ({ checkpoints: Array.from({ length: checkpointCount }, () => ({})) }) as unknown as Track

function resetPlayerSettings(): void {
  playerSettings.wavePumpIntensity = DEFAULT_PLAYER_SETTINGS.wavePumpIntensity
  playerSettings.aiDifficulty = DEFAULT_PLAYER_SETTINGS.aiDifficulty
  playerSettings.rubberBandAssist = DEFAULT_PLAYER_SETTINGS.rubberBandAssist
}

describe('DIFFICULTY_TUNING', () => {
  it('is monotonic — Casual < Standard < Hard on speed and cornering', () => {
    const c = DIFFICULTY_TUNING.casual
    const s = DIFFICULTY_TUNING.standard
    const h = DIFFICULTY_TUNING.hard
    expect(c.baselineTopSpeedFactor).toBeLessThan(s.baselineTopSpeedFactor)
    expect(s.baselineTopSpeedFactor).toBeLessThan(h.baselineTopSpeedFactor)
    expect(c.maxLateralAccel).toBeLessThan(s.maxLateralAccel)
    expect(s.maxLateralAccel).toBeLessThan(h.maxLateralAccel)
    expect(c.curvatureLookaheadSec).toBeLessThan(s.curvatureLookaheadSec)
    expect(s.curvatureLookaheadSec).toBeLessThan(h.curvatureLookaheadSec)
  })

  it('rubber-band bounds bracket 1.0 — boost > 1, penalty < 1', () => {
    for (const t of Object.values(DIFFICULTY_TUNING)) {
      expect(t.rubberBandBoostCap).toBeGreaterThan(1)
      expect(t.rubberBandPenaltyFloor).toBeLessThan(1)
    }
  })

  it('Casual rubber-band band is narrower than Hard', () => {
    const c = DIFFICULTY_TUNING.casual
    const h = DIFFICULTY_TUNING.hard
    const cWidth = c.rubberBandBoostCap - c.rubberBandPenaltyFloor
    const hWidth = h.rubberBandBoostCap - h.rubberBandPenaltyFloor
    expect(cWidth).toBeLessThan(hWidth)
  })

  it('Casual disables drift entirely; Standard < Hard on aggression', () => {
    const c = DIFFICULTY_TUNING.casual
    const s = DIFFICULTY_TUNING.standard
    const h = DIFFICULTY_TUNING.hard
    // Casual short-circuits via Infinity (same pattern as pumpVyThreshold).
    expect(c.driftCurvatureThreshold).toBe(Number.POSITIVE_INFINITY)
    expect(c.driftMinSpeed).toBe(Number.POSITIVE_INFINITY)
    expect(c.driftMaxHoldS).toBe(0)
    // Hard trigger envelope is wider — drifts on less-sharp corners
    // (lower curvature threshold), at lower speeds, and holds longer
    // to reach the purple UMT tier.
    expect(h.driftCurvatureThreshold).toBeLessThan(s.driftCurvatureThreshold)
    expect(h.driftMinSpeed).toBeLessThan(s.driftMinSpeed)
    expect(h.driftMaxHoldS).toBeGreaterThan(s.driftMaxHoldS)
  })

  it('Standard hold ceiling falls short of UMT (2.4 s); Hard reaches it', () => {
    // Mirrors the design-doc claim that purple UMT is the Hard-AI
    // ceiling. Standard tops out at orange SMT (1.4 s threshold).
    const TIER_3_THRESHOLD_S = 2.4
    expect(DIFFICULTY_TUNING.standard.driftMaxHoldS).toBeLessThan(TIER_3_THRESHOLD_S)
    expect(DIFFICULTY_TUNING.hard.driftMaxHoldS).toBeGreaterThanOrEqual(TIER_3_THRESHOLD_S)
  })
})

describe('defaultAIController bake-in', () => {
  it('defaults to standard tuning when no difficulty is passed', () => {
    const c = defaultAIController('main')
    expect(c.baselineTopSpeedFactor).toBe(DIFFICULTY_TUNING.standard.baselineTopSpeedFactor)
    expect(c.maxLateralAccel).toBe(DIFFICULTY_TUNING.standard.maxLateralAccel)
    expect(c.curvatureLookaheadSec).toBe(DIFFICULTY_TUNING.standard.curvatureLookaheadSec)
  })

  it('starts topSpeedFactor at the difficulty baseline', () => {
    const c = defaultAIController('main', { difficulty: 'casual' })
    expect(c.topSpeedFactor).toBe(DIFFICULTY_TUNING.casual.baselineTopSpeedFactor)
    const h = defaultAIController('main', { difficulty: 'hard' })
    expect(h.topSpeedFactor).toBe(DIFFICULTY_TUNING.hard.baselineTopSpeedFactor)
  })

  it('carries per-difficulty rubber-band bounds onto the component', () => {
    const c = defaultAIController('main', { difficulty: 'casual' })
    expect(c.rubberBandBoostCap).toBe(DIFFICULTY_TUNING.casual.rubberBandBoostCap)
    expect(c.rubberBandPenaltyFloor).toBe(DIFFICULTY_TUNING.casual.rubberBandPenaltyFloor)
  })

  it('honors lineOffset alongside difficulty', () => {
    const c = defaultAIController('main', { difficulty: 'hard', lineOffset: 3.5 })
    expect(c.lineOffset).toBe(3.5)
    expect(c.baselineTopSpeedFactor).toBe(DIFFICULTY_TUNING.hard.baselineTopSpeedFactor)
  })

  it('bakes per-difficulty drift tuning onto the component', () => {
    const c = defaultAIController('main', { difficulty: 'casual' })
    expect(c.driftCurvatureThreshold).toBe(DIFFICULTY_TUNING.casual.driftCurvatureThreshold)
    expect(c.driftMinSpeed).toBe(DIFFICULTY_TUNING.casual.driftMinSpeed)
    expect(c.driftMaxHoldS).toBe(DIFFICULTY_TUNING.casual.driftMaxHoldS)
    const h = defaultAIController('main', { difficulty: 'hard' })
    expect(h.driftCurvatureThreshold).toBe(DIFFICULTY_TUNING.hard.driftCurvatureThreshold)
    expect(h.driftMinSpeed).toBe(DIFFICULTY_TUNING.hard.driftMinSpeed)
    expect(h.driftMaxHoldS).toBe(DIFFICULTY_TUNING.hard.driftMaxHoldS)
  })

  it('starts drift state cleared — fresh AI never spawns mid-drift', () => {
    const c = defaultAIController('main', { difficulty: 'hard' })
    expect(c.driftDir).toBe(0)
    expect(c.driftHoldS).toBe(0)
    expect(c.driftCooldownS).toBe(0)
  })
})

/** Spin up two racers (leader + chaser) with the chaser tagged as AI,
 *  and run the rubber-band system one tick. Returns the post-tick
 *  topSpeedFactor on the chaser. */
function runOneTick(opts: {
  difficulty: 'casual' | 'standard' | 'hard'
  leaderCpAhead: number
  startFactor?: number
}): number {
  const sim = createSimWorld()
  // Leader (player) — Racer only.
  const leader = addEntity(sim)
  addComponent(sim, leader, Racer)
  RacerStore.set(leader, {
    lap: 1,
    nextCheckpoint: opts.leaderCpAhead,
    checkpointsCrossed: opts.leaderCpAhead,
    finished: false,
    raceTime: 0,
  })
  // Chaser — Racer + AITag + AIController at checkpoint 0.
  const chaser = addEntity(sim)
  addComponent(sim, chaser, Racer)
  addComponent(sim, chaser, AITag)
  addComponent(sim, chaser, AIController)
  RacerStore.set(chaser, {
    lap: 1,
    nextCheckpoint: 0,
    checkpointsCrossed: 0,
    finished: false,
    raceTime: 0,
  })
  const ctrl = defaultAIController('main', { difficulty: opts.difficulty })
  if (opts.startFactor !== undefined) ctrl.topSpeedFactor = opts.startFactor
  AIControllerStore.set(chaser, ctrl)

  rubberBandSystem(sim, trackStub(8))
  return AIControllerStore.must(chaser).topSpeedFactor
}

describe('rubberBandSystem — assist on', () => {
  afterEach(resetPlayerSettings)

  it('boosts a chaser past its baseline when the leader is far ahead', () => {
    playerSettings.aiDifficulty = 'standard'
    playerSettings.rubberBandAssist = true
    const baseline = DIFFICULTY_TUNING.standard.baselineTopSpeedFactor
    // Tick once with a 6-checkpoint gap (clamps to boost saturation).
    // SMOOTHING is 0.05 — one tick moves 5% toward the target.
    const factor = runOneTick({
      difficulty: 'standard',
      leaderCpAhead: 6,
      startFactor: baseline,
    })
    expect(factor).toBeGreaterThan(baseline)
    // ... and bounded above by the boost cap.
    expect(factor).toBeLessThanOrEqual(baseline * DIFFICULTY_TUNING.standard.rubberBandBoostCap)
  })

  it('penalizes a leading AI (negative delta) toward the penalty floor', () => {
    playerSettings.aiDifficulty = 'standard'
    playerSettings.rubberBandAssist = true
    const baseline = DIFFICULTY_TUNING.standard.baselineTopSpeedFactor
    const sim = createSimWorld()
    // A non-AI racer 2 cps ahead — `leaderProgress` becomes their value.
    const leader = addEntity(sim)
    addComponent(sim, leader, Racer)
    RacerStore.set(leader, {
      lap: 1,
      nextCheckpoint: 5,
      checkpointsCrossed: 5,
      finished: false,
      raceTime: 0,
    })
    // AI is 2 cps behind the leader-most racer — but starts boosted above
    // its baseline (simulating a tick after a prior rubber-band boost).
    // We expect the penalty/decay to drag topSpeedFactor *down* this tick
    // because the target sits below the boosted start.
    const ai = addEntity(sim)
    addComponent(sim, ai, Racer)
    addComponent(sim, ai, AITag)
    addComponent(sim, ai, AIController)
    RacerStore.set(ai, {
      lap: 1,
      nextCheckpoint: 3,
      checkpointsCrossed: 3,
      finished: false,
      raceTime: 0,
    })
    const ctrl = defaultAIController('main', { difficulty: 'standard' })
    ctrl.topSpeedFactor = baseline * 1.2 // boosted
    AIControllerStore.set(ai, ctrl)
    rubberBandSystem(sim, trackStub(8))
    expect(AIControllerStore.must(ai).topSpeedFactor).toBeLessThan(baseline * 1.2)
  })

  it('Casual boost is capped below Hard boost (band keeps tier separation)', () => {
    playerSettings.rubberBandAssist = true
    // After many ticks, settles to baseline × cap.
    let casualFactor = DIFFICULTY_TUNING.casual.baselineTopSpeedFactor
    let hardFactor = DIFFICULTY_TUNING.hard.baselineTopSpeedFactor
    for (let i = 0; i < 200; i++) {
      casualFactor = runOneTick({
        difficulty: 'casual',
        leaderCpAhead: 8,
        startFactor: casualFactor,
      })
      hardFactor = runOneTick({
        difficulty: 'hard',
        leaderCpAhead: 8,
        startFactor: hardFactor,
      })
    }
    // Casual AI flat-out cannot reach a Hard AI's baseline speed —
    // tier separation is what the difficulty slider promises.
    expect(casualFactor).toBeLessThan(DIFFICULTY_TUNING.hard.baselineTopSpeedFactor)
    expect(hardFactor).toBeGreaterThan(casualFactor)
  })
})

describe('rubberBandSystem — assist off', () => {
  afterEach(resetPlayerSettings)

  it('decays topSpeedFactor toward baseline when the assist is off', () => {
    playerSettings.aiDifficulty = 'standard'
    playerSettings.rubberBandAssist = false
    const baseline = DIFFICULTY_TUNING.standard.baselineTopSpeedFactor
    // Start the AI at a juiced factor (as if rubber-band had been on);
    // with assist off, it should drift back toward baseline.
    let factor = baseline * 1.18
    for (let i = 0; i < 100; i++) {
      factor = runOneTick({
        difficulty: 'standard',
        leaderCpAhead: 10,
        startFactor: factor,
      })
    }
    expect(factor).toBeCloseTo(baseline, 2)
  })

  it('ignores leader-vs-chaser gap entirely when assist is off', () => {
    playerSettings.aiDifficulty = 'standard'
    playerSettings.rubberBandAssist = false
    const baseline = DIFFICULTY_TUNING.standard.baselineTopSpeedFactor
    // Two large-gap scenarios should converge to the same value:
    // baseline — proving the leader gap is ignored.
    let farBehind = baseline
    let bunched = baseline
    for (let i = 0; i < 50; i++) {
      farBehind = runOneTick({
        difficulty: 'standard',
        leaderCpAhead: 12,
        startFactor: farBehind,
      })
      bunched = runOneTick({
        difficulty: 'standard',
        leaderCpAhead: 0,
        startFactor: bunched,
      })
    }
    expect(farBehind).toBeCloseTo(bunched, 5)
  })
})

describe('player-settings persistence', () => {
  afterEach(() => {
    try {
      window.localStorage.removeItem('hoverbike.playerSettings.v1')
    } catch {
      // jsdom may not provide localStorage in every env — silent ok
    }
    resetPlayerSettings()
  })

  it('round-trips aiDifficulty + rubberBandAssist via localStorage', () => {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(
      'hoverbike.playerSettings.v1',
      JSON.stringify({
        wavePumpIntensity: 'subtle',
        aiDifficulty: 'hard',
        rubberBandAssist: false,
      }),
    )
    loadPlayerSettings()
    expect(playerSettings.aiDifficulty).toBe('hard')
    expect(playerSettings.rubberBandAssist).toBe(false)
  })

  it('setRubberBandAssist toggles the live flag', () => {
    setRubberBandAssist(false)
    expect(playerSettings.rubberBandAssist).toBe(false)
    setRubberBandAssist(true)
    expect(playerSettings.rubberBandAssist).toBe(true)
  })
})
