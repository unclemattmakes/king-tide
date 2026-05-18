/**
 * Anti-grav HUD widget — visual half of the anti-grav entry indicator.
 *
 * Hangs off the `#hud-anti-grav` slot reserved in the Step 0 HUD
 * scaffold. Fades in when the player bike enters an anti-grav source
 * (curve sample or volume zone), pulses while engaged, fades out on
 * exit. The ring + glow scale with `AntiGravOverride.weight` so a
 * partial / drifting engagement reads quieter than a fully banked
 * loop.
 *
 * Render-only — never touches sim state. Called from the live game
 * loop's per-frame block with the player's current
 * `AntiGravOverride.weight` (already smoothed by the anti-grav
 * resolver) plus the player setting controlling whether the widget
 * should appear at all.
 *
 * Pairs with the chase-camera's `setAntiGravFollow` — the same
 * weight number drives both. Today the HUD widget is always on; the
 * "off" intensity setting only suppresses the *camera follow*, not
 * the HUD, because the HUD is a gameplay-affordance signal (you're
 * about to invert) and motion-sickness players still need that.
 */

export interface AntiGravHud {
  /** Drive the widget. `weight` ∈ [0,1] from AntiGravOverride; the
   *  widget fades on/off around a threshold and scales its glow by
   *  the same weight. Called every render frame. */
  setWeight(weight: number): void
  /** Hide the widget — e.g. when leaving the race. */
  dispose(): void
}

/** Threshold above which we consider the bike "in anti-grav". Matches
 *  `antiGravSystem`'s own `state.active` threshold so HUD on/off lines
 *  up with the gravity-scale on/off transition. */
const ACTIVE_THRESHOLD = 0.05

export function createAntiGravHud(): AntiGravHud {
  const slot = document.getElementById('hud-anti-grav')
  if (!slot) {
    const noop: AntiGravHud = { setWeight() {}, dispose() {} }
    return noop
  }

  slot.innerHTML = `
    <div class="ag-shell" aria-hidden="true">
      <span class="ag-ring"></span>
      <div class="ag-label">ANTI-GRAV <b>ON</b></div>
    </div>
  `
  const shell = slot.querySelector<HTMLElement>('.ag-shell')
  if (!shell) {
    return { setWeight() {}, dispose() {} }
  }

  let armed = true
  let visible = false

  return {
    setWeight(weight) {
      if (!armed) return
      const w = Math.max(0, Math.min(1, weight))
      const nowActive = w > ACTIVE_THRESHOLD
      shell.style.setProperty('--ag-weight', w.toFixed(3))
      if (nowActive !== visible) {
        visible = nowActive
        if (nowActive) {
          slot.removeAttribute('hidden')
          shell.classList.add('ag-active')
          shell.setAttribute('aria-hidden', 'false')
        } else {
          shell.classList.remove('ag-active')
          shell.setAttribute('aria-hidden', 'true')
          // Delay the `hidden` flip until the fade-out completes so
          // the CSS transition gets a chance to play.
          window.setTimeout(() => {
            if (!visible) slot.setAttribute('hidden', '')
          }, 260)
        }
      }
    },
    dispose() {
      armed = false
      slot.setAttribute('hidden', '')
      shell.classList.remove('ag-active')
      visible = false
    },
  }
}
