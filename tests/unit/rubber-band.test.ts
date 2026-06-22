/**
 * `rubberBandSystem` honours the assist flag PASSED IN, not the
 * `playerSettings` singleton.
 *
 * Workstream-D determinism fix: the system used to read
 * `playerSettings.rubberBandAssist` mid-tick, leaking a mutable, per-peer
 * value into the deterministic step (ADR 0002). The flag now arrives as a
 * parameter (threaded through `StepInputs.rubberBandAssist`). These tests
 * pin that contract: behavior is a pure function of (world, track, flag) —
 * flipping the SINGLETON must change nothing once the explicit flag is set.
 */

import { addComponent, addEntity } from 'bitecs'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PLAYER_SETTINGS, playerSettings } from '../../src/engine/player-settings'
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

/** Leader (player) far ahead + a chaser tagged AI at checkpoint 0. Returns
 *  the chaser's post-tick topSpeedFactor for the given assist flag. */
function runOneTick(opts: {
  difficulty: 'casual' | 'standard' | 'hard'
  leaderCpAhead: number
  startFactor: number
  assistOn: boolean
}): number {
  const sim = createSimWorld()
  const leader = addEntity(sim)
  addComponent(sim, leader, Racer)
  RacerStore.set(leader, {
    lap: 1,
    nextCheckpoint: opts.leaderCpAhead,
    checkpointsCrossed: opts.leaderCpAhead,
    finished: false,
    raceTime: 0,
    forfeited: false,
  })
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
    forfeited: false,
  })
  const ctrl = defaultAIController('main', { difficulty: opts.difficulty })
  ctrl.topSpeedFactor = opts.startFactor
  AIControllerStore.set(chaser, ctrl)

  rubberBandSystem(sim, trackStub(8), opts.assistOn)
  return AIControllerStore.must(chaser).topSpeedFactor
}

describe('rubberBandSystem — flag is a parameter, not a singleton read', () => {
  afterEach(() => {
    playerSettings.rubberBandAssist = DEFAULT_PLAYER_SETTINGS.rubberBandAssist
  })

  it('assist ON boosts a far-behind chaser past its baseline', () => {
    const baseline = DIFFICULTY_TUNING.standard.baselineTopSpeedFactor
    const factor = runOneTick({
      difficulty: 'standard',
      leaderCpAhead: 6,
      startFactor: baseline,
      assistOn: true,
    })
    expect(factor).toBeGreaterThan(baseline)
    expect(factor).toBeLessThanOrEqual(baseline * DIFFICULTY_TUNING.standard.rubberBandBoostCap)
  })

  it('assist OFF settles a juiced chaser back toward baseline', () => {
    const baseline = DIFFICULTY_TUNING.standard.baselineTopSpeedFactor
    let factor = baseline * 1.18
    for (let i = 0; i < 100; i++) {
      factor = runOneTick({
        difficulty: 'standard',
        leaderCpAhead: 10,
        startFactor: factor,
        assistOn: false,
      })
    }
    expect(factor).toBeCloseTo(baseline, 2)
  })

  it('ignores the playerSettings singleton — only the passed flag matters', () => {
    const baseline = DIFFICULTY_TUNING.standard.baselineTopSpeedFactor
    // Singleton says OFF, but we pass assistOn:true → must boost anyway.
    playerSettings.rubberBandAssist = false
    const boosted = runOneTick({
      difficulty: 'standard',
      leaderCpAhead: 6,
      startFactor: baseline,
      assistOn: true,
    })
    expect(boosted).toBeGreaterThan(baseline)

    // Singleton says ON, but we pass assistOn:false → must NOT boost; one
    // tick from baseline with the assist off leaves it pinned at baseline.
    playerSettings.rubberBandAssist = true
    const notBoosted = runOneTick({
      difficulty: 'standard',
      leaderCpAhead: 6,
      startFactor: baseline,
      assistOn: false,
    })
    expect(notBoosted).toBeCloseTo(baseline, 5)
  })

  it('is a no-op when there are no racers', () => {
    const sim = createSimWorld()
    // Should not throw with either flag value on an empty world.
    expect(() => rubberBandSystem(sim, trackStub(8), true)).not.toThrow()
    expect(() => rubberBandSystem(sim, trackStub(8), false)).not.toThrow()
  })
})
