/**
 * Gamepad normalization layer (src/engine/input/pad-profiles.ts).
 *
 * Pins the two behaviors that make the 2026 Steam Controller (and the
 * Steam Deck's built-in pad in Desktop-Mode browsers) playable:
 *
 *   1. Raw hid-steam layouts remap to W3C standard order — face
 *      buttons, D-pad, Start, and the analog triggers land where
 *      `gamepadIntent` / menu nav expect them, with the grips and
 *      Quick Access exposed as bindable extras at 17+.
 *   2. Active-pad selection prefers the most recently used connected
 *      pad instead of blindly reading index 0, so phantom wireless-
 *      receiver slots can't shadow the real controller.
 *
 * The raw index tables mirror what browsers derive from the Linux
 * hid-steam driver (buttons by ascending keycode, axes by ascending
 * ABS code) — see the derivation comment in pad-profiles.ts. If the
 * kernel driver ever changes its capability set, these fixtures are
 * the place that documents the assumption.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gamepadIntent } from '@/engine/input/gamepad'
import {
  type GamepadLike,
  normalizeGamepad,
  parseGamepadVendorProduct,
  selectActiveGamepad,
} from '@/engine/input/pad-profiles'

// ---- fixtures -----------------------------------------------------------

/** Raw button indices on a 2026 Steam Controller as browsers expose it
 *  (joydev order of the hid-steam capability set). */
const RAW2026 = {
  LPAD_CLICK: 0,
  RPAD_CLICK: 1,
  QUICK_ACCESS: 2,
  A: 3,
  B: 4,
  X: 5,
  Y: 6,
  L1: 7,
  R1: 8,
  L2_CLICK: 9,
  R2_CLICK: 10,
  VIEW: 11,
  MENU: 12,
  STEAM: 13,
  L3: 14,
  R3: 15,
  DPAD_UP: 16,
  DPAD_DOWN: 17,
  DPAD_LEFT: 18,
  DPAD_RIGHT: 19,
  GRIP_L4: 20,
  GRIP_R4: 21,
  GRIP_L5: 22,
  GRIP_R5: 23,
} as const

/** Raw axis indices ditto. Triggers rest at −1, full pull +1; note the
 *  right trigger (ABS_HAT2X) sorts before the left (ABS_HAT2Y). */
const RAW2026_AXIS = { LX: 0, LY: 1, RX: 2, RY: 3, RT: 8, LT: 9 } as const

type MutablePad = {
  id: string
  mapping: string
  axes: number[]
  buttons: { pressed: boolean; value: number }[]
  connected: boolean
  timestamp: number
}

function steam2026Pad(id = 'Steam Controller (Vendor: 28de Product: 1302)'): MutablePad {
  return {
    id,
    mapping: '',
    axes: [0, 0, 0, 0, 0, 0, 0, 0, -1, -1],
    buttons: Array.from({ length: 24 }, () => ({ pressed: false, value: 0 })),
    connected: true,
    timestamp: 0,
  }
}

function press(pad: MutablePad, rawIndex: number): void {
  pad.buttons[rawIndex] = { pressed: true, value: 1 }
}

// ---- id parsing ---------------------------------------------------------

describe('parseGamepadVendorProduct', () => {
  it('parses the Chromium id format', () => {
    expect(parseGamepadVendorProduct('Steam Controller (Vendor: 28de Product: 1302)')).toEqual({
      vendor: '28de',
      product: '1302',
    })
  })

  it('parses the Chromium STANDARD GAMEPAD variant + uppercase hex', () => {
    expect(
      parseGamepadVendorProduct('Xbox pad (STANDARD GAMEPAD Vendor: 045E Product: 028E)'),
    ).toEqual({ vendor: '045e', product: '028e' })
  })

  it('parses the Firefox id format', () => {
    expect(parseGamepadVendorProduct('28de-1304-Wireless Steam Controller')).toEqual({
      vendor: '28de',
      product: '1304',
    })
  })

  it('returns null for ids without vendor/product info', () => {
    expect(parseGamepadVendorProduct('Some Mystery Pad')).toBeNull()
  })
})

// ---- normalization ------------------------------------------------------

