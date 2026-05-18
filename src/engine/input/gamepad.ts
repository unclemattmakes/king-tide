import { devSettings } from '../dev-settings'
import { playerSettings } from '../player-settings'
import { emptyIntent, type Intent } from './intent'

/**
 * Modern radial response: subtract the deadzone, rescale the remainder to
 * [0, 1] so the response starts at zero immediately past the deadzone, then
 * raise to `stickCurve` to soften the center and keep full authority at the
 * rim. Default curve ~1.6 reads as the "racing / flight stick" feel —
 * Forza/Halo/etc. — a quarter-stick correction barely moves the bike, but
 * the rim is still 1.0.
 *
 * The deadzone is the player-facing `playerSettings.gamepadDeadzone`; the
 * curve exponent stays on `devSettings.stickCurve` as a developer feel
 * knob. The output is multiplied by `playerSettings.gamepadSensitivity`
 * and clamped to [-1, 1] so >1.0 sensitivity saturates earlier instead of
 * overshooting.
 */
function shapeAxis(v: number): number {
  const dz = playerSettings.gamepadDeadzone
  const mag = Math.abs(v)
  if (mag < dz) return 0
  const t = (mag - dz) / (1 - dz)
  const shaped = Math.sign(v) * Math.min(t, 1) ** devSettings.stickCurve
  const scaled = shaped * playerSettings.gamepadSensitivity
  return Math.max(-1, Math.min(1, scaled))
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
 *   LT / L2      (button 6) → analog brake; if held with no throttle, reverses
 *   RT / R2      (button 7) → throttle
 *   `fire`  action button   → fire pickup (default RB / R1)
 *   `boost` action button   → boost (default LB / L1)
 *
 * The action buttons (fire / boost) read through `playerSettings.gamepadBindings`
 * so the Controls tab rebind modal can move them.
 */
export function gamepadIntent(): Intent {
  const intent = emptyIntent()
  const pad = navigator.getGamepads?.()?.[0]
  if (!pad) return intent

  intent.steer = shapeAxis(pad.axes[0] ?? 0)
  // axes[1] is negative when the stick is pushed forward (away from player),
  // positive when pulled back. Hover sim convention (post-M9.18 follow-up):
  // positive intent.pitch = nose UP / lift, negative = nose DOWN / dive.
  // So pull back (axes[1] = +1) → pitch +1 → lift; push forward (axes[1] = -1)
  // → pitch -1 → dive. No sign flip needed.
  intent.pitch = shapeAxis(pad.axes[1] ?? 0)

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

  const bindings = playerSettings.gamepadBindings
  intent.fire = pad.buttons[bindings.fire]?.pressed ?? false
  intent.boost = pad.buttons[bindings.boost]?.pressed ?? false
  return intent
}

/** Snapshot the live button-press state for the rebind capture flow.
 *  Returns the index of any button currently pressed, ignoring the
 *  analog triggers (LT/RT = 6/7) because those report as "pressed" any
 *  time the player squeezes them — the rebind flow needs a discrete
 *  press, not a hair-trigger touch. */
export function pollGamepadButtonPress(): number | null {
  const pads = navigator.getGamepads?.() ?? []
  for (const pad of pads) {
    if (!pad) continue
    for (let i = 0; i < pad.buttons.length; i++) {
      if (i === 6 || i === 7) continue
      if (pad.buttons[i]?.pressed) return i
    }
  }
  return null
}
