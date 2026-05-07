import { emptyIntent, type Intent } from './intent'

const DEADZONE = 0.12

function applyDeadzone(v: number): number {
  return Math.abs(v) < DEADZONE ? 0 : v
}

export type GamepadSnapshot = {
  id: string
  axes: number[]
  buttons: boolean[]
}

export function snapshotGamepads(): GamepadSnapshot[] {
  const pads = navigator.getGamepads?.() ?? []
  const out: GamepadSnapshot[] = []
  for (const p of pads) {
    if (!p) continue
    out.push({
      id: p.id,
      axes: [...p.axes],
      buttons: p.buttons.map((b) => b.pressed),
    })
  }
  return out
}

/**
 * Standard gamepad → racing intent.
 * Throttle = right trigger (button 7), brake/reverse = left trigger (button 6).
 * Steer = left stick X. Fire = X/A (button 0). Boost = A/B (button 1).
 */
export function gamepadIntent(): Intent {
  const intent = emptyIntent()
  const pad = navigator.getGamepads?.()?.[0]
  if (!pad) return intent

  intent.steer = applyDeadzone(pad.axes[0] ?? 0)
  // Left-stick Y for pitch. axes[1] is negative when pushed forward (toward
  // the screen on a typical pad); invert so positive = nose-down dive.
  intent.pitch = -applyDeadzone(pad.axes[1] ?? 0)
  intent.throttle = pad.buttons[7]?.value ?? 0
  intent.brake = pad.buttons[6]?.value ?? 0
  if (intent.brake > 0.1 && intent.throttle < 0.1) {
    intent.throttle = -intent.brake
  }
  intent.fire = pad.buttons[0]?.pressed ?? false
  intent.boost = pad.buttons[1]?.pressed ?? false
  return intent
}
