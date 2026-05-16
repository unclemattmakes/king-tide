/**
 * Menu / UI gamepad navigation.
 *
 * Polls navigator.getGamepads() each animation frame and translates
 * controller input into DOM focus changes + clicks on the active screen:
 *
 *   D-pad / left stick   → move focus to the neighbouring focusable
 *                          (spatial — buttons in the direction of travel)
 *   A button (0)         → click the focused element
 *   B button (1)         → onBack callback (typically Esc-equivalent)
 *   Start (9)            → onStart callback (typically pause toggle)
 *
 * Distinct from `gamepadIntent()` which maps the pad to race controls.
 * This module is only active while a menu is showing.
 */

const NAV_REPEAT_INITIAL_MS = 360
const NAV_REPEAT_MS = 130
const AXIS_THRESHOLD = 0.55

type Dir = 'up' | 'down' | 'left' | 'right'

export type MenuGamepadOpts = {
  /** The element to search for focusable children. Re-evaluated on
   *  every poll so callers can swap screens without re-installing. */
  container: () => HTMLElement | null
  /** B button — typically navigate back or close the menu. */
  onBack?: () => void
  /** Start button — typically toggle pause/menu. */
  onStart?: () => void
  /** When provided and returns false, polling continues but inputs are
   *  ignored. Useful when sharing a poller across open/closed states. */
  isActive?: () => boolean
}

export type MenuGamepad = {
  /** Focus the most appropriate element in the current container.
   *  Prefers `.selected`, then `.primary`, then the first focusable.
   *  Deferred to the next frame so newly-mounted DOM has time to lay
   *  out before we measure it. */
  focusFirst(): void
  /** Stop polling. */
  dispose(): void
}

function isVisible(el: HTMLElement): boolean {
  // offsetParent is null for display:none / inside a display:none ancestor.
  // For the rare position:fixed case we fall back to a layout check.
  if (el.offsetParent !== null) return true
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function isDisabled(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled')) return true
  if ((el as HTMLInputElement).disabled) return true
  return false
}

export function installMenuGamepad(opts: MenuGamepadOpts): MenuGamepad {
  let raf = 0
  let disposed = false
  let primed = false
  const prevEdges = { accept: false, back: false, start: false }
  const heldSince = new Map<Dir, number>()
  const heldUntil = new Map<Dir, number>()

  function focusables(): HTMLElement[] {
    const root = opts.container()
    if (!root) return []
    const sel = 'button, [tabindex], input, a'
    const els = Array.from(root.querySelectorAll<HTMLElement>(sel))
    return els.filter((el) => !isDisabled(el) && isVisible(el))
  }

  function navigate(dir: Dir): void {
    const elements = focusables()
    if (elements.length === 0) return
    const root = opts.container()
    const current = document.activeElement as HTMLElement | null
    if (!current || !root?.contains(current) || !elements.includes(current)) {
      elements[0]?.focus({ preventScroll: true })
      return
    }
    const curRect = current.getBoundingClientRect()
    const cx = curRect.left + curRect.width / 2
    const cy = curRect.top + curRect.height / 2

    let best: HTMLElement | null = null
    let bestScore = Infinity
    for (const el of elements) {
      if (el === current) continue
      const r = el.getBoundingClientRect()
      const ex = r.left + r.width / 2
      const ey = r.top + r.height / 2
      const dx = ex - cx
      const dy = ey - cy
      let primary: number
      let cross: number
      switch (dir) {
        case 'up':
          if (dy >= -2) continue
          primary = -dy
          cross = Math.abs(dx)
          break
        case 'down':
          if (dy <= 2) continue
          primary = dy
          cross = Math.abs(dx)
          break
        case 'left':
          if (dx >= -2) continue
          primary = -dx
          cross = Math.abs(dy)
          break
        case 'right':
          if (dx <= 2) continue
          primary = dx
          cross = Math.abs(dy)
          break
      }
      // Weight cross-axis distance heavily so up/down don't drift into
      // siblings on the same row, and vice versa.
      const score = primary + cross * 2.5
      if (score < bestScore) {
        bestScore = score
        best = el
      }
    }
    if (best) best.focus({ preventScroll: true })
  }

  function handleHeld(dir: Dir, held: boolean): void {
    const now = performance.now()
    if (!held) {
      heldSince.delete(dir)
      heldUntil.delete(dir)
      return
    }
    if (!heldSince.has(dir)) {
      heldSince.set(dir, now)
      heldUntil.set(dir, now + NAV_REPEAT_INITIAL_MS)
      navigate(dir)
      return
    }
    const next = heldUntil.get(dir) ?? now
    if (now >= next) {
      heldUntil.set(dir, now + NAV_REPEAT_MS)
      navigate(dir)
    }
  }

  function tick(): void {
    if (disposed) return
    raf = requestAnimationFrame(tick)
    if (opts.isActive && !opts.isActive()) {
      // Reset so re-activation doesn't double-fire on a stuck button.
      primed = false
      return
    }
    const pad = navigator.getGamepads?.()?.[0]
    if (!pad) return

    const lx = pad.axes[0] ?? 0
    const ly = pad.axes[1] ?? 0
    const up = (pad.buttons[12]?.pressed ?? false) || ly < -AXIS_THRESHOLD
    const down = (pad.buttons[13]?.pressed ?? false) || ly > AXIS_THRESHOLD
    const left = (pad.buttons[14]?.pressed ?? false) || lx < -AXIS_THRESHOLD
    const right = (pad.buttons[15]?.pressed ?? false) || lx > AXIS_THRESHOLD
    const accept = pad.buttons[0]?.pressed ?? false
    const back = pad.buttons[1]?.pressed ?? false
    const start = pad.buttons[9]?.pressed ?? false

    if (!primed) {
      // First poll after install/reactivate — record current state but
      // don't fire so a held button (e.g. throttle A) doesn't trigger
      // accept the moment the menu appears.
      prevEdges.accept = accept
      prevEdges.back = back
      prevEdges.start = start
      // Treat held directions as "already consumed" — user must release
      // and re-press to navigate.
      const now = performance.now()
      const consume = (dir: Dir, held: boolean) => {
        if (!held) return
        heldSince.set(dir, now)
        heldUntil.set(dir, Number.POSITIVE_INFINITY)
      }
      consume('up', up)
      consume('down', down)
      consume('left', left)
      consume('right', right)
      primed = true
      return
    }

    handleHeld('up', up)
    handleHeld('down', down)
    handleHeld('left', left)
    handleHeld('right', right)

    if (accept && !prevEdges.accept) {
      const active = document.activeElement as HTMLElement | null
      const root = opts.container()
      if (active && root?.contains(active)) {
        active.click()
      } else {
        focusables()[0]?.focus({ preventScroll: true })
      }
    }
    if (back && !prevEdges.back) opts.onBack?.()
    if (start && !prevEdges.start) opts.onStart?.()
    prevEdges.accept = accept
    prevEdges.back = back
    prevEdges.start = start
  }
  raf = requestAnimationFrame(tick)

  return {
    focusFirst(): void {
      requestAnimationFrame(() => {
        const els = focusables()
        const selected = els.find((e) => e.classList.contains('selected'))
        const primary = els.find((e) => e.classList.contains('primary'))
        ;(selected ?? primary ?? els[0])?.focus({ preventScroll: true })
      })
    },
    dispose(): void {
      disposed = true
      cancelAnimationFrame(raf)
    },
  }
}
