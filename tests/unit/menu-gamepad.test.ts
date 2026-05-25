// @vitest-environment jsdom
/**
 * Menu / UI gamepad navigation harness.
 *
 * `installMenuGamepad` (src/engine/input/menu-gamepad.ts) is the only
 * thing standing between a controller and every menu/overlay button in
 * the game, yet it had no coverage. This pins the behaviour the post-race
 * screens (and the pause menu, settings overlay, main menu) depend on:
 *
 *   - d-pad / stick moves DOM focus to the spatial neighbour,
 *   - A clicks the focused element, B fires onBack,
 *   - the `isActive` gate parks a shared poller,
 *   - a `container()` that returns whichever overlay is on top lets ONE
 *     poller drive a stack (the finish → cup-results pattern).
 *
 * jsdom does no layout, so we stub `getBoundingClientRect` per element
 * (drives both `isVisible` and the spatial scoring) and run a manual
 * rAF stepper so frames are deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMenuGamepad, isAnyOverlayShown } from '@/engine/input/menu-gamepad'

// ---- manual requestAnimationFrame stepper -------------------------------
// Browser semantics: callbacks scheduled while a frame is being processed
// run on the NEXT frame, in registration order. The poller reschedules
// itself at the top of each tick, so the loop advances one tick per step.
let rafQueue = new Map<number, FrameRequestCallback>()
let rafNextId = 1
function installRafStepper(): void {
  rafQueue = new Map()
  rafNextId = 1
  globalThis.requestAnimationFrame = ((fn: FrameRequestCallback): number => {
    const id = rafNextId++
    rafQueue.set(id, fn)
    return id
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number): void => {
    rafQueue.delete(id)
  }) as typeof cancelAnimationFrame
}
function stepFrames(n = 1): void {
  for (let i = 0; i < n; i++) {
    const current = [...rafQueue.values()]
    rafQueue = new Map()
    for (const fn of current) fn(performance.now())
  }
}

// ---- fake gamepad -------------------------------------------------------
type Pad = { axes: number[]; buttons: { pressed: boolean; value: number }[] }
let pad: Pad
function installPad(): void {
  pad = {
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  }
  ;(navigator as unknown as { getGamepads: () => Pad[] }).getGamepads = () => [pad]
}
const BTN = { A: 0, B: 1, LB: 4, RB: 5, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 }
function hold(idx: number): void {
  pad.buttons[idx] = { pressed: true, value: 1 }
}
function releaseAll(): void {
  pad.buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }))
  pad.axes = [0, 0, 0, 0]
}
/** Tap a button: one frame held (fires on the rising edge), one released. */
function tap(idx: number): void {
  releaseAll()
  hold(idx)
  stepFrames(1)
  releaseAll()
  stepFrames(1)
}

// ---- DOM helpers --------------------------------------------------------
const rects = new WeakMap<Element, DOMRect>()
function setRect(el: Element, x: number, y: number, w = 80, h = 30): void {
  rects.set(el, {
    x,
    y,
    width: w,
    height: h,
    top: y,
    left: x,
    right: x + w,
    bottom: y + h,
    toJSON: () => ({}),
  } as DOMRect)
}
function makeButton(label: string, x: number, y: number): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  setRect(b, x, y)
  return b
}

let clickLog: string[] = []
function trackClicks(...btns: HTMLElement[]): void {
  for (const b of btns) b.addEventListener('click', () => clickLog.push(b.textContent ?? ''))
}

beforeEach(() => {
  installRafStepper()
  installPad()
  clickLog = []
  document.body.innerHTML = ''
  // jsdom doesn't implement these; the poller calls them on focus moves.
  Element.prototype.scrollIntoView = vi.fn()
  // Every element reports a visible box unless we say otherwise — keeps
  // `isVisible` (offsetParent is null under jsdom) happy via its rect path.
  // biome-ignore lint/suspicious/noExplicitAny: test shim
  ;(Element.prototype as any).getBoundingClientRect = function (this: Element): DOMRect {
    return (
      rects.get(this) ??
      ({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        toJSON: () => ({}),
      } as DOMRect)
    )
  }
})

afterEach(() => {
  rafQueue.clear()
})

/** Build a vertical stack of N buttons inside a fresh container. */
function buildStack(id: string, labels: string[], xOffset = 0): HTMLElement {
  const container = document.createElement('div')
  container.id = id
  labels.forEach((label, i) => {
    const b = makeButton(label, xOffset, i * 100)
    container.appendChild(b)
  })
  document.body.appendChild(container)
  return container
}

