/**
 * Accessibility HUD palette — colorblind-aware swatches for the
 * minimap dots, start-gate, and any other render layer that paints
 * gameplay-meaningful color directly to canvas.
 *
 * Pure data module — no DOM, no side effects. The live wiring is in
 * `accessibility-service.ts` which reads `playerSettings.colorblindMode`
 * and returns the palette of the moment. Render systems subscribe to
 * `onAccessibilityChange` to repaint baked layers when the mode flips
 * mid-session.
 *
 * Design notes — each non-'off' palette ships hand-picked safe colors
 * rather than computing simulated swatches at runtime (a) so we can
 * pick high-luminance values that read well on the game's dark water
 * backdrop and (b) so we can collapse the red/green-distinguishable
 * pairs (warning vs success, leader vs opponent) onto axes the named
 * deficiency CAN distinguish — yellow vs blue for deut/protan, red vs
 * cyan for tritan. Each color choice carries a one-line comment about
 * what it replaces and why.
 */

export type ColorblindMode = 'off' | 'deuteranopia' | 'protanopia' | 'tritanopia'

export type HudPalette = {
  /** Local player's minimap dot — ringed, larger. */
  player: string
  /** Current race leader's minimap dot — slightly larger than opponents. */
  leader: string
  /** Default opponent minimap dot. */
  opponent: string
  /** Next-checkpoint highlight ring on the minimap; any "you must do
   *  this" callout color. */
  warning: string
  /** Positive feedback color — tutorial cleared, lap PB. */
  success: string
  /** Neutral info color — splines, lane hints. */
  info: string
  /** "Bad outcome" pill color — leader-gap deficits, low health. */
  danger: string
}

export const DEFAULT_PALETTE: HudPalette = {
  player: '#ffcc66', // current ship value — warm amber against the dark water
  leader: '#ff5577', // current ship value — magenta against the cool field
  opponent: '#88aaff', // current ship value — pale cool blue
  warning: '#ff9933', // current ship value — orange "do this" ring
  success: '#66ffaa', // current ship value — mint green, paired with warning
  info: '#66ddff', // current ship value — cyan splines
  danger: '#ff4477', // current ship value — magenta-red gap warning
}

/** Hand-picked palettes per colorblind mode. Each palette swaps the
 *  channel pairs the named deficiency can't separate so the gameplay
 *  meaning stays legible. */
export const COLORBLIND_PALETTES: Record<ColorblindMode, HudPalette> = {
  off: DEFAULT_PALETTE,
  // Deuteranopia (green-blind) — collapse green→yellow; lift contrast
  // along the blue↔yellow axis the cone pair can still resolve.
  deuteranopia: {
    player: '#ffd166', // warm yellow — high luma, distinct from leader's white
    leader: '#ffffff', // pure white — leader pops via luminance, not hue
    opponent: '#3399ff', // saturated blue — orthogonal to the player's yellow
    warning: '#ff8800', // deep orange — replaces red-orange that would mute
    success: '#3366ff', // royal blue — replaces green; pairs against warning's orange on blue↔yellow
    info: '#66ccff', // softer blue for splines, distinct from opponent's saturated blue
    danger: '#ffcc00', // amber — distinct from warning's orange via luma
  },
  // Protanopia (red-blind) — same axis as deuteranopia in practice but
  // luminance of long-wavelength hues drops; bias choices brighter.
  protanopia: {
    player: '#ffe066', // brighter yellow — protanopia darkens reds more
    leader: '#ffffff', // pure white — same luma trick as deut
    opponent: '#2288ff', // saturated blue — high contrast to the yellow player
    warning: '#ffaa33', // brighter orange — protanopes lose red luma
    success: '#3355ee', // deep blue — orthogonal to warning along yellow↔blue
    info: '#66ccff', // soft blue spline color
    danger: '#ffd83a', // gold-amber — separated from warning by luma
  },
  // Tritanopia (blue-blind) — collapse along blue↔yellow; lift contrast
  // on the red↔cyan / magenta↔green axes that remain resolvable.
  tritanopia: {
    player: '#ff5566', // warm red — tritanopes see this distinctly from leader's magenta
    leader: '#ffffff', // white — uses luminance, sidesteps hue collapse
    opponent: '#33cccc', // cyan — orthogonal to player's red on the red↔cyan axis
    warning: '#ff3333', // saturated red — replaces the orange that flattens toward pink
    success: '#33cccc', // cyan — pairs against warning's red on the resolvable axis
    info: '#cccccc', // neutral gray for splines so blue/yellow info ambiguity is avoided
    danger: '#ff66cc', // magenta — orthogonal to warning's red via the resolvable axis
  },
}

/** Resolve the live palette for the given mode. Defensive against
 *  unknown strings (returns the default palette so a corrupted blob
 *  doesn't crash the HUD). */
export function paletteFor(mode: ColorblindMode): HudPalette {
  return COLORBLIND_PALETTES[mode] ?? DEFAULT_PALETTE
}
