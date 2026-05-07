import { emptyIntent, type Intent } from './intent'

const keys = new Set<string>()

export function installKeyboard(): void {
  window.addEventListener('keydown', (e) => {
    keys.add(e.code)
  })
  window.addEventListener('keyup', (e) => {
    keys.delete(e.code)
  })
  window.addEventListener('blur', () => {
    keys.clear()
  })
}

export function isKeyDown(code: string): boolean {
  return keys.has(code)
}

/**
 * WASD/arrows fallback when no gamepad is connected.
 * W/Up = throttle, S/Down = brake/reverse, A/Left + D/Right = steer.
 * Space = fire, Shift = boost.
 */
export function keyboardIntent(): Intent {
  const intent = emptyIntent()
  if (keys.has('KeyW') || keys.has('ArrowUp')) intent.throttle = 1
  if (keys.has('KeyS') || keys.has('ArrowDown')) {
    intent.throttle = intent.throttle === 1 ? 0 : -1
    intent.brake = 1
  }
  if (keys.has('KeyA') || keys.has('ArrowLeft')) intent.steer -= 1
  if (keys.has('KeyD') || keys.has('ArrowRight')) intent.steer += 1
  intent.fire = keys.has('Space')
  intent.boost = keys.has('ShiftLeft') || keys.has('ShiftRight')
  return intent
}
