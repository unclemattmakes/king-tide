/**
 * Boost-meter HUD widget — Burnout-3-style vertical fill bar.
 *
 * Reads `charge` (0..1) and `active` (bool) each render frame from
 * the game loop's state and writes them into the slot's CSS custom
 * properties + a `data-active` attribute. The CSS handles all the
 * visual heavy lifting (fill height, glow, active-pulse animation)
 * so this module stays trivial — set vars, tick.
 *
 * Lives in the `#hud-boost-meter` slot reserved in the Step-0 HUD
 * scaffold. Hidden by default; flips visible on first non-zero charge.
 *
 * Charge-flash flair: a one-shot `data-charged="1"` attribute toggle
 * fires whenever charge increases between two consecutive frames —
 * the CSS `bm-charge-flash` keyframe brightens the fill for ~250 ms
 * so a fresh trick reads as "yes that paid off" instead of a silent
 * +0.33.
 */

export interface BoostMeterHud {
  /** Push the latest meter state. Cheap — bails when the slot is
   *  missing. */
  update(charge: number, active: boolean): void
  /** Hide the widget. The reserved slot stays in the DOM. */
  dispose(): void
}

/** ms the charge-flash class lingers — matches the CSS animation. */
const CHARGE_FLASH_MS = 250

export function createBoostMeterHud(): BoostMeterHud {
  const slot = document.getElementById('hud-boost-meter')
  if (!slot) {
    return { update() {}, dispose() {} }
  }

  slot.innerHTML = `
    <div class="bm-shell">
      <div class="bm-fill"></div>
      <div class="bm-tick"></div>
    </div>
  `

  let prevCharge = 0
  let chargeFlashTimer: number | null = null
  let visible = false

  return {
    update(charge, active) {
      const clamped = Math.max(0, Math.min(1, charge))
      // First non-zero charge of the race → unhide. Once shown, keep
      // it visible for the rest of the race so the player always has
      // an at-a-glance read on their boost state.
      if (clamped > 0 && !visible) {
        slot.removeAttribute('hidden')
        visible = true
      }
      slot.style.setProperty('--bm-charge', clamped.toFixed(3))
      slot.style.setProperty('--bm-active', active ? '1' : '0')
      if (active) {
        slot.setAttribute('data-active', '1')
      } else {
        slot.removeAttribute('data-active')
      }
      // Charge-flash on increase. Re-trigger the CSS animation by
      // stripping then re-adding the attribute on the next frame.
      if (clamped > prevCharge + 0.001) {
        slot.removeAttribute('data-charged')
        void slot.offsetWidth
        slot.setAttribute('data-charged', '1')
        if (chargeFlashTimer !== null) window.clearTimeout(chargeFlashTimer)
        chargeFlashTimer = window.setTimeout(() => {
          slot.removeAttribute('data-charged')
          chargeFlashTimer = null
        }, CHARGE_FLASH_MS)
      }
      prevCharge = clamped
    },
    dispose() {
      if (chargeFlashTimer !== null) {
        window.clearTimeout(chargeFlashTimer)
        chargeFlashTimer = null
      }
      slot.setAttribute('hidden', '')
      slot.removeAttribute('data-active')
      slot.removeAttribute('data-charged')
    },
  }
}
