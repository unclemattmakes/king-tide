/**
 * Launch-grade HUD — the two-word verdict chyron for the wave-mastery
 * loop (launch-grade.ts). Fires on the sim's takeoff / landing edge
 * flags and tells the player, in motocross-commentary voice, how the
 * jump went:
 *
 *   takeoff:  CLEAN LAUNCH / GOOD POP / LATE POP
 *   landing:  STOMPED IT   / RODE IT OUT / CASED IT
 *
 * Hangs off the `#hud-launch-grade` slot (Step 0 HUD scaffold), sits
 * one band above the wave-pump slot so trick flash and jump verdict
 * never overprint. Honors `playerSettings.wavePumpIntensity` exactly
 * like the wave-pump widget — the setting governs the whole
 * wave-mastery FX family:
 *
 *   - `full`   → chyron flash + quality bar
 *   - `subtle` → small dot pulse only
 *   - `off`    → nothing
 *
 * Render-only; never touches sim state.
 */

import { playerSettings } from '@/engine/player-settings'
import { type LaunchVerdict, verdictFor } from '@/game/systems/launch-grade'

export interface LaunchGradeHud {
  /** Flash a verdict. `kind` picks the label family; `quality` (0..1)
   *  picks the tier and drives the bar + glow strength. */
  flash(kind: 'launch' | 'landing', quality: number): void
  dispose(): void
}

const FLASH_LIFE_MS = 860

const LABELS: Record<'launch' | 'landing', Record<LaunchVerdict, string>> = {
  launch: { clean: 'CLEAN LAUNCH', ok: 'GOOD POP', sloppy: 'LATE POP' },
  landing: { clean: 'STOMPED IT', ok: 'RODE IT OUT', sloppy: 'CASED IT' },
}

export function createLaunchGradeHud(): LaunchGradeHud {
  const slot = document.getElementById('hud-launch-grade')
  if (!slot) {
    // Defensive — stripped-down test pages may lack the scaffold.
    return { flash() {}, dispose() {} }
  }

  slot.innerHTML = `
    <div class="lg-shell" aria-hidden="true">
      <span class="lg-dot"></span>
      <div class="lg-flash">
        <div class="lg-label"></div>
        <div class="lg-bar"><i></i></div>
      </div>
    </div>
  `
  const shell = slot.querySelector<HTMLElement>('.lg-shell')
  const label = slot.querySelector<HTMLElement>('.lg-label')
  const bar = slot.querySelector<HTMLElement>('.lg-bar i')
  if (!shell || !label || !bar) return { flash() {}, dispose() {} }

  let hideTimer: number | null = null
  let armed = true

  function hideAfterFlash(): void {
    if (hideTimer !== null) window.clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => {
      shell?.classList.remove('lg-active', 'lg-subtle', 'lg-full', 'lg-clean', 'lg-ok', 'lg-sloppy')
      slot?.setAttribute('hidden', '')
      hideTimer = null
    }, FLASH_LIFE_MS)
  }

  return {
    flash(kind, quality) {
      if (!armed) return
      const mode = playerSettings.wavePumpIntensity
      if (mode === 'off') return

      const verdict = verdictFor(quality)
      const q = Math.max(0.15, Math.min(1, quality))
      slot.removeAttribute('hidden')
      shell.classList.remove('lg-active', 'lg-subtle', 'lg-full', 'lg-clean', 'lg-ok', 'lg-sloppy')
      // Force reflow so re-adding the class restarts the keyframe even
      // when two verdicts land inside one fade window (takeoff, then
      // its landing ~a second later).
      void shell.offsetWidth
      label.textContent = LABELS[kind][verdict]
      bar.style.width = `${Math.round(q * 100)}%`
      shell.style.setProperty('--lg-strength', q.toFixed(3))
      shell.classList.add('lg-active', mode === 'subtle' ? 'lg-subtle' : 'lg-full', `lg-${verdict}`)
      hideAfterFlash()
    },
    dispose() {
      armed = false
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer)
        hideTimer = null
      }
      slot.setAttribute('hidden', '')
      shell.classList.remove('lg-active', 'lg-subtle', 'lg-full', 'lg-clean', 'lg-ok', 'lg-sloppy')
    },
  }
}
