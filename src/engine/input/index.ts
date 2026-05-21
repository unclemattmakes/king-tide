import { gamepadIntent, snapshotGamepads } from './gamepad'
import { emptyIntent, type Intent } from './intent'
import { installKeyboard, keyboardIntent } from './keyboard'
import { installTouch, isTouchEnabled, touchIntent } from './touch'

export { emptyIntent, type Intent, snapshotGamepads }

export type ActiveInputSource = 'keyboard' | 'gamepad' | 'touch'

export function installInput(): void {
  installKeyboard()
  installTouch()
}

const ACTIVITY_THRESHOLD = 0.15
function intentMagnitude(i: Intent): number {
  return (
    Math.abs(i.throttle) +
    Math.abs(i.steer) +
    Math.abs(i.pitch) +
    i.brake +
    (i.fire ? 1 : 0) +
    (i.boost ? 1 : 0) +
    (i.trickLeft ? 1 : 0) +
    (i.trickRight ? 1 : 0)
  )
}

let lastKeyboardActivityMs = 0
let lastGamepadActivityMs = 0
let lastTouchActivityMs = 0

/**
 * Merge keyboard + gamepad + touch. For each axis, the input with the larger
 * magnitude wins; for booleans, OR. All sources work simultaneously — a player
 * can tap a key while a gamepad or virtual joystick is active without one
 * overriding the others.
 *
 * As a side-effect, stamps a per-source "last activity" timestamp so HUD
 * hints (see `activeInputSource()`) can show controller glyphs while the
 * player is actually using a controller and keyboard hints when they
 * switch back. A "touch" is any non-trivial axis or any button press.
 */
export function readPlayerIntent(dt: number): Intent {
  const k = keyboardIntent(dt)
  const g = gamepadIntent()
  const t = touchIntent()

  const now = performance.now()
  if (intentMagnitude(k) > ACTIVITY_THRESHOLD) lastKeyboardActivityMs = now
  if (intentMagnitude(g) > ACTIVITY_THRESHOLD) lastGamepadActivityMs = now
  if (intentMagnitude(t) > ACTIVITY_THRESHOLD) lastTouchActivityMs = now

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

/**
 * Which input source the player is currently using, for HUD hints.
 * "Currently using" = the source with the most recent non-trivial input
 * (any button or above-threshold axis), with keyboard winning ties (the
 * historical default). Returns 'keyboard' when nothing has been touched
 * yet so the first-frame HUD shows the WASD/Z/C glyphs rather than '—'.
 */
export function activeInputSource(): ActiveInputSource {
  let best: ActiveInputSource = 'keyboard'
  let bestAt = lastKeyboardActivityMs
  if (lastGamepadActivityMs > bestAt) {
    best = 'gamepad'
    bestAt = lastGamepadActivityMs
  }
  if (lastTouchActivityMs > bestAt) {
    best = 'touch'
    bestAt = lastTouchActivityMs
  }
  return best
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
