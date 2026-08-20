/**
 * Input action bindings — player-rebindable keyboard + gamepad mapping.
 *
 * The keyboard + gamepad input modules look up action state through
 * these tables instead of hardcoded key/button codes, so the Controls
 * tab's rebind modal can mutate them in place. Persistence lives on
 * `playerSettings` (see player-settings.ts); this module owns the
 * action set, the default table, and the lookup helpers.
 *
 * Each keyboard action has a **primary** slot (player-rebindable) and a
 * **secondary** slot (frozen default — gives WASD + Arrows out of the
 * box). The rebind modal only edits primary; if a player binds a key
 * that lived in a secondary, that secondary slot is cleared so each key
 * is in exactly one place. Swap semantics on primary: binding key K to
 * action A swaps in A's old primary as the previous holder's primary,
 * so no action is left unreachable by an accidental rebind.
 *
 * Gamepad: only the action buttons (fire / boost) are rebindable. Stick
 * axes (left = steer/pitch, right = camera-look) and triggers (LT/RT =
 * brake/throttle) stay on the W3C standard mapping — players tune those
 * via sensitivity / deadzone in the Controls tab.
 */

export type KeyboardAction =
  | 'throttleForward'
  | 'throttleBack'
  | 'steerLeft'
  | 'steerRight'
  | 'pitchUp'
  | 'pitchDown'
  | 'fire'
  | 'boost'
  | 'trickLeft'
  | 'trickRight'
  | 'respawn'

export const KEYBOARD_ACTIONS: readonly KeyboardAction[] = [
  'throttleForward',
  'throttleBack',
  'steerLeft',
  'steerRight',
  'pitchUp',
  'pitchDown',
  'trickLeft',
  'trickRight',
  'fire',
  'boost',
  'respawn',
] as const

export const KEYBOARD_ACTION_LABEL: Readonly<Record<KeyboardAction, string>> = Object.freeze({
  throttleForward: 'Throttle / forward',
  throttleBack: 'Brake / reverse',
  steerLeft: 'Steer left',
  steerRight: 'Steer right',
  pitchUp: 'Pitch up (nose up)',
  pitchDown: 'Pitch down (nose down)',
  trickLeft: 'Drift / trick (left)',
  trickRight: 'Drift / trick (right)',
  fire: 'Fire pickup',
  boost: 'Boost',
  respawn: 'Respawn to track',
})

export type KeyboardBinding = {
  primary: string
  /** Frozen default — gives Arrows / RShift out of the box. Cleared if
   *  a rebind reassigns the same code as a different action's primary. */
  secondary: string | null
}

export type KeyboardBindings = Record<KeyboardAction, KeyboardBinding>

export const DEFAULT_KEYBOARD_BINDINGS: Readonly<KeyboardBindings> = Object.freeze({
  throttleForward: { primary: 'KeyW', secondary: 'ArrowUp' },
  throttleBack: { primary: 'KeyS', secondary: 'ArrowDown' },
  steerLeft: { primary: 'KeyA', secondary: 'ArrowLeft' },
  steerRight: { primary: 'KeyD', secondary: 'ArrowRight' },
  // Convention preserved from M9.18: E lifts (nose up), Q dives (nose
  // down). The status doc calls out that older docs/comments had this
  // backwards — the code (and these defaults) match the actual
  // sim-side intent.pitch convention where positive = nose up.
  pitchUp: { primary: 'KeyE', secondary: null },
  pitchDown: { primary: 'KeyQ', secondary: null },
  // MK8-style hop-trick buttons. Z/C sit just below the WASD cluster so
  // the trick-hand never has to leave the keys it's already on. On a
  // gamepad these map to L1/R1.
  trickLeft: { primary: 'KeyZ', secondary: null },
  trickRight: { primary: 'KeyC', secondary: null },
  fire: { primary: 'Space', secondary: null },
  boost: { primary: 'ShiftLeft', secondary: 'ShiftRight' },
  // Was a hardcoded, undocumented Backspace listener in controls.ts —
  // invisible in the rebind list, so players stuck on rocks had no way
  // to discover the rescue. Now a first-class, rebindable action.
  // (Gamepads lean on the automatic wedge/eject rescue —
  // stuck-rescue.ts — rather than spending a button.)
  respawn: { primary: 'Backspace', secondary: null },
})

