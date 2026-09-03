/**
 * Gamepad normalization: every consumer reads controllers through
 * `activeGamepad()` instead of `navigator.getGamepads()[0]`, which fixes
 * two real-world failures:
 *
 * 1. **Non-standard mappings.** The race/menu code indexes buttons and
 *    axes in W3C "standard" order, but a pad the browser has no remap
 *    table for arrives with `mapping: ""` and hardware-order controls.
 *    The 2026 Steam Controller (and the Steam Deck's built-in pad in
 *    Desktop-Mode browsers) is the headline case: Chromium ships no
 *    Valve remap, so on Linux/SteamOS the pad reaches us in the raw
 *    `hid-steam` kernel-driver order — the left touchpad click lands on
 *    button 0 where the game expects A, the analog triggers live on
 *    axes 8/9 instead of buttons 6/7, and the D-pad sits at buttons
 *    16–19. Result before this layer: steering worked, throttle and
 *    every menu button dead. We detect Valve pads by the vendor/product
 *    hex in `Gamepad.id` and remap to standard order via the profile
 *    tables below.
 *
 * 2. **Blind `[0]` indexing.** `getGamepads()` keeps `null` holes and
 *    stale slots; wireless receivers can enumerate phantom entries, so
 *    the real pad isn't always index 0. `selectActiveGamepad` prefers
 *    the most recently *used* pad (highest `timestamp`) among connected,
 *    button-bearing entries.
 *
 * What this deliberately does NOT solve: on Windows/macOS a Steam
 * Controller without Steam running is keyboard+mouse ("lizard mode")
 * with its game inputs on a vendor HID page browsers can't read — no
 * Gamepad API entry exists to remap. Players there go through Steam
 * Input (launch the browser via Steam, or set the controller's desktop
 * layout to Gamepad), which presents the already-standard "Steam
 * Virtual Gamepad". See docs/steam-deck.md → "Steam Controller (2026)".
 *
 * Raw-order provenance (don't guess at these — they're derived):
 * Linux `hid-steam` registers the evdev capabilities; browsers number
 * buttons by ascending keycode from BTN_JOYSTICK (0x120) and axes by
 * ascending ABS code. Keycodes: BTN_THUMB 0x121, BTN_THUMB2 0x122,
 * BTN_BASE 0x126, BTN_A..BTN_THUMBR 0x130–0x13e, BTN_DPAD_* 0x220–0x223,
 * BTN_GRIPL/R/L2/R2 0x224–0x227. ABS: X 0, Y 1, RX 3, RY 4, HAT0X/Y
 * 16/17 (left pad), HAT1X/Y 18/19 (right pad), HAT2X 20 (RIGHT trigger),
 * HAT2Y 21 (LEFT trigger — yes, right sorts before left). Triggers are
 * registered 0..32767 so joydev rescales them to rest at −1, full pull
 * +1. The driver pre-negates stick Y, so up = −1 matches standard.
 */

/** Structural gamepad shape — everything beyond the state arrays is
 *  optional so unit tests (and older browsers) can hand in bare
 *  `{ axes, buttons }` objects and get raw-passthrough behavior. */
export type GamepadLike = {
  id?: string
  mapping?: string
  axes: readonly number[]
  buttons: readonly { pressed: boolean; value: number }[]
  connected?: boolean
  timestamp?: number
  index?: number
}

export type NormalizedButton = { pressed: boolean; value: number }

/** How the normalized view was produced — surfaced in the debug overlay
 *  so a playtester can see at a glance whether their pad was recognized. */
export type PadLayout = 'standard' | 'steam-raw' | 'steam-raw-2015' | 'raw'

export type NormalizedGamepad = {
  id: string
  layout: PadLayout
  /** Standard order: 0=LX, 1=LY, 2=RX, 3=RY (up/left negative). */
  axes: number[]
  /** Standard order 0–16, plus profile extras (grips etc.) at 17+. */
  buttons: NormalizedButton[]
}

/**
 * Vendor/product hex from a `Gamepad.id`. Chromium formats ids as
 * `"Name (Vendor: 28de Product: 1302)"` (with `STANDARD GAMEPAD `
 * prepended when it remapped); Firefox uses `"28de-1302-Name"`.
 * Case-insensitive; returns null when neither form matches.
 */
export function parseGamepadVendorProduct(id: string): { vendor: string; product: string } | null {
  const chrome = /vendor:\s*([0-9a-f]{4})\s+product:\s*([0-9a-f]{4})/i.exec(id)
  if (chrome?.[1] && chrome[2]) {
    return { vendor: chrome[1].toLowerCase(), product: chrome[2].toLowerCase() }
  }
  const firefox = /^([0-9a-f]{4})-([0-9a-f]{4})-/i.exec(id)
  if (firefox?.[1] && firefox[2]) {
    return { vendor: firefox[1].toLowerCase(), product: firefox[2].toLowerCase() }
  }
  return null
}

