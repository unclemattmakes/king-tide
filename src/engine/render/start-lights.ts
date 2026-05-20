/**
 * F1-style start-lights overlay. Replaces the 3/2/1 banner during the
 * race countdown with a row of five circular lamps that progressively
 * light red, then flash green on GO!
 *
 * Driven externally by `setCountdown(n)` (called from the race-hud's
 * `onCountdownTick` callback) and `setVisible(true/false)`. The overlay
 * owns its DOM node + a tiny state machine — no per-frame rAF tick is
 * required, all transitions are CSS class swaps.
 *
 * Phases:
 *
 *   - `setCountdown(3)` → lamps 1+2 light red.
 *   - `setCountdown(2)` → lamps 1..4 light red (3rd + 4th come on).
 *   - `setCountdown(1)` → all 5 lamps light red (final lamp on, hold).
 *   - `setCountdown(0)` → all lamps go GREEN, then fade out after ~0.7s.
 *
 * The 3/4/5 grouping matches the existing 3-2-1-GO cadence without
 * pretending to be a perfect F1 sequence (real F1 lights up pairs at a
 * fixed interval then goes out at a random delay — we don't have a
 * random delay because the existing race system pre-commits the GO
 * moment). Pair grouping keeps the visual "filling up" read.
 */

export interface StartLights {
  /** Show the lights row. CSS handles the fade-in. */
  show(): void
  /** Hide + reset the lamps. Called when the race-hud's countdown
   *  finishes or the lights are skipped. */
  hide(): void
  /** Drive the lamp count from the race-hud's tick callback. */
  setCountdown(n: 3 | 2 | 1 | 0): void
  /** Reset all lamps to dark without hiding the row. */
  reset(): void
  /** Test-only: returns the active lamp count (0..5) and whether the
   *  GO flash is on. */
  state(): { lit: number; go: boolean; visible: boolean }
}

export interface StartLightsOpts {
  /** Number of lamps. Defaults to 5. */
  lampCount?: number
  /** Optional id override for the root element — tests inject their own
   *  DOM node so they can assert against it. */
  rootId?: string
}

const DEFAULT_LAMP_COUNT = 5
const DEFAULT_ROOT_ID = 'start-lights'

/** Step counts per countdown tick. Indexed by tick (3..1). At 'GO' all
 *  lamps go green; before tick 3 fires, everything is dark. */
const LAMPS_LIT_AT_TICK: Readonly<Record<3 | 2 | 1, number>> = Object.freeze({
  3: 2,
  2: 4,
  1: 5,
})

export function createStartLights(opts: StartLightsOpts = {}): StartLights {
  const lampCount = opts.lampCount ?? DEFAULT_LAMP_COUNT
  const rootId = opts.rootId ?? DEFAULT_ROOT_ID

  const root = ensureRoot(rootId, lampCount)
  const lamps: HTMLElement[] = Array.from(root.querySelectorAll<HTMLElement>('.sl-lamp'))

  let lit = 0
  let go = false
  let visible = false
  let goTimeout: ReturnType<typeof setTimeout> | null = null

  function applyLitClasses(): void {
    for (let i = 0; i < lamps.length; i++) {
      const lamp = lamps[i]
      if (!lamp) continue
      lamp.classList.toggle('sl-lit', !go && i < lit)
      lamp.classList.toggle('sl-go', go)
    }
  }

  function show(): void {
    if (visible) return
    visible = true
    root.classList.add('sl-active')
  }

  function hide(): void {
    if (goTimeout !== null) {
      clearTimeout(goTimeout)
      goTimeout = null
    }
    visible = false
    go = false
    lit = 0
    root.classList.remove('sl-active', 'sl-finished')
    applyLitClasses()
  }

  function reset(): void {
    if (goTimeout !== null) {
      clearTimeout(goTimeout)
      goTimeout = null
    }
    go = false
    lit = 0
    root.classList.remove('sl-finished')
    applyLitClasses()
  }

  function setCountdown(n: 3 | 2 | 1 | 0): void {
    if (!visible) show()
    if (n === 0) {
      // Lights out / go-flash. All lamps go green; CSS fades + scales
      // them. After ~700 ms the row hides itself so the gameplay HUD
      // isn't crowded once racing starts.
      go = true
      lit = lampCount
      root.classList.add('sl-finished')
      applyLitClasses()
      if (goTimeout !== null) clearTimeout(goTimeout)
      goTimeout = setTimeout(() => {
        hide()
        goTimeout = null
      }, 850)
      return
    }
    lit = LAMPS_LIT_AT_TICK[n] ?? 0
    go = false
    root.classList.remove('sl-finished')
    applyLitClasses()
  }

  // Start hidden — `show()` runs when the countdown actually arms.
  hide()

  return { show, hide, setCountdown, reset, state: () => ({ lit, go, visible }) }
}

function ensureRoot(rootId: string, lampCount: number): HTMLElement {
  let root = document.getElementById(rootId)
  if (root) {
    // Re-init on every race — wipe + rebuild lamps so the lampCount
    // option can change between sessions.
    while (root.firstChild) root.removeChild(root.firstChild)
  } else {
    root = document.createElement('div')
    root.id = rootId
    document.body.appendChild(root)
  }
  for (let i = 0; i < lampCount; i++) {
    const lamp = document.createElement('div')
    lamp.className = 'sl-lamp'
    lamp.dataset.index = String(i)
    const inner = document.createElement('div')
    inner.className = 'sl-lamp-inner'
    lamp.appendChild(inner)
    root.appendChild(lamp)
  }
  return root
}
