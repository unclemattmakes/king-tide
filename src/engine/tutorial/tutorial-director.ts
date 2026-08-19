/**
 * Tutorial director — drives a script's beats from per-frame sim
 * state. Pure logic, no DOM access. Render wiring lives in
 * `tutorial-hud.ts`; the game-loop integration in `game-loop.ts`
 * stitches the two together.
 *
 * Lifecycle:
 *
 *   create → tick(dt, sample) → ... → completes
 *
 * `sample` is a per-frame slice of player + sim state (raw values,
 * not a TutorialContext — the director assembles the context itself
 * so per-beat counters like `pumpEventsThisBeat` stay private to it).
 * `notifyPumpEvent()` and `notifyOrbitTouch()` are the two
 * out-of-band signals the host calls when a pump fires or the look
 * input moved.
 *
 * The director is **strictly deterministic given the same sample
 * sequence + signals** — no Date.now() calls, no random retries —
 * which keeps it replay-safe should we ever want to record tutorial
 * runs.
 */

import type {
  BeatClearKind,
  BeatClearResult,
  TutorialBeat,
  TutorialContext,
  TutorialScript,
} from './tutorial-script'

export interface TutorialDirectorEvents {
  /** Called when a beat clears. `how` distinguishes an actually
   *  performed action (`'performed'`) from the escape-hatch timer or
   *  an explicit skip (`'timeout'`), so the host can celebrate the
   *  first and stay neutral on the second. */
  onBeatCleared?: (beat: TutorialBeat, how: BeatClearKind) => void
  /** Called when a new beat arms — useful for HUD widget swap. */
  onBeatArmed?: (beat: TutorialBeat) => void
  /** Called once when the script has finished. The host should mark
   *  the tutorial completed flag and stop ticking. */
  onCompleted?: () => void
}

/** Per-frame sample handed in by the game-loop. Mirrors the
 *  fields TutorialContext exposes that the host already has on hand —
 *  per-beat counters get layered on by the director. */
export interface TutorialSample {
  playerSpeed: number
  throttle: number
  /** Parked with anti-grav (cut) — no shipped beat reads it; kept so
   *  the sample shape survives a future DLC re-enable. */
  inAntiGrav: boolean
}

export interface TutorialDirector {
  /** Advance the active beat by `dt` seconds, evaluate its clear
   *  predicate, and trigger lifecycle callbacks. */
  tick(dt: number, sample: TutorialSample): void
  /** Out-of-band: the host saw a wave-pump event this frame. */
  notifyPumpEvent(): void
  /** Out-of-band: the host saw the player nudge orbit/look inputs. */
  notifyOrbitTouch(): void
  /** Out-of-band: the player released a drift mini-turbo at `tier`
   *  (1 = MT, 2 = SMT, 3 = UMT). The director keeps the max tier
   *  seen this beat. */
  notifyDrift(tier: number): void
  /** Current beat being shown (or `null` if completed / not started). */
  currentBeat(): TutorialBeat | null
  /** Index of the current beat in the script's beat list. */
  currentBeatIndex(): number
  /** True once the script's final beat has cleared. */
  isCompleted(): boolean
  /** Skip the current beat — used by Settings → "Skip beat" or by a
   *  debug button. */
  skipCurrentBeat(): void
}

export function createTutorialDirector(
  script: TutorialScript,
  events: TutorialDirectorEvents = {},
): TutorialDirector {
  let beatIndex = 0
  let beatTime = 0
  let tutorialTime = 0
  let pumpEventsThisBeat = 0
  let orbitTouchedThisBeat = false
  let driftTierThisBeat = 0
  let completed = false
  let armed = false

  function armBeat(idx: number): void {
    beatIndex = idx
    beatTime = 0
    pumpEventsThisBeat = 0
    orbitTouchedThisBeat = false
    driftTierThisBeat = 0
    armed = true
    const beat = script.beats[idx]
    if (beat && events.onBeatArmed) events.onBeatArmed(beat)
  }

  function clearBeat(beat: TutorialBeat, how: BeatClearKind): void {
    if (events.onBeatCleared) events.onBeatCleared(beat, how)
    if (beatIndex + 1 >= script.beats.length) {
      completed = true
      armed = false
      if (events.onCompleted) events.onCompleted()
    } else {
      armBeat(beatIndex + 1)
    }
  }

  function evaluatePredicate(beat: TutorialBeat, ctx: TutorialContext): boolean {
    const result: BeatClearResult = beat.clearWhen(ctx)
    if (typeof result === 'boolean') return result
    return result.cleared
  }

  return {
    tick(dt, sample) {
      if (completed) return
      if (!armed) {
        // First tick — arm beat 0 lazily so a single-beat script with
        // an unconditional clearWhen doesn't fire before the host's
        // onBeatArmed callback is wired.
        armBeat(0)
      }
      tutorialTime += dt
      beatTime += dt
      const beat = script.beats[beatIndex]
      if (!beat) return
      const ctx: TutorialContext = {
        beatTime,
        tutorialTime,
        playerSpeed: sample.playerSpeed,
        throttle: sample.throttle,
        pumpEventsThisBeat,
        inAntiGrav: sample.inAntiGrav,
        orbitTouchedThisBeat,
        driftTierThisBeat,
      }
      if (evaluatePredicate(beat, ctx)) {
        clearBeat(beat, 'performed')
        return
      }
      if (typeof beat.clearAfterSeconds === 'number' && beatTime >= beat.clearAfterSeconds) {
        clearBeat(beat, 'timeout')
      }
    },
    notifyPumpEvent() {
      if (!completed && armed) pumpEventsThisBeat += 1
    },
    notifyOrbitTouch() {
      if (!completed && armed) orbitTouchedThisBeat = true
    },
    notifyDrift(tier) {
      if (!completed && armed && tier > driftTierThisBeat) {
        driftTierThisBeat = Math.max(0, Math.min(3, Math.floor(tier)))
      }
    },
    currentBeat() {
      if (completed || !armed) return null
      return script.beats[beatIndex] ?? null
    },
    currentBeatIndex() {
      return beatIndex
    },
    isCompleted() {
      return completed
    },
    skipCurrentBeat() {
      const beat = script.beats[beatIndex]
      if (beat) clearBeat(beat, 'timeout')
    },
  }
}