describe('installMenuGamepad — single poller', () => {
  it('d-pad down moves focus to the spatial neighbour below', () => {
    const c = buildStack('finish', ['NEXT', 'RETRY', 'EXIT'])
    const nav = installMenuGamepad({ container: () => c })
    nav.focusFirst()
    stepFrames(2) // focusFirst defers a frame; prime the poller

    expect(document.activeElement?.textContent).toBe('NEXT')
    tap(BTN.DOWN)
    expect(document.activeElement?.textContent).toBe('RETRY')
    tap(BTN.DOWN)
    expect(document.activeElement?.textContent).toBe('EXIT')
    tap(BTN.UP)
    expect(document.activeElement?.textContent).toBe('RETRY')
    nav.dispose()
  })

  it('A clicks the focused element', () => {
    const c = buildStack('finish', ['NEXT', 'RETRY', 'EXIT'])
    trackClicks(...(Array.from(c.children) as HTMLElement[]))
    const nav = installMenuGamepad({ container: () => c })
    nav.focusFirst()
    stepFrames(2)

    tap(BTN.DOWN) // focus RETRY
    tap(BTN.A)
    expect(clickLog).toEqual(['RETRY'])
    nav.dispose()
  })

  it('B fires onBack', () => {
    const c = buildStack('finish', ['NEXT', 'EXIT'])
    const onBack = vi.fn()
    const nav = installMenuGamepad({ container: () => c, onBack })
    nav.focusFirst()
    stepFrames(2)

    tap(BTN.B)
    expect(onBack).toHaveBeenCalledTimes(1)
    nav.dispose()
  })

  it('Start fires onStart', () => {
    const c = buildStack('finish', ['NEXT'])
    const onStart = vi.fn()
    const nav = installMenuGamepad({ container: () => c, onStart })
    nav.focusFirst()
    stepFrames(2)

    tap(BTN.START)
    expect(onStart).toHaveBeenCalledTimes(1)
    nav.dispose()
  })

  it('does nothing while isActive() is false, resumes when true', () => {
    const c = buildStack('finish', ['NEXT', 'RETRY', 'EXIT'])
    trackClicks(...(Array.from(c.children) as HTMLElement[]))
    let active = false
    const nav = installMenuGamepad({ container: () => c, isActive: () => active })
    nav.focusFirst()
    stepFrames(2)

    tap(BTN.A) // parked — must not click
    expect(clickLog).toEqual([])

    active = true
    stepFrames(1) // re-prime after reactivation
    // focusFirst's focus may have been set; ensure something is focused
    if (!c.contains(document.activeElement)) {
      ;(c.firstElementChild as HTMLElement).focus()
    }
    tap(BTN.A)
    expect(clickLog.length).toBe(1)
    nav.dispose()
  })

  it('A does not fire on the priming frame (held button at install)', () => {
    const c = buildStack('finish', ['NEXT'])
    trackClicks(...(Array.from(c.children) as HTMLElement[]))
    ;(c.firstElementChild as HTMLElement).focus()
    // A already held when the poller installs (e.g. throttle on a pad).
    hold(BTN.A)
    const nav = installMenuGamepad({ container: () => c })
    stepFrames(1) // prime: records the held edge, must NOT click
    expect(clickLog).toEqual([])
    stepFrames(2) // still held -> still no click (no fresh rising edge)
    expect(clickLog).toEqual([])
    nav.dispose()
  })
})

describe('installMenuGamepad — topmost-container stack (finish -> cup-results)', () => {
  it('one poller drives whichever overlay container is on top', () => {
    const finish = buildStack('finish', ['NEXT', 'RETRY', 'EXIT'])
    const cup = buildStack('cup-results', ['BACK TO MENU'], 400)
    trackClicks(
      ...(Array.from(finish.children) as HTMLElement[]),
      ...(Array.from(cup.children) as HTMLElement[]),
    )
    let cupShown = false
    const nav = installMenuGamepad({
      container: () => (cupShown ? cup : finish),
    })
    nav.focusFirst()
    stepFrames(2)

    // Drives the finish screen first.
    tap(BTN.DOWN)
    expect(document.activeElement?.textContent).toBe('RETRY')

    // Cup-results pops over the finish screen — the same poller follows it.
    cupShown = true
    nav.focusFirst()
    stepFrames(2)
    expect(document.activeElement?.textContent).toBe('BACK TO MENU')
    tap(BTN.A)
    expect(clickLog).toEqual(['BACK TO MENU'])
    nav.dispose()
  })
})

