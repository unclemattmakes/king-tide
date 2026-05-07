import { gamepadIntent, snapshotGamepads } from './gamepad'
import { emptyIntent, type Intent } from './intent'
import { installKeyboard, keyboardIntent } from './keyboard'

export { emptyIntent, type Intent, snapshotGamepads }

export function installInput(): void {
  installKeyboard()
}

/**
 * Merge keyboard + gamepad. For each axis, the input with the larger magnitude
 * wins; for booleans, OR. Both work simultaneously — a player can tap a key
 * while a gamepad is connected without one overriding the other.
 */
export function readPlayerIntent(dt: number): Intent {
  const k = keyboardIntent(dt)
  const g = gamepadIntent()

  const pickAxis = (a: number, b: number) => (Math.abs(a) >= Math.abs(b) ? a : b)

  return {
    throttle: pickAxis(k.throttle, g.throttle),
    steer: pickAxis(k.steer, g.steer),
    brake: Math.max(k.brake, g.brake),
    fire: k.fire || g.fire,
    boost: k.boost || g.boost,
    pitch: pickAxis(k.pitch, g.pitch),
  }
}

export function inputSourceLabel(): string {
  const pads = snapshotGamepads()
  if (pads.length > 0) return `gamepad+kb`
  return 'keyboard'
}
