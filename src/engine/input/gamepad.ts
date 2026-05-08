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
 * Standard gamepad → racing intent (W3C "standard" mapping):
 *   Left stick X (axes[0])  → steer
 *   Left stick Y (axes[1])  → pitch (pull back = nose up, push forward = dive)
 *   A / Cross    (button 0) → throttle
 *   B / Circle   (button 1) → emergency brake (hard stop, no reverse)
 *   LB / L1      (button 4) → boost
 *   RB / R1      (button 5) → fire pickup
 *   LT / L2      (button 6) → analog brake; if held with no throttle, reverses
 *   RT / R2      (button 7) → throttle
 */
export function gamepadIntent(): Intent {
  const intent = emptyIntent()
  const pad = navigator.getGamepads?.()?.[0]
  if (!pad) return intent

  intent.steer = applyDeadzone(pad.axes[0] ?? 0)
  // axes[1] is negative when the stick is pushed forward (away from player),
  // positive when pulled back. Hover sim convention (post-M9.18 follow-up):
  // positive intent.pitch = nose UP / lift, negative = nose DOWN / dive.
  // So pull back (axes[1] = +1) → pitch +1 → lift; push forward (axes[1] = -1)
  // → pitch -1 → dive. No sign flip needed.
  intent.pitch = applyDeadzone(pad.axes[1] ?? 0)

  const rt = pad.buttons[7]?.value ?? 0
  const a = pad.buttons[0]?.pressed ? 1 : 0
  intent.throttle = Math.max(rt, a)

  const lt = pad.buttons[6]?.value ?? 0
  const bBtn = pad.buttons[1]?.pressed ? 1 : 0
  intent.brake = Math.max(lt, bBtn)
  // LT-only reverse: holding LT with no throttle reverses the bike.
  // B button is emergency brake — never reverses.
  if (lt > 0.1 && intent.throttle < 0.1 && bBtn === 0) {
    intent.throttle = -lt
  }

  intent.fire = pad.buttons[5]?.pressed ?? false
  intent.boost = pad.buttons[4]?.pressed ?? false
  return intent
}