describe('normalizeGamepad — 2026 Steam Controller raw layout', () => {
  it.each([
    ['wired', 'Steam Controller (Vendor: 28de Product: 1302)'],
    ['bluetooth', 'Steam Controller (Vendor: 28de Product: 1303)'],
    ['puck', 'Wireless Steam Controller (Vendor: 28de Product: 1304)'],
    ['puck rev B', 'Wireless Steam Controller (Vendor: 28de Product: 1305)'],
    ['firefox id', '28de-1302-Steam Controller'],
    ['steam deck built-in', 'Steam Deck (Vendor: 28de Product: 1205)'],
  ])('recognizes the %s id', (_label, id) => {
    expect(normalizeGamepad(steam2026Pad(id)).layout).toBe('steam-raw')
  })

  it('maps face buttons, Start, and the D-pad to standard slots', () => {
    const pad = steam2026Pad()
    press(pad, RAW2026.A)
    press(pad, RAW2026.B)
    press(pad, RAW2026.MENU)
    press(pad, RAW2026.DPAD_UP)
    press(pad, RAW2026.DPAD_RIGHT)
    press(pad, RAW2026.STEAM)
    const n = normalizeGamepad(pad)
    expect(n.buttons[0]?.pressed).toBe(true) // A
    expect(n.buttons[1]?.pressed).toBe(true) // B
    expect(n.buttons[9]?.pressed).toBe(true) // Start
    expect(n.buttons[12]?.pressed).toBe(true) // D-pad up
    expect(n.buttons[15]?.pressed).toBe(true) // D-pad right
    expect(n.buttons[16]?.pressed).toBe(true) // Guide
    // The raw pad-click at index 0 must NOT read as A.
    expect(pad.buttons[RAW2026.LPAD_CLICK]?.pressed).toBe(false)
  })

  it('does not read the left touchpad click as A (the raw index-0 trap)', () => {
    const pad = steam2026Pad()
    press(pad, RAW2026.LPAD_CLICK)
    const n = normalizeGamepad(pad)
    expect(n.buttons[0]?.pressed).toBe(false)
    expect(n.buttons[22]?.pressed).toBe(true) // surfaces as an extra instead
  })

  it('derives analog trigger values from the rest-at-−1 axes', () => {
    const pad = steam2026Pad()
    pad.axes[RAW2026_AXIS.RT] = 1 // full pull
    pad.axes[RAW2026_AXIS.LT] = -0.5 // quarter pull
    const n = normalizeGamepad(pad)
    expect(n.buttons[7]?.value).toBeCloseTo(1) // RT
    expect(n.buttons[7]?.pressed).toBe(true)
    expect(n.buttons[6]?.value).toBeCloseTo(0.25) // LT
    expect(n.buttons[6]?.pressed).toBe(true)
  })

  it('reads resting triggers as fully released', () => {
    const n = normalizeGamepad(steam2026Pad())
    expect(n.buttons[6]?.value).toBe(0)
    expect(n.buttons[7]?.value).toBe(0)
  })

  it('treats an exactly-zero trigger axis as released (uninitialized-axis guard)', () => {
    const pad = steam2026Pad()
    pad.axes[RAW2026_AXIS.RT] = 0 // backend that reports 0 until first touch
    const n = normalizeGamepad(pad)
    expect(n.buttons[7]?.value).toBe(0)
    expect(n.buttons[7]?.pressed).toBe(false)
  })

  it('folds the digital full-press trigger clicks into slots 6/7', () => {
    const pad = steam2026Pad()
    press(pad, RAW2026.R2_CLICK)
    const n = normalizeGamepad(pad)
    expect(n.buttons[7]?.pressed).toBe(true)
    expect(n.buttons[7]?.value).toBe(1)
  })

  it('exposes grips + Quick Access as bindable extras at 17+', () => {
    const pad = steam2026Pad()
    press(pad, RAW2026.GRIP_L4)
    press(pad, RAW2026.GRIP_R5)
    press(pad, RAW2026.QUICK_ACCESS)
    const n = normalizeGamepad(pad)
    expect(n.buttons[17]?.pressed).toBe(true) // L4
    expect(n.buttons[20]?.pressed).toBe(true) // R5
    expect(n.buttons[21]?.pressed).toBe(true) // Quick access
  })

  it('passes the stick axes through in place (they already match standard)', () => {
    const pad = steam2026Pad()
    pad.axes[RAW2026_AXIS.LX] = 0.7
    pad.axes[RAW2026_AXIS.LY] = -0.6
    pad.axes[RAW2026_AXIS.RX] = 0.3
    pad.axes[RAW2026_AXIS.RY] = 0.2
    const n = normalizeGamepad(pad)
    expect(n.axes).toEqual([0.7, -0.6, 0.3, 0.2])
  })
})

describe('normalizeGamepad — 2015 Steam Controller raw layout', () => {
  it('remaps the smaller capability set (A at raw 2, triggers on axes 6/7)', () => {
    const pad: MutablePad = {
      id: 'Wireless Steam Controller (Vendor: 28de Product: 1142)',
      mapping: '',
      axes: [0, 0, 0, 0, 0, 0, -1, -1],
      buttons: Array.from({ length: 21 }, () => ({ pressed: false, value: 0 })),
      connected: true,
      timestamp: 0,
    }
    pad.buttons[2] = { pressed: true, value: 1 } // raw A
    pad.buttons[19] = { pressed: true, value: 1 } // left grip
    pad.axes[6] = 1 // RT full pull
    const n = normalizeGamepad(pad)
    expect(n.layout).toBe('steam-raw-2015')
    expect(n.buttons[0]?.pressed).toBe(true) // A
    expect(n.buttons[17]?.pressed).toBe(true) // grip extra
    expect(n.buttons[7]?.value).toBeCloseTo(1) // RT
  })
})

