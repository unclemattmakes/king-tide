// @vitest-environment jsdom
/**
 * F1-style start-lights overlay.
 *
 * The lights are driven from the race-hud's `onCountdownTick` callback
 * (3 → 2 → 1 → 0), and own a CSS-class-based state machine. Tests
 * cover:
 *   - DOM construction (lamp count, ids, dataset indices)
 *   - lamp-count progression at each tick
 *   - GO! state lights every lamp green + schedules an auto-hide
 *   - hide() / reset() clear the lamp state without tearing down the root
 *   - show/hide visibility flag
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStartLights } from '../../src/engine/render/start-lights'

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('createStartLights — DOM', () => {
  it('creates a root element with the default 5 lamps', () => {
    createStartLights()
    const root = document.getElementById('start-lights')
    expect(root).not.toBeNull()
    const lamps = root!.querySelectorAll('.sl-lamp')
    expect(lamps.length).toBe(5)
    // Lamps carry an index dataset for CSS / debug.
    lamps.forEach((lamp, i) => {
      expect((lamp as HTMLElement).dataset.index).toBe(String(i))
    })
  })

  it('honours the lampCount option', () => {
    createStartLights({ lampCount: 3 })
    const lamps = document.querySelectorAll('#start-lights .sl-lamp')
    expect(lamps.length).toBe(3)
  })

  it('reuses an existing root id between sessions (re-init wipes lamps)', () => {
    createStartLights({ lampCount: 3 })
    createStartLights({ lampCount: 7 })
    // After the second call the root is the same node but the lamp
    // count reflects the new option.
    const roots = document.querySelectorAll('#start-lights')
    expect(roots.length).toBe(1)
    expect(roots[0]!.querySelectorAll('.sl-lamp').length).toBe(7)
  })

  it('starts hidden — no sl-active class on the root', () => {
    createStartLights()
    const root = document.getElementById('start-lights')!
    expect(root.classList.contains('sl-active')).toBe(false)
  })
})

describe('createStartLights — countdown progression', () => {
  it('tick 3 lights two lamps red', () => {
    const lights = createStartLights()
    lights.setCountdown(3)
    const state = lights.state()
    expect(state.lit).toBe(2)
    expect(state.go).toBe(false)
    expect(state.visible).toBe(true)
    // The first two lamps carry the `sl-lit` class; lamps 2..4 do not.
    const lamps = document.querySelectorAll<HTMLElement>('#start-lights .sl-lamp')
    expect(lamps[0]!.classList.contains('sl-lit')).toBe(true)
    expect(lamps[1]!.classList.contains('sl-lit')).toBe(true)
    expect(lamps[2]!.classList.contains('sl-lit')).toBe(false)
  })

  it('tick 2 lights four lamps red', () => {
    const lights = createStartLights()
    lights.setCountdown(2)
    expect(lights.state().lit).toBe(4)
  })

  it('tick 1 lights all five lamps red (the hold)', () => {
    const lights = createStartLights()
    lights.setCountdown(1)
    const state = lights.state()
    expect(state.lit).toBe(5)
    expect(state.go).toBe(false)
    const lamps = document.querySelectorAll<HTMLElement>('#start-lights .sl-lamp')
    for (const lamp of lamps) {
      expect(lamp.classList.contains('sl-lit')).toBe(true)
      expect(lamp.classList.contains('sl-go')).toBe(false)
    }
  })

  it('GO (tick 0) flips every lamp green + schedules an auto-hide', () => {
    vi.useFakeTimers()
    const lights = createStartLights()
    // Set up the lit state first so we can prove the transition wipes
    // the red.
    lights.setCountdown(1)
    lights.setCountdown(0)
    const state = lights.state()
    expect(state.go).toBe(true)
    expect(state.lit).toBe(5)
    const lamps = document.querySelectorAll<HTMLElement>('#start-lights .sl-lamp')
    for (const lamp of lamps) {
      expect(lamp.classList.contains('sl-go')).toBe(true)
      expect(lamp.classList.contains('sl-lit')).toBe(false)
    }
    // Auto-hide fires ≥ 600 ms later.
    vi.advanceTimersByTime(2000)
    expect(lights.state().visible).toBe(false)
  })

  it('progressing 3 → 2 → 1 monotonically increases the lit count', () => {
    const lights = createStartLights()
    const lits: number[] = []
    lights.setCountdown(3)
    lits.push(lights.state().lit)
    lights.setCountdown(2)
    lits.push(lights.state().lit)
    lights.setCountdown(1)
    lits.push(lights.state().lit)
    expect(lits).toEqual([2, 4, 5])
  })

  it('first setCountdown auto-fades the row in (sl-active class)', () => {
    const lights = createStartLights()
    expect(lights.state().visible).toBe(false)
    lights.setCountdown(3)
    expect(lights.state().visible).toBe(true)
    expect(document.getElementById('start-lights')!.classList.contains('sl-active')).toBe(true)
  })
})

describe('createStartLights — lifecycle', () => {
  it('hide() clears the active class + resets state', () => {
    const lights = createStartLights()
    lights.setCountdown(2)
    lights.hide()
    const state = lights.state()
    expect(state.visible).toBe(false)
    expect(state.lit).toBe(0)
    expect(state.go).toBe(false)
    const root = document.getElementById('start-lights')!
    expect(root.classList.contains('sl-active')).toBe(false)
    expect(root.classList.contains('sl-finished')).toBe(false)
  })

  it('reset() leaves visibility alone but darkens every lamp', () => {
    const lights = createStartLights()
    lights.show()
    lights.setCountdown(2) // 4 red lamps
    lights.reset()
    const state = lights.state()
    expect(state.lit).toBe(0)
    expect(state.go).toBe(false)
    // setCountdown(2) called show() implicitly, so visible should still be true after reset.
    expect(state.visible).toBe(true)
  })

  it('hide() cancels the pending auto-hide timer', () => {
    vi.useFakeTimers()
    const lights = createStartLights()
    lights.setCountdown(0)
    // Manual hide before the auto-hide timer fires.
    lights.hide()
    // Advance past the auto-hide window — should NOT throw (timer was
    // cancelled) and the state shouldn't be re-touched.
    vi.advanceTimersByTime(2000)
    expect(lights.state().visible).toBe(false)
  })

  it('show() is a no-op when already visible', () => {
    const lights = createStartLights()
    lights.show()
    expect(lights.state().visible).toBe(true)
    lights.show()
    expect(lights.state().visible).toBe(true)
  })
})
