/**
 * Tutorial HUD widget — top-centered prompt that shows the current
 * beat's title + hint, flashes green on a clear, fades out at script
 * end.
 *
 * Render-only — never touches sim state. Driven by the game-loop's
 * tutorial director callbacks (`armBeat` → `setBeat`,
 * `onBeatCleared` → `flashCleared`, `onCompleted` → `finish`).
 *
 * Honors `playerSettings.tutorialSubtitles`: when off, the hint line
 * is suppressed but the title chyron and clear flash stay visible —
 * the chyron is gameplay-critical, the hint is the read-along layer.
 */

import { playerSettings } from '@/engine/player-settings'

export interface TutorialHudBeat {
  title: string
  hint?: string
  /** "BEAT n/N" — drawn small above the title so the player has a
   *  rough sense of how much tutorial is left. */
  progressLabel: string
}

export interface TutorialHud {
  /** Show or update the current beat. */
  setBeat(beat: TutorialHudBeat): void
  /** Flash the green clear chord briefly. */
  flashCleared(clearMessage: string): void
  /** Show the finish message, then fade out after ~2.5s. */
  finish(finishMessage: string): void
  /** Hide the widget entirely — caller hooks this on race-leave. */
  dispose(): void
}

const CLEAR_FLASH_MS = 900
const FINISH_FADE_MS = 2500

export function createTutorialHud(): TutorialHud {
  const slot = document.getElementById('hud-tutorial')
  if (!slot) {
    const noop: TutorialHud = {
      setBeat() {},
      flashCleared() {},
      finish() {},
      dispose() {},
    }
    return noop
  }

  slot.innerHTML = `
    <div class="tut-shell" aria-live="polite">
      <div class="tut-meta" id="tut-meta">BEAT 1</div>
      <div class="tut-title" id="tut-title">TUTORIAL</div>
      <div class="tut-hint" id="tut-hint"></div>
    </div>
  `
  const shell = slot.querySelector<HTMLElement>('.tut-shell')
  const titleEl = slot.querySelector<HTMLElement>('#tut-title')
  const hintEl = slot.querySelector<HTMLElement>('#tut-hint')
  const metaEl = slot.querySelector<HTMLElement>('#tut-meta')
  if (!shell || !titleEl || !hintEl || !metaEl) {
    return { setBeat() {}, flashCleared() {}, finish() {}, dispose() {} }
  }

  let armed = true
  let clearTimer: number | null = null
  let finishTimer: number | null = null

  function clearTimers(): void {
    if (clearTimer !== null) {
      window.clearTimeout(clearTimer)
      clearTimer = null
    }
    if (finishTimer !== null) {
      window.clearTimeout(finishTimer)
      finishTimer = null
    }
  }

  function show(): void {
    slot?.removeAttribute('hidden')
    shell?.classList.add('tut-active')
  }

  function hide(): void {
    shell?.classList.remove('tut-active')
    window.setTimeout(() => {
      // Only flip the slot's hidden attr if no new beat re-armed during the fade.
      if (!shell?.classList.contains('tut-active')) {
        slot?.setAttribute('hidden', '')
      }
    }, 280)
  }

  return {
    setBeat(beat) {
      if (!armed) return
      clearTimers()
      shell.classList.remove('tut-cleared', 'tut-finish')
      titleEl.textContent = beat.title
      metaEl.textContent = beat.progressLabel
      if (playerSettings.tutorialSubtitles && beat.hint) {
        hintEl.textContent = beat.hint
        hintEl.removeAttribute('hidden')
      } else {
        hintEl.textContent = ''
        hintEl.setAttribute('hidden', '')
      }
      show()
    },
    flashCleared(clearMessage) {
      if (!armed) return
      clearTimers()
      shell.classList.add('tut-cleared')
      titleEl.textContent = clearMessage || 'OK'
      hintEl.setAttribute('hidden', '')
      // The director will call setBeat() right after onBeatCleared for the
      // next arm; if it doesn't (e.g. final beat → onCompleted), we hide
      // the widget after the flash window.
      clearTimer = window.setTimeout(() => {
        if (shell.classList.contains('tut-cleared')) {
          shell.classList.remove('tut-cleared')
        }
        clearTimer = null
      }, CLEAR_FLASH_MS)
    },
    finish(finishMessage) {
      if (!armed) return
      clearTimers()
      shell.classList.remove('tut-cleared')
      shell.classList.add('tut-finish')
      titleEl.textContent = finishMessage
      hintEl.setAttribute('hidden', '')
      metaEl.textContent = 'TUTORIAL COMPLETE'
      show()
      finishTimer = window.setTimeout(() => {
        hide()
        finishTimer = null
      }, FINISH_FADE_MS)
    },
    dispose() {
      armed = false
      clearTimers()
      shell.classList.remove('tut-active', 'tut-cleared', 'tut-finish')
      slot.setAttribute('hidden', '')
    },
  }
}