describe('normalizeGamepad — passthrough paths', () => {
  it('passes browser-standard pads through untouched (Steam Virtual Gamepad)', () => {
    const pad: GamepadLike = {
      id: 'Steam Virtual Gamepad (STANDARD GAMEPAD Vendor: 28de Product: 11ff)',
      mapping: 'standard',
      axes: [0.1, 0.2, 0.3, 0.4],
      buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === 0, value: i === 0 ? 1 : 0 })),
    }
    const n = normalizeGamepad(pad)
    expect(n.layout).toBe('standard')
    expect(n.axes).toEqual([0.1, 0.2, 0.3, 0.4])
    expect(n.buttons[0]?.pressed).toBe(true)
    expect(n.buttons).toHaveLength(17)
  })

  it('passes unknown non-standard pads through raw (status quo behavior)', () => {
    const pad: GamepadLike = {
      id: 'Flight Stick 9000 (Vendor: 1234 Product: abcd)',
      mapping: '',
      axes: [0.5],
      buttons: [{ pressed: true, value: 1 }],
    }
    const n = normalizeGamepad(pad)
    expect(n.layout).toBe('raw')
    expect(n.buttons[0]?.pressed).toBe(true)
  })

  it('tolerates bare {axes, buttons} mocks with no id/mapping metadata', () => {
    const n = normalizeGamepad({ axes: [0, 0], buttons: [{ pressed: false, value: 0 }] })
    expect(n.layout).toBe('raw')
    expect(n.id).toBe('')
  })
})

// ---- active-pad selection -----------------------------------------------

describe('selectActiveGamepad', () => {
  const mk = (over: Partial<MutablePad>): MutablePad => ({
    ...steam2026Pad(),
    ...over,
  })

  it('skips null slots and buttonless phantom entries', () => {
    const real = mk({ id: 'real' })
    const phantom = mk({ id: 'phantom', buttons: [] })
    expect(selectActiveGamepad([null, phantom, real])).toBe(real)
  })

  it('prefers the most recently used pad over index order', () => {
    const idle = mk({ id: 'idle', timestamp: 100 })
    const active = mk({ id: 'active', timestamp: 2000 })
    expect(selectActiveGamepad([idle, active])).toBe(active)
  })

  it('falls back to the earliest slot on ties (single-pad boot state)', () => {
    const a = mk({ id: 'a', timestamp: 5 })
    const b = mk({ id: 'b', timestamp: 5 })
    expect(selectActiveGamepad([a, b])).toBe(a)
  })

  it('skips explicitly disconnected pads', () => {
    const gone = mk({ id: 'gone', connected: false, timestamp: 9999 })
    const here = mk({ id: 'here', timestamp: 1 })
    expect(selectActiveGamepad([gone, here])).toBe(here)
  })

  it('returns null when nothing usable is connected', () => {
    expect(selectActiveGamepad([null, undefined])).toBeNull()
  })
})

// ---- end-to-end through gamepadIntent -----------------------------------

describe('gamepadIntent on a raw 2026 Steam Controller', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function install(pad: MutablePad): void {
    vi.stubGlobal('navigator', { getGamepads: () => [pad] })
  }

  it('throttles from the analog right trigger (raw axis 8)', () => {
    const pad = steam2026Pad()
    pad.axes[RAW2026_AXIS.RT] = 1
    install(pad)
    expect(gamepadIntent().throttle).toBeCloseTo(1)
  })

  it('throttles from A (raw button 3), not the touchpad click at raw 0', () => {
    const pad = steam2026Pad()
    press(pad, RAW2026.A)
    install(pad)
    expect(gamepadIntent().throttle).toBe(1)

    const padClickOnly = steam2026Pad()
    press(padClickOnly, RAW2026.LPAD_CLICK)
    install(padClickOnly)
    expect(gamepadIntent().throttle).toBe(0)
  })

  it('steers from the left stick and brakes/reverses from the left trigger', () => {
    const pad = steam2026Pad()
    pad.axes[RAW2026_AXIS.LX] = 1
    pad.axes[RAW2026_AXIS.LT] = 1 // full pull
    install(pad)
    const i = gamepadIntent()
    expect(i.steer).toBeGreaterThan(0.9)
    expect(i.brake).toBeCloseTo(1)
    expect(i.throttle).toBeCloseTo(-1) // LT-only reverse
  })

  it('fires default action bindings through the remap (X=fire, L1/R1=tricks)', () => {
    const pad = steam2026Pad()
    press(pad, RAW2026.X)
    press(pad, RAW2026.L1)
    press(pad, RAW2026.R1)
    install(pad)
    const i = gamepadIntent()
    expect(i.fire).toBe(true)
    expect(i.trickLeft).toBe(true)
    expect(i.trickRight).toBe(true)
  })

  it('reads the real controller even when a phantom slot sits at index 0', () => {
    const phantom = { ...steam2026Pad(), buttons: [] as { pressed: boolean; value: number }[] }
    const real = steam2026Pad()
    press(real, RAW2026.A)
    vi.stubGlobal('navigator', { getGamepads: () => [phantom, real] })
    expect(gamepadIntent().throttle).toBe(1)
  })
})