describe('installMenuGamepad — two independent stacked pollers (characterization)', () => {
  // Models the settings-over-menu / rebind-over-settings shape: a base
  // poller bound to the layer underneath and a second poller for the
  // overlay on top, both polling the SAME shared gamepad with no gate.
  // This documents WHY the post-race fix drives finish + cup-results with
  // a single topmost-container poller instead of stacking a second one —
  // two live pollers tug-of-war over focus and the A button never lands a
  // clean click on the overlay. Anyone tempted to "just add another
  // poller" should see these break.
  it('A fails to click a focused overlay button when a base poller is also live', () => {
    const base = buildStack('menu', ['PLAY', 'OPTIONS'])
    const overlay = buildStack('overlay', ['TAB-A', 'TAB-B'], 400)
    trackClicks(
      ...(Array.from(base.children) as HTMLElement[]),
      ...(Array.from(overlay.children) as HTMLElement[]),
    )

    const basePoller = installMenuGamepad({ container: () => base })
    const overlayPoller = installMenuGamepad({ container: () => overlay })
    stepFrames(1) // prime both
    ;(overlay.firstElementChild as HTMLElement).focus() // focus an overlay item
    expect(document.activeElement?.textContent).toBe('TAB-A')

    tap(BTN.A)
    // Each poller sees the focused element as "not mine" and bounces focus
    // to its own first child instead of clicking — so nothing activates.
    expect(clickLog).toEqual([])

    basePoller.dispose()
    overlayPoller.dispose()
  })

  it('d-pad cannot advance within the overlay while a base poller is also live', () => {
    const base = buildStack('menu', ['PLAY', 'OPTIONS'])
    const overlay = buildStack('overlay', ['TAB-A', 'TAB-B', 'TAB-C'], 400)

    const basePoller = installMenuGamepad({ container: () => base })
    const overlayPoller = installMenuGamepad({ container: () => overlay })
    stepFrames(1)
    ;(overlay.firstElementChild as HTMLElement).focus()

    tap(BTN.DOWN)
    // Intent was TAB-A -> TAB-B; instead the cross-poller bounce snaps
    // focus back to the overlay's first item. Never reaches TAB-B.
    expect(document.activeElement?.textContent).not.toBe('TAB-B')

    basePoller.dispose()
    overlayPoller.dispose()
  })
})

describe('isAnyOverlayShown', () => {
  it('reports whether any named overlay carries the .show class', () => {
    const a = document.createElement('div')
    a.id = 'settings-menu'
    document.body.appendChild(a)

    expect(isAnyOverlayShown('settings-menu', 'rebind-menu')).toBe(false)
    a.classList.add('show')
    expect(isAnyOverlayShown('settings-menu', 'rebind-menu')).toBe(true)
    expect(isAnyOverlayShown('rebind-menu')).toBe(false)
    expect(isAnyOverlayShown('not-in-dom')).toBe(false)
  })
})

describe('installMenuGamepad — gated base poller under an overlay (the fix)', () => {
  it('parking the base poller via isActive lets the overlay navigate + click cleanly', () => {
    // The shipped fix: each base-layer poller (main menu, pause) passes
    // `isActive: () => !isAnyOverlayShown('settings-menu', 'rebind-menu')`,
    // and the settings poller gates on rebind. With the base parked, the
    // overlay's poller owns the pad — the exact case the two prior tests
    // showed is broken when BOTH stay live.
    const base = buildStack('menu', ['PLAY', 'OPTIONS'])
    const overlay = buildStack('settings-menu', ['TAB-A', 'TAB-B', 'TAB-C'], 400)
    overlay.classList.add('show')
    trackClicks(...(Array.from(overlay.children) as HTMLElement[]))

    const basePoller = installMenuGamepad({
      container: () => base,
      isActive: () => !isAnyOverlayShown('settings-menu', 'rebind-menu'),
    })
    const overlayPoller = installMenuGamepad({ container: () => overlay })
    stepFrames(1)
    ;(overlay.firstElementChild as HTMLElement).focus()

    tap(BTN.DOWN)
    expect(document.activeElement?.textContent).toBe('TAB-B') // clean advance
    tap(BTN.A)
    expect(clickLog).toEqual(['TAB-B']) // A lands the click

    basePoller.dispose()
    overlayPoller.dispose()
  })
})
