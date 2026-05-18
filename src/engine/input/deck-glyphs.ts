/**
 * Steam Deck button-glyph labels.
 *
 * The W3C standard gamepad mapping (`navigator.getGamepads()[i].buttons`)
 * uses generic indices — button 0 is "primary action", 1 is "secondary"
 * etc. Different controllers paint them differently: Xbox shows A/B/X/Y,
 * PlayStation shows ✕/●/■/▲, Switch shows the swapped A/B/X/Y, and the
 * Steam Deck paints its own A/B/X/Y but adds the L4/L5/R4/R5 paddles
 * and two trackpads with no W3C index.
 *
 * `glyphFor(buttonIndex, source)` returns the human-readable label for
 * the rebind menu. `source` is the platform context:
 *
 *   - 'standard' — the default Xbox-style labels (used today)
 *   - 'deck'     — Steam Deck Gaming Mode (Steam Input maps to virtual
 *                  Xbox, but we want to paint Deck-native glyphs in the
 *                  rebind UI so the player isn't confused)
 *   - 'ps'       — PlayStation (DualSense / DualShock 4)
 *   - 'switch'   — Switch Pro Controller
 *
 * The rebind menu currently uses `bindings.formatGamepadButton(idx)` which
 * always returns the standard label. Wiring this glyph table in is a
 * follow-up: detect platform via gamepad.id pattern + the steam-deck
 * detection helper, pick the right table, return the right label. See
 * docs/steam-deck.md "Input" section.
 *
 * No runtime cost today — this module is pure data. Import only fires
 * when the rebind menu adds the platform-aware path.
 */

export type GlyphSource = 'standard' | 'deck' | 'ps' | 'switch'

type GlyphTable = Readonly<Record<number, string>>

const STANDARD: GlyphTable = Object.freeze({
  0: 'A',
  1: 'B',
  2: 'X',
  3: 'Y',
  4: 'LB',
  5: 'RB',
  6: 'LT',
  7: 'RT',
  8: 'Back',
  9: 'Start',
  10: 'L3',
  11: 'R3',
  12: 'D-pad ↑',
  13: 'D-pad ↓',
  14: 'D-pad ←',
  15: 'D-pad →',
  16: 'Guide',
})

// Steam Deck Gaming Mode reports button indices the same as the
// W3C standard mapping (Steam Input emulates an Xbox 360 pad), but the
// player sees the Deck's own glyphs printed on the chassis. The labels
// here match what's etched: A/B/X/Y on the face, L1/L2/R1/R2 on the
// shoulders + triggers, View/Menu on the small bar buttons. The L4/L5/
// R4/R5 paddles + L/R trackpads have no W3C index — they're remappable
// via Steam Input but invisible to navigator.getGamepads. The table
// stops at index 16 to match.
const DECK: GlyphTable = Object.freeze({
  0: 'A',
  1: 'B',
  2: 'X',
  3: 'Y',
  4: 'L1',
  5: 'R1',
  6: 'L2',
  7: 'R2',
  8: 'View',
  9: 'Menu',
  10: 'L3',
  11: 'R3',
  12: 'D-pad ↑',
  13: 'D-pad ↓',
  14: 'D-pad ←',
  15: 'D-pad →',
  16: 'Steam',
})

const PS: GlyphTable = Object.freeze({
  0: '✕',
  1: '●',
  2: '■',
  3: '▲',
  4: 'L1',
  5: 'R1',
  6: 'L2',
  7: 'R2',
  8: 'Share',
  9: 'Options',
  10: 'L3',
  11: 'R3',
  12: 'D-pad ↑',
  13: 'D-pad ↓',
  14: 'D-pad ←',
  15: 'D-pad →',
  16: 'PS',
})

// Switch swaps A↔B and X↔Y vs the Xbox convention. Worth handling
// because the Steam Deck plays nice with Switch Pro pads.
const SWITCH: GlyphTable = Object.freeze({
  0: 'B',
  1: 'A',
  2: 'Y',
  3: 'X',
  4: 'L',
  5: 'R',
  6: 'ZL',
  7: 'ZR',
  8: '-',
  9: '+',
  10: 'L3',
  11: 'R3',
  12: 'D-pad ↑',
  13: 'D-pad ↓',
  14: 'D-pad ←',
  15: 'D-pad →',
  16: 'Home',
})

const TABLES: Readonly<Record<GlyphSource, GlyphTable>> = Object.freeze({
  standard: STANDARD,
  deck: DECK,
  ps: PS,
  switch: SWITCH,
})

export function glyphFor(buttonIndex: number, source: GlyphSource = 'standard'): string {
  const table = TABLES[source] ?? STANDARD
  return table[buttonIndex] ?? `Button ${buttonIndex}`
}

/**
 * Best-effort glyph source from a `Gamepad.id` string. Pattern matches
 * the ID substrings each platform emits — falls through to 'standard'
 * when nothing matches.
 */
export function glyphSourceForGamepadId(id: string): GlyphSource {
  const lower = id.toLowerCase()
  if (lower.includes('steam') && (lower.includes('deck') || lower.includes('virtual'))) {
    return 'deck'
  }
  if (lower.includes('dualsense') || lower.includes('dualshock') || lower.includes('playstation')) {
    return 'ps'
  }
  if (lower.includes('pro controller') || lower.includes('nintendo')) {
    return 'switch'
  }
  return 'standard'
}
