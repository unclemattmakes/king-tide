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

import { playerSettings } from '@/engine/player-settings'

export interface TrickPromptHud {
  /** Set the trick-ready state. Driven each render frame from game-
   *  loop based on the observer's current peak vs threshold. */
  setReady(ready: boolean): void
  /** Hide the widget. The reserved slot stays in the DOM. */
  dispose(): void
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
      <span class="tp-keys">Z / C</span>
    </div>
  `

  let ready = false

  return {
    setReady(nowReady) {
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
