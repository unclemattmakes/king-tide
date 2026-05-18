/**
 * Tutorial framework — script types + the canned default script.
 *
 * A tutorial **script** is an ordered list of **beats**. Each beat
 * pairs a player-facing prompt (mechanic name + one-line instruction)
 * with a **clear predicate** evaluated each frame against a snapshot
 * of player + sim state. When the predicate returns true the beat
 * "clears" (success flash, optional `clearMessage`) and the next beat
 * arms.
 *
 * Beats deliberately have no track-specific dependencies — they look
 * at speed, throttle, wave-pump events, anti-grav engagement, drift
 * angle, look-around. That's enough to validate the framework's
 * primary mechanics without a Sandbar-shaped course; once Sandbar
 * lands (M13) it ships its own track-specific script that uses the
 * same shape but adds checkpoint-region predicates.
 *
 * Failure mode: a beat that never clears is fine. Tutorials don't
 * "fail" — they just hold their prompt up until the player figures it
 * out or skips. The framework's only escape hatches are:
 *
 *   - **Skip toggle** — returning players can dismiss the whole
 *     framework via Settings → Gameplay → Subtitles, or via the
 *     `?tutorial=0` URL override.
 *   - **Per-beat timeout** — beats with `clearAfterSeconds` clear
 *     automatically once the timer expires. Useful for the
 *     "look around" beat where there's no objective success signal.
 */

/** Snapshot the director hands to each beat's `clearWhen` predicate.
 *  Read-only — beats must never mutate sim/render state. */
export interface TutorialContext {
  /** Elapsed seconds since the current beat armed. */
  beatTime: number
  /** Elapsed seconds since the tutorial as a whole began. */
  tutorialTime: number
  /** Player horizontal speed (m/s). Already smoothed by the
   *  game-loop's player-snapshot computation. */
  playerSpeed: number
  /** Forward throttle ∈ [0,1] — current frame value. */
  throttle: number
  /** Wave-pump events received since the current beat armed. The
   *  director clears this counter at every beat arm. */
  pumpEventsThisBeat: number
  /** True while the player is engaged with an anti-grav source
   *  (override.active && weight > threshold). */
  inAntiGrav: boolean
  /** Whether the player held an orbit/look-around input since the
   *  beat armed. Lets a "look around" beat clear on player action. */
  orbitTouchedThisBeat: boolean
}

/** Result of a beat's predicate. Booleans are accepted as shorthand
 *  for `{ cleared: bool }` — the wrapping object is only needed when
 *  a beat wants to also bump its progress hint. */
export type BeatClearResult = boolean | { cleared: boolean; progressHint?: string }

export interface TutorialBeat {
  /** Stable id — used in tests + the persisted "last beat seen". */
  id: string
  /** Big-display mechanic name. Kept short ("WAVE PUMP", "THROTTLE"). */
  title: string
  /** One-line instruction. Optional — short beats can lean on title alone. */
  hint?: string
  /** Predicate evaluated each frame. Returns true once the beat is done. */
  clearWhen: (ctx: TutorialContext) => BeatClearResult
  /** Auto-clear after N seconds even if `clearWhen` never fires.
   *  Lets passive "look at this" beats keep the script moving. */
  clearAfterSeconds?: number
  /** Short flash text shown when the beat clears, e.g. "NICE!" or
   *  "+PUMP". Falls through to "OK" if omitted. */
  clearMessage?: string
}

export interface TutorialScript {
  id: string
  /** Short title shown when the tutorial first opens. */
  label: string
  beats: TutorialBeat[]
  /** Final message shown after the last beat clears. */
  finishMessage: string
}

/** v1 framework's canned script. Track-agnostic — works on any
 *  manifest track. Sandbar adds its own scripted scenarios on top.
 *
 *  Six beats — matches the count called out in the cathedral menu
 *  copy ("Six scripted beats — throttle, swell pump, drift around a
 *  buoy, pickup, ramp, anti-grav arch") with the drift/pickup/ramp
 *  ones swapped for what we can detect generically today (look
 *  around, sustained speed, anti-grav). */
export const DEFAULT_TUTORIAL_SCRIPT: TutorialScript = {
  id: 'first-run-intro',
  label: 'INTRO',
  finishMessage: 'GOOD RIDE — GO RACE',
  beats: [
    {
      id: 'throttle',
      title: 'THROTTLE',
      hint: 'Hold A / Right Trigger to accelerate.',
      clearWhen: (ctx) => ctx.playerSpeed > 6,
      clearMessage: 'NICE!',
    },
    {
      id: 'sustained-speed',
      title: 'CRUISE',
      hint: 'Keep the throttle pinned — let the bike settle.',
      clearWhen: (ctx) => ctx.playerSpeed > 14,
      clearMessage: '+SPEED',
    },
    {
      id: 'look-around',
      title: 'LOOK AROUND',
      hint: 'Right stick / mouse-drag to peek at the wave-line.',
      clearWhen: (ctx) => ctx.orbitTouchedThisBeat,
      clearAfterSeconds: 8,
      clearMessage: 'EYES UP',
    },
    {
      id: 'wave-pump',
      title: 'WAVE PUMP',
      hint: 'Throttle at the swell crest to launch off the wave.',
      clearWhen: (ctx) => ctx.pumpEventsThisBeat >= 1,
      clearAfterSeconds: 25,
      clearMessage: '+PUMP',
    },
    {
      id: 'anti-grav',
      title: 'ANTI-GRAV',
      hint: 'Ride a banked wall or arch — gravity follows the surface.',
      clearWhen: (ctx) => ctx.inAntiGrav,
      clearAfterSeconds: 30,
      clearMessage: '+ARCH',
    },
    {
      id: 'race-ready',
      title: 'READY',
      hint: 'You have the basics. Finish the lap to graduate.',
      clearWhen: (ctx) => ctx.beatTime > 4,
      clearMessage: 'GO!',
    },
  ],
}
