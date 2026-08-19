/**
 * Per-slot rider jersey/suit palette — a deterministic colour per racer grid
 * slot so an 8-bike field reads as eight distinct riders instead of eight
 * clones of the bright-yellow mannequin.
 *
 * Pure data + a pure lookup. No Three.js, no ECS — the render side (rider
 * mannequin system) resolves a slot to a suit/trim/helmet triple and stamps it
 * onto each rider's meshes as a per-object tint (one shared material, one
 * pipeline — see rider-mannequin.ts). The tint MULTIPLIES the mannequin albedo,
 * exactly like the bike livery tint (bike-loader.ts `tintLivery`), so the values
 * here read as "jersey colour" on the shared mesh.
 *
 * Art direction (docs/art-direction.md): bold colour blocking, value carries the
 * read, warm-vs-cold contrast, "saturation hoarded on the subject" (TF2). These
 * seven hues are chosen for value separation and to read distinct at ~100 m
 * against turquoise water (the track water reference is ~#2E7E78). Saturation
 * sits a notch below the old uniform mannequin yellow so riders stop
 * out-shouting the bikes; the one yellow slot is deliberately desaturated
 * (mustard, not caution-tape).
 */

export type RiderPalette = {
  /** Suit / jersey base colour, 0xRRGGBB. Multiplies the mannequin albedo. */
  suit: number
  /** Secondary trim accent, 0xRRGGBB (shoulders/piping — reserved for a future
   *  two-tone stamp; kept in the triple so consumers have a coordinated accent
   *  without re-deriving one). */
  trim: number
  /** Helmet colour, 0xRRGGBB. */
  helmet: number
}

/**
 * AI/peer suit palette, indexed by 0-based palette slot. Seven entries cover the
 * 2x4 grid's seven AI slots (the player is slot 0 and is never coloured by this
 * table — the player keeps their own look). Ordered warm/cold-alternating so
 * adjacent grid rows contrast:
 *   0 coral red · 1 cobalt · 2 teal · 3 cream · 4 burnt orange · 5 violet · 6 seafoam
 */
export const RIDER_SUIT_PALETTE: readonly RiderPalette[] = Object.freeze([
  // coral red — warm, high value, pops off cool water.
  { suit: 0xe0533f, trim: 0xf2b3a6, helmet: 0x3a2320 },
  // cobalt — cold, deep, mid value.
  { suit: 0x2f5fc4, trim: 0x9fb6e8, helmet: 0x1a2440 },
  // teal — cold, but a green-shifted teal so it separates from the water's
  // blue-teal rather than blending into it.
  { suit: 0x2ba39a, trim: 0xa6e0da, helmet: 0x123330 },
  // cream — warm neutral, highest value; the light-jersey read.
  { suit: 0xe8d9a8, trim: 0xbfae7c, helmet: 0x4a4230 },
  // burnt orange — warm, lower value than coral so the two warms don't merge.
  { suit: 0xc9762c, trim: 0xe8b57e, helmet: 0x3a2812 },
  // violet — cold-warm hinge, mid-low value; the outlier hue that IDs fast.
  { suit: 0x7d4bb0, trim: 0xc3a6e0, helmet: 0x281a3a },
  // seafoam — cold, high-value green; distinct from both teal and cream.
  { suit: 0x6fc7a3, trim: 0xc0ead9, helmet: 0x1f3a2e },
])

/**
 * Resolve a racer grid slot to its rider palette.
 *
 * Slot convention matches the rest of boot: slot 0 is the player (pole), slots
 * 1..N are AI/peers. The player slot has no jersey override — it keeps the
 * shipped mannequin look — so `slot <= 0` returns `null`. AI/peer slots map onto
 * the seven-entry table, wrapping if the field ever exceeds seven (mirrors
 * `render-systems.ts` `aiColors`: `slot % length`).
 */
export function riderPaletteForSlot(slot: number): RiderPalette | null {
  if (!Number.isFinite(slot) || slot <= 0) return null
  const idx = (Math.floor(slot) - 1) % RIDER_SUIT_PALETTE.length
  return RIDER_SUIT_PALETTE[idx] ?? null
}
