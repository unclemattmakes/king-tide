import { devSettings } from '../dev-settings'
import { playerSettings } from '../player-settings'
import type { KeyboardAction, KeyboardBindings } from './bindings'
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

/** Action lookup against the live binding table. Either the primary
 *  slot or (if present) the secondary slot held → true. */
function isActionDown(action: KeyboardAction, bindings: KeyboardBindings): boolean {
  const b = bindings[action]
  if (keys.has(b.primary)) return true
  return b.secondary !== null && keys.has(b.secondary)
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
 * Each axis is a sum of two action signals (e.g. steer = steerRight −
 * steerLeft) so a key bound to opposite actions cancels cleanly. Default
 * bindings (`DEFAULT_KEYBOARD_BINDINGS`) reproduce the original WASD +
 * arrows + Q/E + Space + Shift mapping; the Controls tab's rebind modal
 * rewrites the table in place via `setKeyboardBindings`.
 *
 *   throttleForward + throttleBack → throttle, brake
 *   steerLeft + steerRight         → steer
 *   pitchUp + pitchDown            → pitch
 *   fire                           → fire
 *   boost                          → boost
 */
export function keyboardIntent(dt: number): Intent {
  const bindings = playerSettings.keyboardBindings

  const left = isActionDown('steerLeft', bindings) ? 1 : 0
  const right = isActionDown('steerRight', bindings) ? 1 : 0
  const steerTarget = right - left

  const fwd = isActionDown('throttleForward', bindings) ? 1 : 0
  const back = isActionDown('throttleBack', bindings)
  // Match the original feel — `back` simultaneously requests reverse AND
  // brake. When the player is also holding forward, the forward request
  // wins (throttleTarget = 0) so the bike coasts to a stop rather than
  // fighting itself.
  let throttleTarget = fwd
  if (back) throttleTarget = throttleTarget === 1 ? 0 : -1

  const up = isActionDown('pitchUp', bindings) ? 1 : 0
  const down = isActionDown('pitchDown', bindings) ? 1 : 0
  // intent.pitch convention (intent.ts + hover.ts): positive = nose UP.
  // So pitchUp (E) → +1, pitchDown (Q) → -1. The mirrored `down - up`
  // shipped briefly in 8562ffe and inverted keyboard pitch relative to
  // gamepad / touch — wheelie input read as a dive.
  const pitchTarget = up - down

  smoothSteer = lerpToward(smoothSteer, steerTarget, dt, devSettings.keyboardSteerRate)
  smoothThrottle = lerpToward(smoothThrottle, throttleTarget, dt, devSettings.keyboardThrottleRate)
  smoothPitch = lerpToward(smoothPitch, pitchTarget, dt, devSettings.keyboardPitchRate)

  const intent: Intent = emptyIntent()
  intent.throttle = smoothThrottle
  intent.steer = smoothSteer
  intent.brake = back ? 1 : 0
  intent.fire = isActionDown('fire', bindings)
  intent.boost = isActionDown('boost', bindings)
  intent.pitch = smoothPitch
  intent.trickLeft = isActionDown('trickLeft', bindings)
  intent.trickRight = isActionDown('trickRight', bindings)
  intent.tuck = isActionDown('tuck', bindings)
  return intent
}
