/**
 * Tuck meter HUD — a little accuracy gauge that answers two questions the
 * tuck mechanic otherwise leaves implicit: *am I tucking at all*, and
 * *how close am I to the sweet spot*.
 *
 * Tuck has no button — it rides the nose-down lean — and the speed payoff
 * is subtle until you're on a slope with momentum, so without a readout
 * it's hard to tell a missed sweet spot from a mechanic that isn't firing.
 * This widget makes the `tuckFactor()` curve visible: a horizontal bar
 * fills with the raw lean amount, a notch marks the sweet spot, and the
 * colour + status word + live cap-bonus % report how well the lean is
 * paying off (or that you've buried the nose into a scrape).
 *
 * Same shape as the boost-meter HUD: grab the reserved `#hud-tuck` slot,
 * set CSS custom props + a `data-state` attribute each frame, let the CSS
 * do the visuals. Reveals (fades in) only while actively tucking.
 *
 * Render-only. Reads nothing from sim directly — the game loop hands it
 * the already-computed signals each frame.
 */

/** Tuck states, in correction-hint order. Drives `data-state` + the word. */
export type TuckState = 'idle' | 'build' | 'sweet' | 'over' | 'scrape'

export interface TuckHud {
  /**
   * Push the latest tuck readout.
   *   - `leanAmount`  raw nose-down input, 0..1 (`max(-pitch, 0)`)
   *   - `factor`      signed `tuckFactor` (≤0 = over-tuck / scrape)
   *   - `capBonusPct` live top-speed cap delta in percent (can go negative)
   *   - `active`      grounded + leaning enough to be tucking
   *   - `sweetSpot`   live sweet-spot lean (slides toward the feathered end
   *                   on a downslope) — moves the notch + the build/ease-off
   *                   split each frame
   */
  update(
    leanAmount: number,
    factor: number,
    capBonusPct: number,
    active: boolean,
    sweetSpot: number,
  ): void
  /** Hide the widget entirely (settings toggle off / not in a race). */
  hide(): void
  dispose(): void
}

/** factor at/above this reads as "nailing the sweet spot". */
const SWEET_FACTOR = 0.85
/** below this lean we treat the rider as not tucking. */
const LEAN_MIN = 0.05

const STATE_LABEL: Readonly<Record<TuckState, string>> = {
  idle: '',
  build: 'LEAN IN',
  sweet: 'SWEET!',
  over: 'EASE OFF',
  scrape: 'SCRAPING',
}

export function createTuckHud(sweetSpot: number): TuckHud {
  const slot = document.getElementById('hud-tuck')
  if (!slot) {
    return { update() {}, hide() {}, dispose() {} }
  }

  slot.innerHTML = `
    <div class="tk-shell">
      <div class="tk-label">TUCK</div>
      <div class="tk-bar">
        <i class="tk-fill"></i>
        <i class="tk-notch"></i>
      </div>
      <div class="tk-status"><b class="tk-word"></b><span class="tk-pct"></span></div>
    </div>
  `
  // Initial notch position (flat-ground sweet spot). `update()` re-sets
  // `--tk-sweet` each frame so the notch slides with the slope.
  slot.style.setProperty('--tk-sweet', Math.max(0, Math.min(1, sweetSpot)).toFixed(3))
  slot.removeAttribute('hidden')

  const wordEl = slot.querySelector<HTMLElement>('.tk-word')
  const pctEl = slot.querySelector<HTMLElement>('.tk-pct')

  function classify(leanAmount: number, factor: number, active: boolean, sweet: number): TuckState {
    if (!active || leanAmount < LEAN_MIN) return 'idle'
    if (factor < 0) return 'scrape'
    if (factor >= SWEET_FACTOR) return 'sweet'
    // Positive but short of the peak: tell the player which way to correct.
    return leanAmount > sweet ? 'over' : 'build'
  }

  return {
    update(leanAmount, factor, capBonusPct, active, sweetSpot) {
      // Re-reveal in case `hide()` (settings-off / auto-play) parked it;
      // visibility while shown is driven by opacity via `data-active`.
      slot.removeAttribute('hidden')
      const lean = Math.max(0, Math.min(1, leanAmount))
      slot.style.setProperty('--tk-lean', lean.toFixed(3))
      // Notch + the build/ease-off split ride the live slope-aware sweet
      // spot, so the target visibly slides as the slope ahead changes.
      const sweet = Math.max(0, Math.min(1, sweetSpot))
      slot.style.setProperty('--tk-sweet', sweet.toFixed(3))
      const state = classify(lean, factor, active, sweet)
      slot.setAttribute('data-state', state)
      if (state === 'idle') {
        slot.removeAttribute('data-active')
      } else {
        slot.setAttribute('data-active', '1')
        if (wordEl) wordEl.textContent = STATE_LABEL[state]
        if (pctEl) {
          const rounded = Math.round(capBonusPct)
          pctEl.textContent = `${rounded >= 0 ? '+' : ''}${rounded}%`
        }
      }
    },
    hide() {
      slot.setAttribute('hidden', '')
      slot.removeAttribute('data-active')
    },
    dispose() {
      slot.setAttribute('hidden', '')
      slot.removeAttribute('data-active')
      slot.removeAttribute('data-state')
    },
  }
}