/** One standard-slot's source in the raw arrays. A slot may read a raw
 *  button, a raw axis (rest −1 → 0, full +1 → 1, for triggers), or both
 *  (analog trigger OR'd with its digital full-press click). */
type SlotSource = { btn?: number; axis?: number }

type PadProfile = {
  layout: PadLayout
  /** Index = normalized button slot. Holes yield released buttons. */
  buttons: readonly (SlotSource | null)[]
  /** Index = normalized axis slot; value = raw axis index. */
  axes: readonly number[]
}

/**
 * Steam Controller (2026, all three connections) + Steam Deck built-in,
 * as exposed raw by `hid-steam` (see header for the derivation).
 *
 * Raw buttons: 0 L-pad click, 1 R-pad click, 2 Quick Access, 3 A, 4 B,
 * 5 X, 6 Y, 7 L1, 8 R1, 9 L2 full-press, 10 R2 full-press, 11 View,
 * 12 Menu, 13 Steam, 14 L3, 15 R3, 16–19 D-pad U/D/L/R, 20 L4 grip,
 * 21 R4 grip, 22 L5 grip, 23 R5 grip.
 * Raw axes: 0 LX, 1 LY, 2 RX, 3 RY, 4/5 L-pad, 6/7 R-pad,
 * 8 RT analog, 9 LT analog.
 */
const STEAM_RAW: PadProfile = {
  layout: 'steam-raw',
  buttons: [
    { btn: 3 }, // 0  A
    { btn: 4 }, // 1  B
    { btn: 5 }, // 2  X
    { btn: 6 }, // 3  Y
    { btn: 7 }, // 4  LB / L1
    { btn: 8 }, // 5  RB / R1
    { axis: 9, btn: 9 }, // 6  LT — analog HAT2Y + digital full-press
    { axis: 8, btn: 10 }, // 7  RT — analog HAT2X + digital full-press
    { btn: 11 }, // 8  Back / View
    { btn: 12 }, // 9  Start / Menu
    { btn: 14 }, // 10 L3
    { btn: 15 }, // 11 R3
    { btn: 16 }, // 12 D-pad up
    { btn: 17 }, // 13 D-pad down
    { btn: 18 }, // 14 D-pad left
    { btn: 19 }, // 15 D-pad right
    { btn: 13 }, // 16 Guide / Steam
    { btn: 20 }, // 17 L4 (grip)
    { btn: 21 }, // 18 R4 (grip)
    { btn: 22 }, // 19 L5 (grip)
    { btn: 23 }, // 20 R5 (grip)
    { btn: 2 }, // 21 Quick access
    { btn: 0 }, // 22 Left pad click
    { btn: 1 }, // 23 Right pad click
  ],
  axes: [0, 1, 2, 3],
}

/**
 * Steam Controller (2015). Same driver, smaller capability set: no
 * Quick Access, no lower grips, and ABS_RX/RY is the right *touchpad*
 * (it has no right stick) — which still makes a serviceable camera-look
 * on normalized axes 2/3.
 *
 * Raw buttons: 0 L-pad click, 1 R-pad click, 2 A, 3 B, 4 X, 5 Y, 6 LB,
 * 7 RB, 8 LT full-press, 9 RT full-press, 10 Back, 11 Start, 12 Steam,
 * 13 L3, 14 R3 (registered but absent on the hardware), 15–18 D-pad,
 * 19 L grip, 20 R grip.
 * Raw axes: 0 LX, 1 LY, 2/3 R-pad, 4/5 L-pad, 6 RT analog, 7 LT analog.
 */
const STEAM_RAW_2015: PadProfile = {
  layout: 'steam-raw-2015',
  buttons: [
    { btn: 2 }, // 0  A
    { btn: 3 }, // 1  B
    { btn: 4 }, // 2  X
    { btn: 5 }, // 3  Y
    { btn: 6 }, // 4  LB
    { btn: 7 }, // 5  RB
    { axis: 7, btn: 8 }, // 6  LT
    { axis: 6, btn: 9 }, // 7  RT
    { btn: 10 }, // 8  Back
    { btn: 11 }, // 9  Start
    { btn: 13 }, // 10 L3
    { btn: 14 }, // 11 R3 (dead slot on real hardware)
    { btn: 15 }, // 12 D-pad up
    { btn: 16 }, // 13 D-pad down
    { btn: 17 }, // 14 D-pad left
    { btn: 18 }, // 15 D-pad right
    { btn: 12 }, // 16 Guide / Steam
    { btn: 19 }, // 17 L grip
    { btn: 20 }, // 18 R grip
  ],
  axes: [0, 1, 2, 3],
}

