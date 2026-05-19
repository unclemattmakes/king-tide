import { gamepadIntent, snapshotGamepads } from './gamepad'
import { emptyIntent, type Intent } from './intent'
import { installKeyboard, keyboardIntent } from './keyboard'
import { installTouch, isTouchEnabled, touchIntent } from './touch'

export { emptyIntent, type Intent, snapshotGamepads }

export function installInput(): void {
  installKeyboard()
  installTouch()
}

/**
 * Merge keyboard + gamepad + touch. For each axis, the input with the larger
 * magnitude wins; for booleans, OR. All sources work simultaneously — a player
 * can tap a key while a gamepad or virtual joystick is active without one
 * overriding the others.
 */
export function readPlayerIntent(dt: number): Intent {
  const k = keyboardIntent(dt)
  const g = gamepadIntent()
  const t = touchIntent()

  const pickAxis = (a: number, b: number, c: number) => {
    let best = a
    if (Math.abs(b) > Math.abs(best)) best = b
    if (Math.abs(c) > Math.abs(best)) best = c
    return best
  }

  return {
    throttle: pickAxis(k.throttle, g.throttle, t.throttle),
    steer: pickAxis(k.steer, g.steer, t.steer),
    brake: Math.max(k.brake, g.brake, t.brake),
    fire: k.fire || g.fire || t.fire,
    boost: k.boost || g.boost || t.boost,
    pitch: pickAxis(k.pitch, g.pitch, t.pitch),
    trickLeft: k.trickLeft || g.trickLeft || t.trickLeft,
    trickRight: k.trickRight || g.trickRight || t.trickRight,
  }
}

export function inputSourceLabel(): string {
  const pads = snapshotGamepads()
  const touch = isTouchEnabled()
  const parts: string[] = []
  if (touch) parts.push('touch')
  if (pads.length > 0) parts.push('gamepad')
  parts.push('kb')
  return parts.join('+')
}
