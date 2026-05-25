/**
 * Menu / UI gamepad navigation.
 *
 * Polls navigator.getGamepads() each animation frame and translates
 * controller input into DOM focus changes + clicks on the active screen:
 *
 *   D-pad / left stick   → move focus to the neighbouring focusable
 *                          (spatial — buttons in the direction of travel)
 *   LB / L1   (4)        → page-scroll up + jump focus to first visible card
 *   RB / R1   (5)        → page-scroll down + jump focus to last visible card
 *   A button  (0)        → click the focused element
 *   B button  (1)        → onBack callback (typically Esc-equivalent)
 *   Start     (9)        → onStart callback (typically pause toggle)
 *
 * Distinct from `gamepadIntent()` which maps the pad to race controls.
 * This module is only active while a menu is showing.
 */

const NAV_REPEAT_INITIAL_MS = 360
const NAV_REPEAT_MS = 130
const PAGE_REPEAT_INITIAL_MS = 420
const PAGE_REPEAT_MS = 200
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

/**
 * True if any of the named overlays (by element id) is currently shown
 * (carries the `.show` class). A base-layer poller passes this through
 * `isActive` to park itself while a higher overlay owns input: two live
 * pollers reading the same gamepad tug-of-war over focus and swallow the
 * A press, so the top overlay becomes un-navigable (regression-pinned in
 * tests/unit/menu-gamepad.test.ts). This is the controller-side mirror of
 * the `body.menu-active` / `paused-for-menu` CSS cascades that already
 * keep stacked surfaces from fighting visually.
 */
export function isAnyOverlayShown(...ids: string[]): boolean {
  return ids.some((id) => document.getElementById(id)?.classList.contains('show') ?? false)
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

/**
 * Class applied to the element that currently holds menu focus so CSS
 * can paint a strong, gamepad-friendly indicator without relying on the
 * browser's `:focus-visible` heuristic (which doesn't reliably fire for
 * scripted `.focus()` calls driven from gamepad polling).
 */
const FOCUS_CLASS = 'is-menu-focus'

/** Walk up the DOM until we hit the closest ancestor that actually
 *  scrolls (overflow auto/scroll + content taller than the viewport).
 *  Used by the page-scroll shoulder buttons and by `scrollFocusIntoView`
 *  to find the right element to nudge — typically `.bc-stage` for the
 *  main menu and `.bc-lb-tracks` for the leaderboard track column. */
function scrollableAncestor(el: HTMLElement | null): HTMLElement | null {
  let cur = el?.parentElement ?? null
  while (cur) {
    const cs = getComputedStyle(cur)
    const overflowY = cs.overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight) {
      return cur
    }
    cur = cur.parentElement
  }
  return null
}

/** Pull the focused element fully into view in its nearest scroll
 *  container, honouring CSS `scroll-padding-*` set on the container.
 *  `block: 'nearest'` is the friendly behaviour — it only scrolls the
 *  minimum needed, so cards that are already visible don't jump. */
function scrollFocusIntoView(el: HTMLElement): void {
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
}

