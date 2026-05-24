/**
 * Input bindings — swap-on-rebind semantics + persistence + defaults.
 *
 * Covers:
 *  - Default tables are the expected WASD + arrows mapping (status doc
 *    calls out the Q-dives / E-lifts inversion — the test pins it).
 *  - `assignKeyboardPrimary` swaps the previous holder so no action is
 *    left unreachable; secondary collisions get cleared.
 *  - `assignGamepadBinding` swaps with the previous value when moving
 *    a button to a different action.
 *  - `parseKeyboardBindings` / `parseGamepadBindings` are tolerant —
 *    malformed payloads fall back to defaults.
 *  - `playerSettings` round-trips the bindings through localStorage.
 *  - `setKeyboardBindings` does not alias the frozen defaults.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assignGamepadBinding,
  assignKeyboardPrimary,
  cloneKeyboardBindings,
  DEFAULT_GAMEPAD_BINDINGS,
  DEFAULT_KEYBOARD_BINDINGS,
  defaultGamepadBindings,
  defaultKeyboardBindings,
  findGamepadAction,
  findKeyboardSlot,
  formatGamepadButton,
  formatKeyCode,
  parseGamepadBindings,
  parseKeyboardBindings,
} from '../../src/engine/input/bindings'
import {
  DEFAULT_PLAYER_SETTINGS,
  loadPlayerSettings,
  playerSettings,
  resetKeyboardBindings,
  setGamepadBindings,
  setKeyboardBindings,
} from '../../src/engine/player-settings'

function resetPlayerSettings(): void {
  Object.assign(playerSettings, DEFAULT_PLAYER_SETTINGS)
  playerSettings.keyboardBindings = defaultKeyboardBindings()
  playerSettings.gamepadBindings = defaultGamepadBindings()
}

describe('default keyboard bindings', () => {
  it('matches the WASD + arrows convention', () => {
    expect(DEFAULT_KEYBOARD_BINDINGS.throttleForward).toEqual({
      primary: 'KeyW',
      secondary: 'ArrowUp',
    })
    expect(DEFAULT_KEYBOARD_BINDINGS.steerLeft).toEqual({ primary: 'KeyA', secondary: 'ArrowLeft' })
    expect(DEFAULT_KEYBOARD_BINDINGS.boost).toEqual({
      primary: 'ShiftLeft',
      secondary: 'ShiftRight',
    })
  })

  it('respects the Q-dives / E-lifts convention (M9.18)', () => {
    // intent.pitch positive = nose UP / lift. Status doc explicitly
    // documents the keyboard convention as Q = down (dive), E = up
    // (lift). The defaults must match.
    expect(DEFAULT_KEYBOARD_BINDINGS.pitchUp).toEqual({ primary: 'KeyE', secondary: null })
    expect(DEFAULT_KEYBOARD_BINDINGS.pitchDown).toEqual({ primary: 'KeyQ', secondary: null })
  })

  it('defaultKeyboardBindings returns a fresh deep copy', () => {
    const a = defaultKeyboardBindings()
    a.throttleForward.primary = 'KeyZ'
    const b = defaultKeyboardBindings()
    expect(b.throttleForward.primary).toBe('KeyW')
  })
})

describe('assignKeyboardPrimary', () => {
  it('swaps the previous holder when reassigning across actions', () => {
    const next = assignKeyboardPrimary(defaultKeyboardBindings(), 'fire', 'KeyW')
    // fire took KeyW; throttleForward got fire's old primary (Space).
    expect(next.fire.primary).toBe('KeyW')
    expect(next.throttleForward.primary).toBe('Space')
    // Secondary on throttleForward survives the swap because nothing
    // else collided with ArrowUp.
    expect(next.throttleForward.secondary).toBe('ArrowUp')
  })

  it('clears the secondary holder when its slot collides with the new primary', () => {
    const next = assignKeyboardPrimary(defaultKeyboardBindings(), 'fire', 'ArrowUp')
    // throttleForward had ArrowUp as secondary — now cleared.
    expect(next.throttleForward.secondary).toBeNull()
    expect(next.fire.primary).toBe('ArrowUp')
  })

  it('is a no-op when the same code is assigned to the same action', () => {
    const before = defaultKeyboardBindings()
    const after = assignKeyboardPrimary(before, 'throttleForward', 'KeyW')
    expect(after).toEqual(before)
    // Doesn't mutate the input.
    expect(after).not.toBe(before)
  })

  it('moves within an action without leaving a duplicate', () => {
    // throttleForward starts {primary:'KeyW', secondary:'ArrowUp'}; bind
    // primary to ArrowUp — should clear the secondary so the same key
    // isn't in two slots of the same action.
    const next = assignKeyboardPrimary(defaultKeyboardBindings(), 'throttleForward', 'ArrowUp')
    expect(next.throttleForward.primary).toBe('ArrowUp')
    expect(next.throttleForward.secondary).toBeNull()
  })

  it('does not mutate the input table', () => {
    const before = defaultKeyboardBindings()
    const snapshot = JSON.parse(JSON.stringify(before))
    assignKeyboardPrimary(before, 'fire', 'KeyZ')
    expect(before).toEqual(snapshot)
  })
})

describe('findKeyboardSlot', () => {
  it('locates primary + secondary holders', () => {
    const b = defaultKeyboardBindings()
    expect(findKeyboardSlot('KeyW', b)).toEqual({ action: 'throttleForward', slot: 'primary' })
    expect(findKeyboardSlot('ArrowUp', b)).toEqual({ action: 'throttleForward', slot: 'secondary' })
    expect(findKeyboardSlot('Backquote', b)).toBeNull()
  })
})

describe('assignGamepadBinding', () => {
  it('swaps with the previous action when reassigning', () => {
    // Defaults: fire=2 (X), boost=3 (Y). Bind fire to button 3 — boost
    // should pick up fire's old button (2).
    const next = assignGamepadBinding(defaultGamepadBindings(), 'fire', 3)
    expect(next.fire).toBe(3)
    expect(next.boost).toBe(2)
  })

  it('is a no-op when assigning the same index', () => {
    const before = defaultGamepadBindings()
    const after = assignGamepadBinding(before, 'fire', 2)
    expect(after).toEqual(before)
  })

  it('does not mutate the input', () => {
    const before = defaultGamepadBindings()
    assignGamepadBinding(before, 'fire', 0)
    expect(before).toEqual(DEFAULT_GAMEPAD_BINDINGS)
  })
})

describe('findGamepadAction', () => {
  it('returns the action bound to a given button index', () => {
    const b = defaultGamepadBindings()
    expect(findGamepadAction(2, b)).toBe('fire')
    expect(findGamepadAction(3, b)).toBe('boost')
    expect(findGamepadAction(4, b)).toBe('trickLeft')
    expect(findGamepadAction(5, b)).toBe('trickRight')
    expect(findGamepadAction(1, b)).toBeNull()
  })
})

describe('parseKeyboardBindings', () => {
  it('returns defaults on garbage input', () => {
    expect(parseKeyboardBindings(null)).toEqual(DEFAULT_KEYBOARD_BINDINGS)
    expect(parseKeyboardBindings(42)).toEqual(DEFAULT_KEYBOARD_BINDINGS)
    expect(parseKeyboardBindings('not an object')).toEqual(DEFAULT_KEYBOARD_BINDINGS)
  })

  it('keeps unknown actions as defaults but applies valid ones', () => {
    const parsed = parseKeyboardBindings({
      fire: { primary: 'KeyZ', secondary: null },
      pitchUp: { primary: 'KeyR', secondary: 'KeyT' },
      // ignored — not a known action
      something: { primary: 'KeyX', secondary: null },
    })
    expect(parsed.fire).toEqual({ primary: 'KeyZ', secondary: null })
    expect(parsed.pitchUp).toEqual({ primary: 'KeyR', secondary: 'KeyT' })
    // Unchanged.
    expect(parsed.steerLeft).toEqual(DEFAULT_KEYBOARD_BINDINGS.steerLeft)
  })

  it('preserves explicit null secondaries (intentional unbind)', () => {
    const parsed = parseKeyboardBindings({
      boost: { primary: 'ShiftLeft', secondary: null },
    })
    expect(parsed.boost.secondary).toBeNull()
  })

  it('drops malformed entries silently', () => {
    const parsed = parseKeyboardBindings({
      fire: 'just a string',
      pitchUp: { primary: 42 },
    })
    expect(parsed.fire).toEqual(DEFAULT_KEYBOARD_BINDINGS.fire)
    expect(parsed.pitchUp).toEqual(DEFAULT_KEYBOARD_BINDINGS.pitchUp)
  })
})

describe('parseGamepadBindings', () => {
  it('returns defaults on garbage input', () => {
    expect(parseGamepadBindings(null)).toEqual(DEFAULT_GAMEPAD_BINDINGS)
  })

  it('accepts valid integer button indices', () => {
    const parsed = parseGamepadBindings({ fire: 3, boost: 0 })
    expect(parsed.fire).toBe(3)
    expect(parsed.boost).toBe(0)
  })

  it('rejects out-of-range / non-integer values', () => {
    const parsed = parseGamepadBindings({ fire: 99, boost: 1.5 })
    expect(parsed.fire).toBe(DEFAULT_GAMEPAD_BINDINGS.fire)
    expect(parsed.boost).toBe(DEFAULT_GAMEPAD_BINDINGS.boost)
  })
})

describe('formatKeyCode + formatGamepadButton', () => {
  it('strips the KeyCode prefix for letter keys', () => {
    expect(formatKeyCode('KeyW')).toBe('W')
    expect(formatKeyCode('KeyA')).toBe('A')
  })

  it('produces readable labels for arrows + specials', () => {
    expect(formatKeyCode('ArrowUp')).toBe('Up arrow')
    expect(formatKeyCode('ArrowLeft')).toBe('Left arrow')
    expect(formatKeyCode('ShiftLeft')).toBe('Left Shift')
    expect(formatKeyCode('Space')).toBe('Space')
    expect(formatKeyCode('Backquote')).toBe('`')
  })

  it('falls back to the raw code for unknown values', () => {
    expect(formatKeyCode('MediaTrackNext')).toBe('MediaTrackNext')
  })

  it('returns "—" for null', () => {
    expect(formatKeyCode(null)).toBe('—')
    expect(formatGamepadButton(null)).toBe('—')
  })

  it('labels known standard-mapping buttons', () => {
    expect(formatGamepadButton(0)).toMatch(/A\b/)
    expect(formatGamepadButton(5)).toMatch(/RB/)
    expect(formatGamepadButton(99)).toBe('Button 99')
  })
})

describe('playerSettings — bindings round-trip', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem('hoverbike.playerSettings.v1')
    }
    resetPlayerSettings()
  })
  afterEach(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem('hoverbike.playerSettings.v1')
    }
    resetPlayerSettings()
  })

  it('persists keyboard bindings across a load cycle', () => {
    if (typeof window === 'undefined' || !window.localStorage) return
    const swapped = assignKeyboardPrimary(playerSettings.keyboardBindings, 'fire', 'KeyZ')
    setKeyboardBindings(swapped)
    // Stomp in-memory.
    playerSettings.keyboardBindings = defaultKeyboardBindings()
    loadPlayerSettings()
    expect(playerSettings.keyboardBindings.fire.primary).toBe('KeyZ')
    // Swap moved old fire primary onto whatever held the new key — not
    // an assertion here, just that the round-trip survived.
  })

  it('persists gamepad bindings across a load cycle', () => {
    if (typeof window === 'undefined' || !window.localStorage) return
    setGamepadBindings({ fire: 3, boost: 1, trickLeft: 4, trickRight: 5 })
    playerSettings.gamepadBindings = defaultGamepadBindings()
    loadPlayerSettings()
    expect(playerSettings.gamepadBindings.fire).toBe(3)
    expect(playerSettings.gamepadBindings.boost).toBe(1)
  })

  it('resetKeyboardBindings restores defaults', () => {
    setKeyboardBindings(assignKeyboardPrimary(playerSettings.keyboardBindings, 'fire', 'KeyZ'))
    resetKeyboardBindings()
    expect(playerSettings.keyboardBindings).toEqual(DEFAULT_KEYBOARD_BINDINGS)
  })

  it('setKeyboardBindings clones — does not alias the frozen defaults', () => {
    const next = cloneKeyboardBindings(playerSettings.keyboardBindings)
    next.fire.primary = 'KeyZ'
    setKeyboardBindings(next)
    // Subsequently mutating the source shouldn't leak.
    next.fire.primary = 'KeyA'
    expect(playerSettings.keyboardBindings.fire.primary).toBe('KeyZ')
    // And the original frozen DEFAULT must still be intact.
    expect(DEFAULT_KEYBOARD_BINDINGS.fire.primary).toBe('Space')
  })
})
