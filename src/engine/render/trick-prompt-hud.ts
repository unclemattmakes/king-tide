/**
 * Trick-ready prompt — telegraphs the "you can trick now" window so
 * the player learns the trickable-vs-not distinction by sight rather
 * than guessing.
 *
 * The render side calls `setReady(true)` every frame the bike is in
 * a credible apex window (recent vy peak ≥ observer threshold +
 * speed + throttle gates), and `setReady(false)` once the window
 * closes. The widget runs a quiet pulse animation while ready, then
 * fades out smoothly when the window passes.
 *
 * Lives in the `#hud-trick-prompt` slot reserved in the Step-0 HUD
 * scaffold. Hidden by default; flips visible only while ready.
 */

import { activeInputSource } from '@/engine/input'
import { formatKeyCode } from '@/engine/input/bindings'
import { playerSettings } from '@/engine/player-settings'

export interface TrickPromptHud {
  /** Set the trick-ready state. Driven each render frame from game-
   *  loop based on the observer's current peak vs threshold. */
  setReady(ready: boolean): void
  /** Hide the widget. The reserved slot stays in the DOM. */
  dispose(): void
}

/** Format the key/button hint based on which input source the player is
 *  currently using. Reads the live binding tables so a rebind shows up
 *  in the prompt without a reload. */
function formatTrickHint(): string {
  const src = activeInputSource()
  if (src === 'gamepad') return 'LB / RB'
  if (src === 'touch') return 'TAP'
  const kb = playerSettings.keyboardBindings
  return `${formatKeyCode(kb.trickLeft.primary)} / ${formatKeyCode(kb.trickRight.primary)}`
}

export function createTrickPromptHud(): TrickPromptHud {
  const slot = document.getElementById('hud-trick-prompt')
  if (!slot) {
    return { setReady() {}, dispose() {} }
  }

  slot.innerHTML = `
    <div class="tp-shell">
      <span class="tp-arrow">▲</span>
      <span class="tp-label">TRICK READY</span>
      <span class="tp-keys">${formatTrickHint()}</span>
    </div>
  `
  const keysEl = slot.querySelector<HTMLElement>('.tp-keys')

  let ready = false

  return {
    setReady(nowReady) {
      // Keep the hint label fresh — if the player swapped from keyboard to
      // controller (or rebound a key) since the last paint, reflect that
      // on the next ready-flash. Allocation-free unless the string changed.
      if (keysEl) {
        const next = formatTrickHint()
        if (keysEl.textContent !== next) keysEl.textContent = next
      }
      if (nowReady === ready) return
      // The wave-pump intensity setting governs the whole trick FX
      // family — when off, suppress the prompt too so the HUD stays
      // quiet for players who explicitly opted out of that channel.
      if (nowReady && playerSettings.wavePumpIntensity === 'off') return
      ready = nowReady
      if (ready) {
        slot.removeAttribute('hidden')
        slot.setAttribute('data-ready', '1')
      } else {
        slot.removeAttribute('data-ready')
        // Let the CSS fade-out finish before removing from layout.
        // ~250 ms matches the `tp-fade-out` keyframe duration.
        window.setTimeout(() => {
          if (!slot.hasAttribute('data-ready')) slot.setAttribute('hidden', '')
        }, 260)
      }
    },
    dispose() {
      ready = false
      slot.removeAttribute('data-ready')
      slot.setAttribute('hidden', '')
    },
  }
}