export function installMenuGamepad(opts: MenuGamepadOpts): MenuGamepad {
  let raf = 0
  let disposed = false
  let primed = false
  const prevEdges = { accept: false, back: false, start: false }
  const heldSince = new Map<Dir, number>()
  const heldUntil = new Map<Dir, number>()
  type Page = 'pageUp' | 'pageDown'
  const pageHeldSince = new Map<Page, number>()
  const pageHeldUntil = new Map<Page, number>()

  function focusables(): HTMLElement[] {
    const root = opts.container()
    if (!root) return []
    const sel = 'button, [tabindex], input, a'
    const els = Array.from(root.querySelectorAll<HTMLElement>(sel))
    return els.filter((el) => !isDisabled(el) && isVisible(el))
  }

  // Mirror DOM focus into a marker class so CSS can paint a strong
  // focus indicator regardless of how focus was set (keyboard tab,
  // mouse click, or programmatic .focus() from gamepad nav).
  function onFocusIn(e: FocusEvent): void {
    const root = opts.container()
    const target = e.target as HTMLElement | null
    if (!root || !target || !root.contains(target)) return
    const prev = root.querySelectorAll(`.${FOCUS_CLASS}`)
    prev.forEach((el) => {
      if (el !== target) el.classList.remove(FOCUS_CLASS)
    })
    target.classList.add(FOCUS_CLASS)
  }
  function onFocusOut(e: FocusEvent): void {
    const target = e.target as HTMLElement | null
    target?.classList.remove(FOCUS_CLASS)
  }
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', onFocusOut)

  function navigate(dir: Dir): void {
    const elements = focusables()
    if (elements.length === 0) return
    const root = opts.container()
    const current = document.activeElement as HTMLElement | null
    if (!current || !root?.contains(current) || !elements.includes(current)) {
      const first = elements[0]
      if (first) {
        first.focus({ preventScroll: true })
        scrollFocusIntoView(first)
      }
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
    if (best) {
      best.focus({ preventScroll: true })
      scrollFocusIntoView(best)
    }
  }

  /** LB / RB page-scroll. Pages the focused element's scroll container
   *  by ~80% of its visible height, then snaps focus to the topmost (LB)
   *  or bottommost (RB) focusable that's now on-screen so the user has
   *  an anchor to keep d-pad navigating from. Falls back to a regular
   *  up/down nav when there's nothing scrollable in scope. */
  function pageScroll(direction: 'up' | 'down'): void {
    const els = focusables()
    if (els.length === 0) return
    const root = opts.container()
    const current = document.activeElement as HTMLElement | null
    const anchor = current && root?.contains(current) ? current : els[0] ?? null
    if (!anchor) return
    const scroller = scrollableAncestor(anchor)
    if (!scroller) {
      navigate(direction)
      return
    }
    const step = Math.max(120, scroller.clientHeight * 0.8)
    scroller.scrollBy({ top: direction === 'down' ? step : -step, behavior: 'smooth' })
    // After scrolling, hand focus to a focusable that's actually visible
    // inside the scroller now — measured against its post-scroll rect so
    // the player's d-pad picks up at the visible edge.
    const scrollerRect = scroller.getBoundingClientRect()
    let pick: HTMLElement | null = null
    let pickScore = Infinity
    for (const el of els) {
      const r = el.getBoundingClientRect()
      if (r.bottom <= scrollerRect.top || r.top >= scrollerRect.bottom) continue
      const dy =
        direction === 'down' ? scrollerRect.bottom - r.bottom : r.top - scrollerRect.top
      const score = Math.abs(dy)
      if (score < pickScore) {
        pickScore = score
        pick = el
      }
    }
    if (pick && pick !== current) {
      pick.focus({ preventScroll: true })
    }
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

  function handlePageHeld(page: Page, held: boolean): void {
    const now = performance.now()
    if (!held) {
      pageHeldSince.delete(page)
      pageHeldUntil.delete(page)
      return
    }
    if (!pageHeldSince.has(page)) {
      pageHeldSince.set(page, now)
      pageHeldUntil.set(page, now + PAGE_REPEAT_INITIAL_MS)
      pageScroll(page === 'pageUp' ? 'up' : 'down')
      return
    }
    const next = pageHeldUntil.get(page) ?? now
    if (now >= next) {
      pageHeldUntil.set(page, now + PAGE_REPEAT_MS)
      pageScroll(page === 'pageUp' ? 'up' : 'down')
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
    const pageUp = pad.buttons[4]?.pressed ?? false
    const pageDown = pad.buttons[5]?.pressed ?? false
    const start = pad.buttons[9]?.pressed ?? false

    if (!primed) {
      // First poll after install/reactivate — record current state but
      // don't fire so a held button (e.g. throttle A) doesn't trigger
      // accept the moment the menu appears.
      prevEdges.accept = accept
      prevEdges.back = back
      prevEdges.start = start
      // Treat held directions / shoulders as "already consumed" — user
      // must release and re-press to navigate.
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
      const consumePage = (page: Page, held: boolean) => {
        if (!held) return
        pageHeldSince.set(page, now)
        pageHeldUntil.set(page, Number.POSITIVE_INFINITY)
      }
      consumePage('pageUp', pageUp)
      consumePage('pageDown', pageDown)
      primed = true
      return
    }

    handleHeld('up', up)
    handleHeld('down', down)
    handleHeld('left', left)
    handleHeld('right', right)
    handlePageHeld('pageUp', pageUp)
    handlePageHeld('pageDown', pageDown)

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
        const target = selected ?? primary ?? els[0]
        if (!target) return
        target.focus({ preventScroll: true })
        // Reset the scroll position on screen entry — if a previous
        // visit left the list paged down, the player should land at the
        // top of the new screen, not wherever the scroll happened to be.
        const scroller = scrollableAncestor(target)
        if (scroller) scroller.scrollTop = 0
        scrollFocusIntoView(target)
      })
    },
    dispose(): void {
      disposed = true
      cancelAnimationFrame(raf)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      opts
        .container()
        ?.querySelectorAll(`.${FOCUS_CLASS}`)
        .forEach((el) => {
          el.classList.remove(FOCUS_CLASS)
        })
    },
  }
}