const VALVE_VENDOR = '28de'

/** Product → profile. 1302 wired SC2, 1303 SC2 Bluetooth LE, 1304/1305
 *  the SC2 wireless pucks, 1205 Steam Deck built-in; 1102 wired SC1,
 *  1142 SC1 dongle. (The Steam Virtual Gamepad, 28de:11ff, never lands
 *  here — Steam Input presents it as XInput, so browsers report
 *  `mapping: "standard"` and we pass it through above the profile
 *  lookup.) */
const VALVE_PROFILES: Readonly<Record<string, PadProfile>> = Object.freeze({
  '1302': STEAM_RAW,
  '1303': STEAM_RAW,
  '1304': STEAM_RAW,
  '1305': STEAM_RAW,
  '1205': STEAM_RAW,
  '1102': STEAM_RAW_2015,
  '1142': STEAM_RAW_2015,
})

function profileFor(id: string): PadProfile | null {
  const vp = parseGamepadVendorProduct(id)
  if (!vp || vp.vendor !== VALVE_VENDOR) return null
  return VALVE_PROFILES[vp.product] ?? null
}

/**
 * Rescale a rest-at-−1 trigger axis to [0, 1]. Exactly 0 is treated as
 * released: joydev delivers initial-state events so a resting trigger
 * reads −1 from the first frame, but if a backend ever reports 0 until
 * first touch, the naive (v+1)/2 would show a phantom half-pull — and a
 * genuinely held trigger never sits at a noiseless exact 0.
 */
function triggerFromAxis(v: number): number {
  if (v === 0) return 0
  return Math.min(1, Math.max(0, (v + 1) / 2))
}

const TRIGGER_PRESSED_THRESHOLD = 0.1

/**
 * Standard-order view of one pad. Browser-mapped pads pass through
 * untouched (extra buttons beyond 16 included, e.g. Elite paddles);
 * known Valve raw pads go through their profile; anything else passes
 * through raw — identical to the pre-normalization behavior.
 */
export function normalizeGamepad(pad: GamepadLike): NormalizedGamepad {
  const id = pad.id ?? ''
  const profile = pad.mapping === 'standard' ? null : profileFor(id)
  if (!profile) {
    return {
      id,
      layout: pad.mapping === 'standard' ? 'standard' : 'raw',
      axes: [...pad.axes],
      buttons: pad.buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
    }
  }

  const buttons: NormalizedButton[] = profile.buttons.map((src) => {
    if (!src) return { pressed: false, value: 0 }
    let value = 0
    let pressed = false
    if (src.axis !== undefined) {
      value = triggerFromAxis(pad.axes[src.axis] ?? 0)
      pressed = value > TRIGGER_PRESSED_THRESHOLD
    }
    if (src.btn !== undefined) {
      const raw = pad.buttons[src.btn]
      if (raw?.pressed) {
        pressed = true
        value = Math.max(value, raw.value > 0 ? raw.value : 1)
      }
    }
    return { pressed, value }
  })

  return {
    id,
    layout: profile.layout,
    axes: profile.axes.map((i) => pad.axes[i] ?? 0),
    buttons,
  }
}

/**
 * Pick the pad the player is actually holding: among connected entries
 * that have buttons at all, the one with the newest `timestamp` (it
 * advances on every state change, so phantom receiver slots never win
 * once the real pad moves). Ties — including the all-idle boot state —
 * fall to the earliest slot, which preserves the old `[0]` behavior on
 * single-pad setups. Mock pads without the metadata fields are treated
 * as connected with timestamp 0.
 */
export function selectActiveGamepad<T extends GamepadLike>(
  pads: readonly (T | null | undefined)[],
): T | null {
  let best: T | null = null
  let bestStamp = -1
  for (const p of pads) {
    if (!p || p.connected === false || p.buttons.length === 0) continue
    const stamp = p.timestamp ?? 0
    if (best === null || stamp > bestStamp) {
      best = p
      bestStamp = stamp
    }
  }
  return best
}

/** All connected pads, normalized — for capture flows that listen to
 *  every controller rather than just the active one. */
export function normalizedGamepads(): NormalizedGamepad[] {
  const pads = navigator.getGamepads?.() ?? []
  const out: NormalizedGamepad[] = []
  for (const p of pads) {
    if (!p || p.connected === false || p.buttons.length === 0) continue
    out.push(normalizeGamepad(p))
  }
  return out
}

/** The one call every per-frame consumer makes: active pad, standard
 *  order, or null when no usable pad is connected. */
export function activeGamepad(): NormalizedGamepad | null {
  const pad = selectActiveGamepad(navigator.getGamepads?.() ?? [])
  return pad ? normalizeGamepad(pad) : null
}
