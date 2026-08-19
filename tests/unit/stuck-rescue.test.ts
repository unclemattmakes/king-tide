/**
 * Stuck-rescue — pins the wedge-timer step (the pure heart of the
 * auto-respawn safety net, src/game/systems/stuck-rescue.ts) and the
 * respawn action's presence in the keyboard bindings (the playtest
 * found the old Backspace listener was invisible: hardcoded, absent
 * from the rebind list, undiscoverable while wedged on a rock).
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KEYBOARD_BINDINGS,
  KEYBOARD_ACTION_LABEL,
  KEYBOARD_ACTIONS,
  parseKeyboardBindings,
} from '../../src/engine/input/bindings'
import {
  advanceWedgeTimer,
  WEDGE_RESCUE_SEC,
  WEDGE_SPEED_MAX,
  WEDGE_THROTTLE_MIN,
} from '../../src/game/systems/stuck-rescue'

const DT = 1 / 60

describe('advanceWedgeTimer', () => {
  const wedged = { grounded: true, throttle: 1, horizSpeed: 0.4, blocked: false }

  it('accumulates while grounded + throttling + pinned', () => {
    let t = 0
    for (let i = 0; i < 60; i++) t = advanceWedgeTimer(t, wedged, DT)
    expect(t).toBeCloseTo(1, 5)
  })

  it('reaches the rescue threshold in the documented time', () => {
    let t = 0
    let ticks = 0
    while (t < WEDGE_RESCUE_SEC && ticks < 10_000) {
      t = advanceWedgeTimer(t, wedged, DT)
      ticks++
    }
    expect(ticks * DT).toBeCloseTo(WEDGE_RESCUE_SEC, 1)
  })

  it('resets the moment any condition breaks', () => {
    let t = advanceWedgeTimer(2, wedged, DT)
    expect(t).toBeGreaterThan(2)
    // Moving again — riding, not wedged.
    t = advanceWedgeTimer(t, { ...wedged, horizSpeed: WEDGE_SPEED_MAX + 0.1 }, DT)
    expect(t).toBe(0)
    // Coasting without throttle is not "trying" — no rescue.
    t = advanceWedgeTimer(2, { ...wedged, throttle: WEDGE_THROTTLE_MIN - 0.1 }, DT)
    expect(t).toBe(0)
    // Airborne isn't wedged (hang-ups mid-air are the OOB leash's job).
    t = advanceWedgeTimer(2, { ...wedged, grounded: false }, DT)
    expect(t).toBe(0)
    // Blocked (OOB drama in progress) holds the timer at zero.
    t = advanceWedgeTimer(2, { ...wedged, blocked: true }, DT)
    expect(t).toBe(0)
  })
})

describe('respawn keyboard action', () => {
  it('is a first-class, labelled, defaulted binding', () => {
    expect(KEYBOARD_ACTIONS).toContain('respawn')
    expect(KEYBOARD_ACTION_LABEL.respawn.length).toBeGreaterThan(0)
    expect(DEFAULT_KEYBOARD_BINDINGS.respawn.primary).toBe('Backspace')
  })

  it('backfills the default for players with pre-respawn persisted bindings', () => {
    // A settings blob saved before the action existed must not strand
    // the player with no respawn key.
    const legacy = { throttleForward: { primary: 'KeyI', secondary: null } }
    const parsed = parseKeyboardBindings(legacy)
    expect(parsed.throttleForward.primary).toBe('KeyI')
    expect(parsed.respawn.primary).toBe('Backspace')
  })
})