/** Gamepad buttons we let the player remap. Sticks stay on the W3C
 *  standard mapping (axes[0..3]); triggers (buttons 6/7) drive analog
 *  throttle / brake and stay fixed because non-button bindings can't be
 *  captured by "press a button" prompts cleanly.
 *
 *  MK8 layout: L1/R1 own the drift-hold + hop-trick channel. Fire +
 *  boost relocated to face buttons so the bumpers stay on the trick
 *  channel where the wrist naturally rests during a drift hold. */
export type GamepadAction = 'fire' | 'boost' | 'trickLeft' | 'trickRight'

export const GAMEPAD_ACTIONS: readonly GamepadAction[] = [
  'trickLeft',
  'trickRight',
  'fire',
  'boost',
] as const

export const GAMEPAD_ACTION_LABEL: Readonly<Record<GamepadAction, string>> = Object.freeze({
  trickLeft: 'Drift / trick (left)',
  trickRight: 'Drift / trick (right)',
  fire: 'Fire pickup',
  boost: 'Boost',
})

export type GamepadBindings = Record<GamepadAction, number>

export const DEFAULT_GAMEPAD_BINDINGS: Readonly<GamepadBindings> = Object.freeze({
  trickLeft: 4, // LB / L1
  trickRight: 5, // RB / R1
  // Fire + boost relocated off the bumpers so L1/R1 own the trick
  // channel. Face buttons X / Y avoid A (which already drives
  // throttle) and B (emergency brake).
  fire: 2, // X / Square
  boost: 3, // Y / Triangle
})

const GAMEPAD_BUTTON_LABEL: Readonly<Record<number, string>> = Object.freeze({
  0: 'A / Cross',
  1: 'B / Circle',
  2: 'X / Square',
  3: 'Y / Triangle',
  4: 'LB / L1',
  5: 'RB / R1',
  6: 'LT / L2',
  7: 'RT / R2',
  8: 'Back / Share',
  9: 'Start / Options',
  10: 'L3 (stick click)',
  11: 'R3 (stick click)',
  12: 'D-pad Up',
  13: 'D-pad Down',
  14: 'D-pad Left',
  15: 'D-pad Right',
  16: 'Home / Guide',
})

export function formatGamepadButton(index: number | null): string {
  if (index === null) return '—'
  return GAMEPAD_BUTTON_LABEL[index] ?? `Button ${index}`
}

export function cloneKeyboardBindings(src: KeyboardBindings): KeyboardBindings {
  const out = {} as KeyboardBindings
  for (const action of KEYBOARD_ACTIONS) {
    const b = src[action]
    out[action] = { primary: b.primary, secondary: b.secondary }
  }
  return out
}

export function cloneGamepadBindings(src: GamepadBindings): GamepadBindings {
  const out = {} as GamepadBindings
  for (const action of GAMEPAD_ACTIONS) {
    out[action] = src[action]
  }
  return out
}

export function defaultKeyboardBindings(): KeyboardBindings {
  return cloneKeyboardBindings(DEFAULT_KEYBOARD_BINDINGS as KeyboardBindings)
}

export function defaultGamepadBindings(): GamepadBindings {
  return cloneGamepadBindings(DEFAULT_GAMEPAD_BINDINGS as GamepadBindings)
}

/** Lookup helper used by tests + the rebind modal. */
export function findKeyboardSlot(
  code: string,
  bindings: KeyboardBindings,
): { action: KeyboardAction; slot: 'primary' | 'secondary' } | null {
  for (const action of KEYBOARD_ACTIONS) {
    const b = bindings[action]
    if (b.primary === code) return { action, slot: 'primary' }
    if (b.secondary === code) return { action, slot: 'secondary' }
  }
  return null
}

