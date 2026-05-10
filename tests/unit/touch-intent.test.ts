import { describe, expect, it } from 'vitest'
import { computeTouchIntent } from '../../src/engine/input/touch'

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
