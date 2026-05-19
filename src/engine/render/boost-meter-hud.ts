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
  /** Fire the "no-charge" rejection flash. Called by the render loop
   *  when the player presses boost but the meter is below threshold,
   *  so the player gets a clear "I tried, it didn't engage" cue. */
  flashRejected(): void
  /** Hide the widget. The reserved slot stays in the DOM. */
  dispose(): void
}

/** ms the charge-flash class lingers — matches the CSS animation. */
const CHARGE_FLASH_MS = 250
/** ms the rejection flash lingers — matches the CSS animation. */
const REJECT_FLASH_MS = 300

export function createBoostMeterHud(): BoostMeterHud {
  const slot = document.getElementById('hud-boost-meter')
  if (!slot) {
    return { update() {}, flashRejected() {}, dispose() {} }
  }

  slot.innerHTML = `
    <div class="bm-shell">
      <div class="bm-fill"></div>
      <div class="bm-tick"></div>
    </div>
  `

  // Reveal the meter immediately at race start so the player can see
  // their boost state from the first frame — knowing the meter is
  // empty is the only way they learn that tricks fill it.
  slot.removeAttribute('hidden')

  let prevCharge = 0
  let chargeFlashTimer: number | null = null
  let rejectFlashTimer: number | null = null

  return {
    update(charge, active) {
      const clamped = Math.max(0, Math.min(1, charge))
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
    flashRejected() {
      slot.removeAttribute('data-rejected')
      void slot.offsetWidth
      slot.setAttribute('data-rejected', '1')
      if (rejectFlashTimer !== null) window.clearTimeout(rejectFlashTimer)
      rejectFlashTimer = window.setTimeout(() => {
        slot.removeAttribute('data-rejected')
        rejectFlashTimer = null
      }, REJECT_FLASH_MS)
    },
    dispose() {
      if (chargeFlashTimer !== null) {
        window.clearTimeout(chargeFlashTimer)
        chargeFlashTimer = null
      }
      if (rejectFlashTimer !== null) {
        window.clearTimeout(rejectFlashTimer)
        rejectFlashTimer = null
      }
      slot.setAttribute('hidden', '')
      slot.removeAttribute('data-active')
      slot.removeAttribute('data-charged')
      slot.removeAttribute('data-rejected')
    },
  }
}
