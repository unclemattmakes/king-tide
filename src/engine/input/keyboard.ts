import { devSettings } from '../dev-settings'
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

// Smoothed analog values — lerped each tick toward the binary key state.
// Stops keyboard from feeling twitchy: pressing D for 50ms gives a small steer,
// holding D ramps to full deflection over ~0.15s.
let smoothSteer = 0
let smoothThrottle = 0
let smoothPitch = 0

// Smoothing rates live on devSettings (keyboardSteerRate / ThrottleRate / PitchRate)
// so the dev settings menu can tune feel live without a reload.

function lerpToward(current: number, target: number, dt: number, rate: number): number {
  const t = 1 - Math.exp(-dt * rate)
  return current + (target - current) * t
}

/**
 * WASD / arrows for movement, Q/E for pitch (Wave-Race-style lean forward/back).
 *   W or ↑   = throttle forward
 *   S or ↓   = brake / reverse
 *   A or ←   = steer left
 *   D or →   = steer right
 *   Q        = pitch up   (lean back, jump off a wave)
 *   E        = pitch down (lean forward, dive into a wave)
 *   Space    = fire pickup
 *   Shift    = boost
 */
export function keyboardIntent(dt: number): Intent {
  let steerTarget = 0
  if (keys.has('KeyA') || keys.has('ArrowLeft')) steerTarget -= 1
  if (keys.has('KeyD') || keys.has('ArrowRight')) steerTarget += 1

  let throttleTarget = 0
  if (keys.has('KeyW') || keys.has('ArrowUp')) throttleTarget = 1
  if (keys.has('KeyS') || keys.has('ArrowDown')) throttleTarget = throttleTarget === 1 ? 0 : -1

  let pitchTarget = 0
  if (keys.has('KeyQ')) pitchTarget -= 1
  if (keys.has('KeyE')) pitchTarget += 1

  smoothSteer = lerpToward(smoothSteer, steerTarget, dt, devSettings.keyboardSteerRate)
  smoothThrottle = lerpToward(smoothThrottle, throttleTarget, dt, devSettings.keyboardThrottleRate)
  smoothPitch = lerpToward(smoothPitch, pitchTarget, dt, devSettings.keyboardPitchRate)

  const intent: Intent = emptyIntent()
  intent.throttle = smoothThrottle
  intent.steer = smoothSteer
  intent.brake = keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0
  intent.fire = keys.has('Space')
  intent.boost = keys.has('ShiftLeft') || keys.has('ShiftRight')
  intent.pitch = smoothPitch
  return intent
}
