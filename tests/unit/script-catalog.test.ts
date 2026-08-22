/**
 * Tutorial script catalog — per-track script resolution + the practice
 * lagoon's station script shape (evaluation summary #1 / game-design
 * #1, maintainer decision 2026-08-22).
 */

import { describe, expect, it } from 'vitest'
import {
  PRACTICE_LAGOON_SCRIPT,
  PRACTICE_LAGOON_TRACK_ID,
  tutorialScriptForTrack,
} from '../../src/engine/tutorial/script-catalog'
import { DEFAULT_TUTORIAL_SCRIPT } from '../../src/engine/tutorial/tutorial-script'

describe('tutorialScriptForTrack', () => {
  it('resolves the practice lagoon to its station script', () => {
    expect(tutorialScriptForTrack(PRACTICE_LAGOON_TRACK_ID)).toBe(PRACTICE_LAGOON_SCRIPT)
  })

  it('falls back to the intro script everywhere else — sandbar First Run unchanged', () => {
    expect(tutorialScriptForTrack('sandbar')).toBe(DEFAULT_TUTORIAL_SCRIPT)
    expect(tutorialScriptForTrack('lagoon')).toBe(DEFAULT_TUTORIAL_SCRIPT)
    expect(tutorialScriptForTrack(null)).toBe(DEFAULT_TUTORIAL_SCRIPT)
    expect(tutorialScriptForTrack(undefined)).toBe(DEFAULT_TUTORIAL_SCRIPT)
  })
})

describe('PRACTICE_LAGOON_SCRIPT', () => {
  it('covers a station per skill, in ride order', () => {
    // The lagoon's loop is laid out in exactly this order — the
    // practice-lagoon-track test pins the geometry side of the pairing.
    expect(PRACTICE_LAGOON_SCRIPT.beats.map((b) => b.id)).toEqual([
      'throttle',
      'sustained-speed',
      'wave-launch',
      'stick-landing',
      'trick',
      'tuck',
      'drift',
      'race-ready',
    ])
  })

  it('gives every skill beat an escape hatch — practice never hard-gates', () => {
    const skillBeats = PRACTICE_LAGOON_SCRIPT.beats.filter(
      (b) => !['throttle', 'sustained-speed', 'race-ready'].includes(b.id),
    )
    for (const beat of skillBeats) {
      expect(beat.clearAfterSeconds).toBeGreaterThan(0)
    }
  })

  it('asks for a shaped launch, not just any air', () => {
    const launch = PRACTICE_LAGOON_SCRIPT.beats.find((b) => b.id === 'wave-launch')!
    // Quality-gated: a graded-0 hop must not clear the practice beat...
    expect(
      launch.clearWhen({
        beatTime: 1,
        tutorialTime: 1,
        playerSpeed: 20,
        throttle: 1,
        pumpEventsThisBeat: 0,
        launchesThisBeat: 3,
        bestLaunchQualityThisBeat: 0.1,
        bestLandingQualityThisBeat: 0,
        bestTuckFactorThisBeat: 0,
        inAntiGrav: false,
        orbitTouchedThisBeat: false,
        driftTierThisBeat: 0,
      }),
    ).toBe(false)
    // ...while an ok-or-better pop does.
    expect(
      launch.clearWhen({
        beatTime: 1,
        tutorialTime: 1,
        playerSpeed: 20,
        throttle: 1,
        pumpEventsThisBeat: 0,
        launchesThisBeat: 1,
        bestLaunchQualityThisBeat: 0.5,
        bestLandingQualityThisBeat: 0,
        bestTuckFactorThisBeat: 0,
        inAntiGrav: false,
        orbitTouchedThisBeat: false,
        driftTierThisBeat: 0,
      }),
    ).toBe(true)
  })

  it('asks the drift station for SMT — the sweep is built to afford it', () => {
    const drift = PRACTICE_LAGOON_SCRIPT.beats.find((b) => b.id === 'drift')!
    const ctx = {
      beatTime: 1,
      tutorialTime: 1,
      playerSpeed: 20,
      throttle: 1,
      pumpEventsThisBeat: 0,
      launchesThisBeat: 0,
      bestLaunchQualityThisBeat: 0,
      bestLandingQualityThisBeat: 0,
      bestTuckFactorThisBeat: 0,
      inAntiGrav: false,
      orbitTouchedThisBeat: false,
      driftTierThisBeat: 1,
    }
    expect(drift.clearWhen(ctx)).toBe(false)
    expect(drift.clearWhen({ ...ctx, driftTierThisBeat: 2 })).toBe(true)
  })
})
