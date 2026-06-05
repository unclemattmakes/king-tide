// ── Tuck sweet-spot ───────────────────────────────────────────────────
// The snowboarder's downhill duck, folded into the SAME nose-down gesture
// the dive-aid reads (`diveAmount = max(-intent.pitch, 0)`, which also
// sinks ride height via DIVE_HOVER_HEIGHT_MIN_MUL). Tuck has no button:
// lean the nose forward and the bike tucks.
//
// The payoff is a sweet spot, not a floor-it. The factor ramps 0→1 as the
// nose-down lean climbs to the sweet spot, then winds back DOWN past it —
// crossing zero and bottoming out at TUCK_SCRAPE_FLOOR at full deflection,
// where the dive-aid has the belly skimming the deck. So a feathered lean
// (just shy of "too far") is fastest; jamming the nose down scrapes and
// the negative factor inverts the cap/drag multipliers into a penalty.
//
// ── Slope-aware sweet spot ────────────────────────────────────────────
// The flat-ground sweet spot sits high (0.8) so it lines up with "about to
// scrape". But on a DOWNSLOPE the chassis is already pitched nose-down (the
// grounded pitch PD tracks the surface tangent) and the dive clamp eats the
// rest of the player's nose-down travel — so a fixed 0.8 notch asks for a
// gesture the bike can't execute, and the reward marches into the scrape
// band off input that never reached the chassis. `slopeAwareSweetSpot`
// slides the notch toward the feathered end as the (anticipated, forward)
// downslope steepens, so the rewarded lean always matches the pitch the
// slope actually leaves room for. Read the slope AHEAD (the bow probe is
// speed-anticipated) and the notch pre-shifts for the wave face you're
// about to drop into — pure motocross "match the terrain".
//
// Pure + dependency-free on purpose: pinned by tests/unit/tuck-sweet-spot
// and consumed by the making-of "Tuning the Feel" demo, which imports it
// directly so the article can't drift from the shipped curve.
export const TUCK_SWEET_SPOT = 0.8
export const TUCK_SCRAPE_FLOOR = -0.5

/** Lowest the slope-shifted sweet spot is allowed to slide to (on the
 *  steepest descents). Kept well clear of 0 so the ramp-up zone never
 *  collapses — feathering still has room to read as skill, not a hair
 *  trigger. */
export const TUCK_SWEET_SPOT_MIN = 0.4

/** Downhill surface pitch (radians, nose-down positive) at which the
 *  sweet-spot shift saturates at TUCK_SWEET_SPOT_MIN. ~28° covers the
 *  steep wave faces / SF-Seattle grades; steeper just stays pinned at the
 *  floor. */
export const SLOPE_TUCK_REF = (28 * Math.PI) / 180

/** Signed tuck factor from nose-down lean (`max(-intent.pitch, 0)`, 0..1).
 *  0 at neutral, +1 at the sweet spot, negative past it (belly-scrape
 *  penalty), TUCK_SCRAPE_FLOOR at full nose-down.
 *
 *  `sweetSpot` defaults to the flat-ground TUCK_SWEET_SPOT; pass the
 *  output of `slopeAwareSweetSpot` to make the peak track the slope. */
export function tuckFactor(forwardPitch: number, sweetSpot: number = TUCK_SWEET_SPOT): number {
  // Guard the curve against a degenerate sweet spot (div-by-zero at 0,
  // div-by-zero in the over-tuck term at 1). Valid shipped values
  // (0.4..0.8) pass through untouched.
  const s = sweetSpot <= 0 ? 1e-3 : sweetSpot >= 1 ? 0.999 : sweetSpot
  const d = forwardPitch <= 0 ? 0 : forwardPitch >= 1 ? 1 : forwardPitch
  if (d <= s) return d / s
  const over = (d - s) / (1 - s)
  return 1 + (TUCK_SCRAPE_FLOOR - 1) * over
}

/** Slope-shifted sweet-spot lean. `surfacePitchTarget` is the surface
 *  tangent attitude (`-atan(surfaceForwardSlope)`, nose-down/downhill
 *  positive). Flat ground / uphill returns the base TUCK_SWEET_SPOT; a
 *  downslope slides the sweet spot linearly toward TUCK_SWEET_SPOT_MIN,
 *  saturating at SLOPE_TUCK_REF. */
export function slopeAwareSweetSpot(surfacePitchTarget: number): number {
  const downhill = surfacePitchTarget > 0 ? surfacePitchTarget : 0
  const t = Math.min(downhill / SLOPE_TUCK_REF, 1)
  return TUCK_SWEET_SPOT - (TUCK_SWEET_SPOT - TUCK_SWEET_SPOT_MIN) * t
}
