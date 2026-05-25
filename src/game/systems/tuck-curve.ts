// ── Tuck sweet-spot ───────────────────────────────────────────────────
// The snowboarder's downhill duck, folded into the SAME nose-down gesture
// the dive-aid reads (`diveAmount = max(-intent.pitch, 0)`, which also
// sinks ride height via DIVE_HOVER_HEIGHT_MIN_MUL). Tuck has no button:
// lean the nose forward and the bike tucks.
//
// The payoff is a sweet spot, not a floor-it. The factor ramps 0→1 as the
// nose-down lean climbs to TUCK_SWEET_SPOT, then winds back DOWN past it —
// crossing zero and bottoming out at TUCK_SCRAPE_FLOOR at full deflection,
// where the dive-aid has the belly skimming the deck. So a feathered lean
// (just shy of "too far") is fastest; jamming the nose down scrapes and
// the negative factor inverts the cap/drag multipliers into a penalty.
// Sweet spot sits high (0.8) so it lines up with "about to scrape", giving
// the input a satisfying edge to ride.
//
// Pure + dependency-free on purpose: pinned by tests/unit/tuck-sweet-spot
// and consumed by the making-of "Tuning the Feel" demo, which imports it
// directly so the article can't drift from the shipped curve.
export const TUCK_SWEET_SPOT = 0.8
export const TUCK_SCRAPE_FLOOR = -0.5

/** Signed tuck factor from nose-down lean (`max(-intent.pitch, 0)`, 0..1).
 *  0 at neutral, +1 at the sweet spot, negative past it (belly-scrape
 *  penalty), TUCK_SCRAPE_FLOOR at full nose-down. */
export function tuckFactor(forwardPitch: number): number {
  const d = forwardPitch <= 0 ? 0 : forwardPitch >= 1 ? 1 : forwardPitch
  if (d <= TUCK_SWEET_SPOT) return d / TUCK_SWEET_SPOT
  const over = (d - TUCK_SWEET_SPOT) / (1 - TUCK_SWEET_SPOT)
  return 1 + (TUCK_SCRAPE_FLOOR - 1) * over
}
