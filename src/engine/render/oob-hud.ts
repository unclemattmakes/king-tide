import type { OutOfBoundsData } from '@/game/components/out-of-bounds'

/**
 * Out-of-bounds warning popup — the Battlefield-style "RETURN TO COURSE"
 * banner + countdown that shows while the player is past the soft wall.
 *
 * Render-only and informational: `pointer-events:none`, no focusable controls,
 * so it carries no input-navigability obligation (nothing to tab to — the
 * hand-back is "touch any control", handled in the loop). Reads the
 * `OutOfBounds` component each frame; the loop owns the autopilot handoff and
 * the lethal cutscene. CSS lives in index.html (`#oob-warning`).
 */
export type OobHud = {
  /**
   * @param oob the local player's OutOfBounds state (undefined before the
   *   first tick has run).
   * @param autopilotActive whether the loop currently has autopilot driving
   *   the bike back — drives the hint line.
   */
  update(oob: OutOfBoundsData | undefined, autopilotActive: boolean): void
  dispose(): void
}

export function createOobHud(): OobHud {
  const root = document.createElement('div')
  root.id = 'oob-warning'
  root.setAttribute('aria-hidden', 'true')
  root.innerHTML =
    '<div class="oob-kicker"></div><div class="oob-count"></div><div class="oob-hint"></div>'
  document.body.appendChild(root)
  const kickerEl = root.querySelector('.oob-kicker') as HTMLElement
  const countEl = root.querySelector('.oob-count') as HTMLElement
  const hintEl = root.querySelector('.oob-hint') as HTMLElement

  let shown = false
  function setShown(on: boolean): void {
    if (on === shown) return
    shown = on
    root.classList.toggle('show', on)
    root.setAttribute('aria-hidden', on ? 'false' : 'true')
  }

  return {
    update(oob, autopilotActive) {
      const phase = oob?.phase
      if (!oob || (phase !== 'warn' && phase !== 'brace')) {
        setShown(false)
        return
      }
      root.dataset.phase = phase
      if (phase === 'brace') {
        kickerEl.textContent = 'BRACE'
        countEl.textContent = '!'
        hintEl.textContent = 'INCOMING'
      } else {
        kickerEl.textContent = 'OUT OF BOUNDS'
        countEl.textContent = String(Math.max(0, Math.ceil(oob.graceRemaining)))
        hintEl.textContent = autopilotActive
          ? 'AUTOPILOT · TAKE THE CONTROLS TO RESUME'
          : 'RETURN TO COURSE'
      }
      setShown(true)
    },
    dispose() {
      setShown(false)
      root.remove()
    },
  }
}
