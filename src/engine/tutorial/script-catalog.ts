/**
 * Tutorial script catalog — per-track script selection for the beat
 * director. `?tutorial=1` used to hard-wire `DEFAULT_TUTORIAL_SCRIPT`;
 * the Practice mode (evaluation summary #1 / game-design #1, maintainer
 * decision 2026-08-22) needs its own station script on the practice
 * lagoon, so the game-loop now resolves the script by track id and
 * falls back to the intro script everywhere else — sandbar's First Run
 * stays byte-identical.
 *
 * The practice script is the "station per skill" pass: the lagoon's
 * loop is laid out in beat order (throttle straight → swell lane →
 * trick ramp → tuck rollers → drift sweep), so the prompts arrive as
 * the player reaches each station. Two laps = a coached lap plus a
 * consolidation lap. Same escape-hatch philosophy as the intro script:
 * skill beats carry a long `clearAfterSeconds` leash, celebration is
 * reserved for performed actions, nothing hard-gates.
 */

import { VERDICT_OK_MIN } from '@/game/systems/launch-grade'
import { DEFAULT_TUTORIAL_SCRIPT, type TutorialScript } from './tutorial-script'

/** Track id of the practice lagoon venue (public/tracks/practice-lagoon.json). */
export const PRACTICE_LAGOON_TRACK_ID = 'practice-lagoon'

/** Tuck sweet-spot factor a practice tuck must reach to clear. 1.0 is
 *  a perfect notch-match; 0.7 is a genuine feather without demanding
 *  frame-perfect lean on moving water. */
export const PRACTICE_TUCK_CLEAR_FACTOR = 0.7

export const PRACTICE_LAGOON_SCRIPT: TutorialScript = {
  id: 'practice-lagoon',
  label: 'PRACTICE',
  finishMessage: 'SKILLS SET — GO RACE',
  beats: [
    {
      id: 'throttle',
      title: 'THROTTLE',
      hint: 'Hold A / Right Trigger to accelerate down the marked straight.',
      clearWhen: (ctx) => ctx.playerSpeed > 6,
      clearMessage: 'NICE!',
    },
    {
      id: 'sustained-speed',
      title: 'CRUISE',
      hint: 'Keep the throttle pinned — let the bike settle before the swell lane.',
      clearWhen: (ctx) => ctx.playerSpeed > 14,
      clearMessage: '+SPEED',
    },
    {
      // Station 1 (blue pylons): the swell lane. Unlike the intro
      // script's "any launch counts", practice asks for a *shaped*
      // pop — the takeoff verdict has to grade ok or better.
      id: 'wave-launch',
      title: 'LAUNCH',
      hint: 'Blue pylons: hold E (or pull the stick) up the swell and pop off the crest — nose up.',
      clearWhen: (ctx) => ctx.bestLaunchQualityThisBeat >= VERDICT_OK_MIN,
      clearAfterSeconds: 45,
      clearMessage: '+AIR',
    },
    {
      id: 'stick-landing',
      title: 'STICK THE LANDING',
      hint: 'Level out with E / Q so the nose matches the water when you touch down.',
      clearWhen: (ctx) => ctx.bestLandingQualityThisBeat >= VERDICT_OK_MIN,
      clearAfterSeconds: 45,
      clearMessage: 'STOMPED!',
    },
    {
      // Station 2 (orange pylons): the jump table. Tricks ride the
      // pump-event channel — the render loop fires it when a credible
      // trick lands.
      id: 'trick',
      title: 'TRICK',
      hint: 'Orange pylons: launch off the table, then tap Z or C in the air to throw a trick.',
      clearWhen: (ctx) => ctx.pumpEventsThisBeat >= 1,
      clearAfterSeconds: 45,
      clearMessage: '+STYLE',
    },
    {
      // Station 3 (green pylons): the rollers. Feather the nose-down
      // lean on each back face — the sweet-spot factor has to reach a
      // real feather, not a buried nose.
      id: 'tuck',
      title: 'TUCK',
      hint: 'Green pylons: lean forward gently (Q / stick) down each roller — feather it, don’t bury it.',
      clearWhen: (ctx) => ctx.bestTuckFactorThisBeat >= PRACTICE_TUCK_CLEAR_FACTOR,
      clearAfterSeconds: 45,
      clearMessage: 'FEATHERED',
    },
    {
      // Station 4 (red pylons): the long sweep. Built to hold a drift
      // well past the SMT threshold — practice asks for the
      // skill-payoff tier, not just a blue MT.
      id: 'drift',
      title: 'DRIFT',
      hint: 'Red pylons: hold Z / C through the whole sweep, release at orange (SMT) or better.',
      clearWhen: (ctx) => ctx.driftTierThisBeat >= 2,
      clearAfterSeconds: 45,
      clearMessage: '+TURBO',
    },
    {
      id: 'race-ready',
      title: 'READY',
      hint: 'Every station is yours to re-run. Finish the lap to graduate.',
      clearWhen: (ctx) => ctx.beatTime > 4,
      clearMessage: 'GO!',
    },
  ],
}

const SCRIPTS_BY_TRACK: Readonly<Record<string, TutorialScript>> = Object.freeze({
  [PRACTICE_LAGOON_TRACK_ID]: PRACTICE_LAGOON_SCRIPT,
})

/** Resolve the tutorial script for a track. Defaults to the intro
 *  script, so `?tutorial=1` on any other venue behaves exactly as
 *  before this catalog existed. */
export function tutorialScriptForTrack(trackId: string | null | undefined): TutorialScript {
  if (trackId) {
    const script = SCRIPTS_BY_TRACK[trackId]
    if (script) return script
  }
  return DEFAULT_TUTORIAL_SCRIPT
}
