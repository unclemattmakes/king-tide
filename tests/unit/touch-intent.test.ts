import { describe, expect, it } from 'vitest'
import {
  computeTouchIntent,
  THROTTLE_DOUBLE_TAP_MS,
  type ThrottleLockState,
  throttlePressTransition,
} from '../../src/engine/input/touch'

const NO_BTN = { fire: false, boost: false, brake: false, thrust: false }

describe('computeTouchIntent', () => {
  it('zero stick + no buttons = zeroed intent', () => {
    const i = computeTouchIntent(0, 0, NO_BTN)
    expect(i.throttle).toBe(0)
    expect(i.steer).toBe(0)
    expect(i.brake).toBe(0)
    expect(i.pitch).toBe(0)
    expect(i.fire).toBe(false)
    expect(i.boost).toBe(false)
  })

  it('thrust button = full throttle', () => {
    const i = computeTouchIntent(0, 0, { ...NO_BTN, thrust: true })
    expect(i.throttle).toBe(1)
    expect(i.brake).toBe(0)
  })

  it('stick alone never produces throttle (thrust is button-only)', () => {
    const fwd = computeTouchIntent(0, 1, NO_BTN)
    expect(fwd.throttle).toBe(0)
    const back = computeTouchIntent(0, -1, NO_BTN)
    expect(back.throttle).toBe(0)
    expect(back.brake).toBe(0)
  })

  it('stick up = negative pitch (nose-down dive, matching gamepad/flight stick)', () => {
    const i = computeTouchIntent(0, 1, NO_BTN)
    expect(i.pitch).toBe(-1)
  })

  it('stick down = positive pitch (nose up / lift)', () => {
    const i = computeTouchIntent(0, -1, NO_BTN)
    expect(i.pitch).toBe(1)
  })

  it('right stick = positive steer', () => {
    const i = computeTouchIntent(1, 0, NO_BTN)
    expect(i.steer).toBe(1)
  })

  it('left stick = negative steer', () => {
    const i = computeTouchIntent(-1, 0, NO_BTN)
    expect(i.steer).toBe(-1)
  })

  it('deadzone clears small inputs', () => {
    const i = computeTouchIntent(0.05, 0.05, NO_BTN)
    expect(i.steer).toBe(0)
    expect(i.pitch).toBe(0)
  })

  it('clamps out-of-range values', () => {
    const i = computeTouchIntent(1.5, -1.5, NO_BTN)
    expect(i.steer).toBe(1)
    // rawStickY = -1.5 → inverted to +1.5 → clamps to +1.
    expect(i.pitch).toBe(1)
  })

  it('button presses map through to flags / brake / throttle', () => {
    const i = computeTouchIntent(0, 0, { fire: true, boost: true, brake: true, thrust: true })
    expect(i.fire).toBe(true)
    expect(i.boost).toBe(true)
    expect(i.brake).toBe(1)
    expect(i.throttle).toBe(1)
  })

  it('thrust + brake together: brake holds, throttle still on (player decides)', () => {
    const i = computeTouchIntent(0, 0, { ...NO_BTN, thrust: true, brake: true })
    expect(i.throttle).toBe(1)
    expect(i.brake).toBe(1)
  })
})

describe('throttlePressTransition (double-tap throttle lock)', () => {
  const UNLOCKED: ThrottleLockState = { locked: false, lastPressMs: 0 }

  it('a lone tap holds throttle and arms the double-tap window', () => {
    const r = throttlePressTransition(UNLOCKED, 1000)
    expect(r.throttleOn).toBe(true)
    expect(r.locked).toBe(false)
    expect(r.lastPressMs).toBe(1000)
  })

  it('a second tap within the window latches throttle on', () => {
    const first = throttlePressTransition(UNLOCKED, 1000)
    const second = throttlePressTransition(first, 1000 + THROTTLE_DOUBLE_TAP_MS)
    expect(second.locked).toBe(true)
    expect(second.throttleOn).toBe(true)
  })

  it('a slow second tap does NOT latch (just re-arms)', () => {
    const first = throttlePressTransition(UNLOCKED, 1000)
    const second = throttlePressTransition(first, 1000 + THROTTLE_DOUBLE_TAP_MS + 1)
    expect(second.locked).toBe(false)
    expect(second.throttleOn).toBe(true)
    expect(second.lastPressMs).toBe(1000 + THROTTLE_DOUBLE_TAP_MS + 1)
  })

  it('tapping while latched disengages the lock and cuts throttle on release', () => {
    const locked: ThrottleLockState = { locked: true, lastPressMs: 0 }
    const r = throttlePressTransition(locked, 5000)
    expect(r.locked).toBe(false)
    expect(r.throttleOn).toBe(false)
    expect(r.lastPressMs).toBe(0)
  })

  it('after unlocking, the next quick tap does not immediately re-latch', () => {
    const locked: ThrottleLockState = { locked: true, lastPressMs: 0 }
    const unlocked = throttlePressTransition(locked, 5000)
    // A tap right after unlock starts a fresh momentary press, not a lock.
    const next = throttlePressTransition(unlocked, 5000 + 10)
    expect(next.locked).toBe(false)
    expect(next.throttleOn).toBe(true)
  })
})
