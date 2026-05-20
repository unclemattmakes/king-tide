/**
 * Wave-pump HUD widget — visual half of the wave-pump signal.
 *
 * Hangs off the `#hud-wave-pump` slot reserved in the Step 0 HUD
 * scaffold. Stays empty + hidden by default; flashes on every pump
 * event the observer emits.
 *
 * The widget reads `playerSettings.wavePumpIntensity` each fire:
 *
 *   - `full`   → full chyron-style flash with the "PUMP +" label and
 *                a strength-driven bar
 *   - `subtle` → small left-side dot, single pulse
 *   - `off`    → nothing
 *
 * Render-only — never touches sim state. Designed to outlive the
 * eventual proper pump-physics work in M11–12: the trigger upgrades
 * but the widget contract (one `pump(strength)` call per event)
 * stays the same.
 */

import { playerSettings } from '@/engine/player-settings'

export interface WavePumpHud {
  /** Fire the visual cue. `strength` is the same 0..1 the audio engine
   *  receives; the widget scales its flash + bar fill accordingly.
   *  `perfect` upgrades the label to "TRICK!" and swaps in the brighter
   *  perfect-tier class — see the `.wp-perfect` styles in index.html. */
  pump(strength: number, perfect?: boolean): void
  /** Hide the widget — e.g. when leaving the race. The reserved
   *  `#hud-wave-pump` slot stays in the DOM either way. */
  dispose(): void
}

/** Half-life (ms) for the after-flash fade. Tuned by feel: short
 *  enough that back-to-back pumps still read as separate events,
 *  long enough that a single pump leaves an unmistakable visual
 *  receipt instead of a single-frame flicker. */
const FLASH_LIFE_MS = 720

export function createWavePumpHud(): WavePumpHud {
  const slot = document.getElementById('hud-wave-pump')
  if (!slot) {
    // Defensive — index.html ships the slot, but stripped-down test
    // pages may not. Return a no-op handle so the loop wiring doesn't
    // crash without the DOM.
    const noop: WavePumpHud = { pump() {}, dispose() {} }
    return noop
  }

  // Inject the widget shell once. Subsequent pumps re-set the strength
  // var + re-key the animation by toggling a class off then back on.
  // The label slot is mutated per-fire ("PUMP +" → "TRICK!") so the
  // perfect tier reads at a glance.
  slot.innerHTML = `
    <div class="wp-shell" data-mode="off" aria-hidden="true">
      <span class="wp-dot"></span>
      <div class="wp-flash">
        <div class="wp-label">PUMP <b>+</b></div>
        <div class="wp-bar"><i></i></div>
      </div>
    </div>
  `
  const shell = slot.querySelector<HTMLElement>('.wp-shell')
  const bar = slot.querySelector<HTMLElement>('.wp-bar i')
  const dot = slot.querySelector<HTMLElement>('.wp-dot')
  const flash = slot.querySelector<HTMLElement>('.wp-flash')
  const label = slot.querySelector<HTMLElement>('.wp-label')
  if (!shell || !bar || !dot || !flash || !label) {
    return { pump() {}, dispose() {} }
  }

  let hideTimer: number | null = null
  let armed = true

  function hideAfterFlash(): void {
    if (hideTimer !== null) window.clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => {
      shell?.classList.remove('wp-active', 'wp-subtle', 'wp-full', 'wp-perfect')
      slot?.setAttribute('hidden', '')
      hideTimer = null
    }, FLASH_LIFE_MS)
  }

  return {
    pump(strength, perfect = false) {
      if (!armed) return
      const mode = playerSettings.wavePumpIntensity
      if (mode === 'off') return

      const s = Math.max(0.2, Math.min(1, strength))
      shell.dataset.mode = mode
      // The slot itself is `hidden` in markup; flip it on for the
      // flash window. menu-active still hides it via the existing CSS.
      slot.removeAttribute('hidden')

      // Strip + re-add the active class so the CSS animation restarts
      // even when two pumps land inside the same fade window.
      shell.classList.remove('wp-active', 'wp-subtle', 'wp-full', 'wp-perfect')
      // Force reflow so the next class-add reliably re-triggers the
      // keyframe animation (Chrome/Firefox/Safari all need this when
      // toggling animation classes on the same frame).
      void shell.offsetWidth
      bar.style.width = `${Math.round(s * 100)}%`
      shell.style.setProperty('--wp-strength', s.toFixed(3))
      // Perfect-tier presses get the "TRICK!" chyron and brighter class;
      // baseline pumps fall back to the "PUMP +" label.
      if (perfect) {
        label.textContent = 'TRICK !'
      } else {
        label.innerHTML = 'PUMP <b>+</b>'
      }
      shell.classList.add('wp-active', mode === 'subtle' ? 'wp-subtle' : 'wp-full')
      if (perfect) shell.classList.add('wp-perfect')

      hideAfterFlash()
    },
    dispose() {
      armed = false
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer)
        hideTimer = null
      }
      slot.setAttribute('hidden', '')
      shell.classList.remove('wp-active', 'wp-subtle', 'wp-full', 'wp-perfect')
    },
  }
}
