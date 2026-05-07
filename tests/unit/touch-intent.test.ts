import { describe, expect, it } from 'vitest'
import { computeTouchIntent } from '../../src/engine/input/touch'

const NO_BTN = { fire: false, boost: false, brake: false }

describe('computeTouchIntent', () => {
  it('zero stick + no buttons = zeroed intent', () => {
    const i = computeTouchIntent(0, 0, NO_BTN)
    expect(i.throttle).toBe(0)
    expect(i.steer).toBe(0)
    expect(i.brake).toBe(0)
    expect(i.fire).toBe(false)
    expect(i.boost).toBe(false)
  })

  it('full forward stick = full throttle, no brake', () => {
    const i = computeTouchIntent(0, 1, NO_BTN)
    expect(i.throttle).toBe(1)
    expect(i.brake).toBe(0)
  })

  it('full back stick = reverse throttle + full brake', () => {
    const i = computeTouchIntent(0, -1, NO_BTN)
    expect(i.throttle).toBe(-1)
    expect(i.brake).toBe(1)
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
    expect(i.throttle).toBe(0)
  })

  it('clamps out-of-range values', () => {
    const i = computeTouchIntent(1.5, -1.5, NO_BTN)
    expect(i.steer).toBe(1)
    expect(i.throttle).toBe(-1)
    expect(i.brake).toBe(1)
  })

  it('button press maps through to flags / brake', () => {
    const i = computeTouchIntent(0, 0, { fire: true, boost: true, brake: true })
    expect(i.fire).toBe(true)
    expect(i.boost).toBe(true)
    expect(i.brake).toBe(1)
  })

  it('brake button overrides a forward stick brake of 0', () => {
    const i = computeTouchIntent(0, 0.8, { fire: false, boost: false, brake: true })
    expect(i.throttle).toBeCloseTo(0.8)
    expect(i.brake).toBe(1)
  })
})
