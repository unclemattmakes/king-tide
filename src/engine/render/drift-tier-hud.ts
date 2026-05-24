/**
 * Drift-tier HUD badge — small circular tier indicator that pops in
 * while the player is in active drift, color-shifting through MT →
 * SMT → UMT as the charge climbs.
 *
 * Reads `DriftState.driftDir` + `highestTier` each render frame from
 * the game loop and writes them into the slot's `data-active`,
 * `data-tier`, and innerHTML. The CSS handles all the visual heavy
 * lifting (color tokens, glow, pop-in transition, tier-up flash) so
 * this module stays trivial — set attributes, tick.
 *
 * Lives in the `#hud-drift` slot reserved in the HUD scaffold and
 * positioned next to the boost meter so the player's eye doesn't
 * have to jump across the screen to read tier progress.
 *
 * Gated by `playerSettings.driftIntensity`:
 *   - `full` / `subtle` → badge renders as usual
 *   - `off`             → badge stays hidden no matter the sim state
 *
 * The badge is mostly redundant with the colored sparks at full
 * intensity (both convey the same info), but it gives a stable
 * always-visible readout that doesn't require glancing down at the
 * bike — useful on tight tracks where eyes stay on the racing line.
 */

import { playerSettings } from '@/engine/player-settings'

export interface DriftTierHud {
  /** Push the latest drift state to the HUD. Cheap — bails early
   *  when the slot is missing or the drift system is disabled. */
  update(driftDir: number, highestTier: number): void
  /** Hide the widget. The reserved slot stays in the DOM. */
  dispose(): void
}

/** ms the tier-up flash class lingers — matches the CSS animation. */
const TIERUP_FLASH_MS = 280

const TIER_LABEL: Readonly<Record<number, string>> = Object.freeze({
  0: '·',
  1: 'MT',
  2: 'SMT',
  3: 'UMT',
})

export function createDriftTierHud(): DriftTierHud {
  const slot = document.getElementById('hud-drift')
  if (!slot) {
    return { update() {}, dispose() {} }
  }

  slot.innerHTML = `
    <div class="df-ring">
      <span class="df-label">·</span>
    </div>
  `

  // Reveal the slot up front so the CSS can drive opacity transitions
  // from the `data-active` toggle below — leaving `hidden` on the slot
  // suppresses the pop-in animation entirely.
  slot.removeAttribute('hidden')

  const label = slot.querySelector('.df-label') as HTMLElement | null
  let prevTier = 0
  let tierupTimer: number | null = null

  return {
    update(driftDir, highestTier) {
      const intensityOff = playerSettings.driftIntensity === 'off'
      const active = driftDir !== 0 && !intensityOff
      const tier = Math.max(0, Math.min(3, Math.floor(highestTier)))

      if (active) {
        slot.setAttribute('data-active', '1')
      } else {
        slot.removeAttribute('data-active')
      }
      slot.setAttribute('data-tier', String(tier))
      if (label) label.textContent = TIER_LABEL[tier] ?? '·'

      // Tier-up flash — fires on the transition from a lower tier to
      // a higher one. Re-trigger the CSS animation by stripping then
      // re-adding the attribute on the next frame (same trick the
      // boost-meter charge-flash uses).
      if (active && tier > prevTier) {
        slot.removeAttribute('data-tierup')
        void slot.offsetWidth
        slot.setAttribute('data-tierup', '1')
        if (tierupTimer !== null) window.clearTimeout(tierupTimer)
        tierupTimer = window.setTimeout(() => {
          slot.removeAttribute('data-tierup')
          tierupTimer = null
        }, TIERUP_FLASH_MS)
      }

      // Reset prevTier when the drift ends so the next drift's first
      // tier-up still fires the flash (otherwise a drift that hits
      // SMT and then a new drift that climbs to SMT would silently
      // skip the upgrade animation).
      prevTier = active ? tier : 0
    },
    dispose() {
      if (tierupTimer !== null) {
        window.clearTimeout(tierupTimer)
        tierupTimer = null
      }
      slot.setAttribute('hidden', '')
      slot.removeAttribute('data-active')
      slot.removeAttribute('data-tier')
      slot.removeAttribute('data-tierup')
    },
  }
}