export function findGamepadAction(index: number, bindings: GamepadBindings): GamepadAction | null {
  for (const action of GAMEPAD_ACTIONS) {
    if (bindings[action] === index) return action
  }
  return null
}

/** Assigns `code` as `action`'s primary key with **swap semantics**:
 *
 *  - If `code` is already bound to a different action's primary, that
 *    action receives `action`'s old primary in return — no action is
 *    left unreachable by an accidental rebind.
 *  - If `code` is bound only as a secondary on some action, that
 *    secondary is cleared (each code lives in exactly one slot).
 *  - Re-assigning the same code to the same action is a no-op. */
export function assignKeyboardPrimary(
  bindings: KeyboardBindings,
  action: KeyboardAction,
  code: string,
): KeyboardBindings {
  const out = cloneKeyboardBindings(bindings)
  if (out[action].primary === code) return out
  const previous = out[action].primary
  // Find current holder.
  for (const a of KEYBOARD_ACTIONS) {
    if (a === action) continue
    if (out[a].primary === code) {
      // Swap: give the previous holder our old primary so they remain
      // reachable. (The old secondary is left alone — if it collides
      // with the new primary below, it gets cleared in the next pass.)
      out[a].primary = previous
    }
    if (out[a].secondary === code) {
      // Secondary collision — just drop it.
      out[a].secondary = null
    }
  }
  // Clear our own secondary if it equals the new primary (within-action
  // duplicate).
  if (out[action].secondary === code) out[action].secondary = null
  out[action].primary = code
  return out
}

export function assignGamepadBinding(
  bindings: GamepadBindings,
  action: GamepadAction,
  index: number,
): GamepadBindings {
  const out = cloneGamepadBindings(bindings)
  if (out[action] === index) return out
  const previous = out[action]
  for (const a of GAMEPAD_ACTIONS) {
    if (a !== action && out[a] === index) out[a] = previous
  }
  out[action] = index
  return out
}

/** Tolerant parser for persisted KeyboardBindings — drops malformed
 *  entries silently, falls back to defaults for anything missing. */
export function parseKeyboardBindings(input: unknown): KeyboardBindings {
  const out = defaultKeyboardBindings()
  if (!input || typeof input !== 'object') return out
  const rec = input as Record<string, unknown>
  for (const action of KEYBOARD_ACTIONS) {
    const entry = rec[action]
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.primary === 'string' && e.primary.length > 0) {
      out[action].primary = e.primary
    }
    if (typeof e.secondary === 'string' && e.secondary.length > 0) {
      out[action].secondary = e.secondary
    } else if (e.secondary === null) {
      out[action].secondary = null
    }
  }
  return out
}

export function parseGamepadBindings(input: unknown): GamepadBindings {
  const out = defaultGamepadBindings()
  if (!input || typeof input !== 'object') return out
  const rec = input as Record<string, unknown>
  for (const action of GAMEPAD_ACTIONS) {
    const v = rec[action]
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 32) {
      out[action] = v
    }
  }
  return out
}

/** Pretty-print a KeyboardEvent.code for the rebind UI / Controls chip. */
export function formatKeyCode(code: string | null): string {
  if (!code) return '—'
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return `Numpad ${code.slice(6)}`
  if (code.startsWith('Arrow')) return `${code.slice(5)} arrow`
  const SPECIAL: Readonly<Record<string, string>> = Object.freeze({
    Space: 'Space',
    ShiftLeft: 'Left Shift',
    ShiftRight: 'Right Shift',
    ControlLeft: 'Left Ctrl',
    ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt',
    AltRight: 'Right Alt',
    MetaLeft: 'Left Meta',
    MetaRight: 'Right Meta',
    Enter: 'Enter',
    Tab: 'Tab',
    Escape: 'Esc',
    Backspace: 'Backspace',
    CapsLock: 'Caps Lock',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
  })
  return SPECIAL[code] ?? code
}
