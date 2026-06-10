/**
 * Wind streamline shape generator — the path a wind-trail stroke traces.
 *
 * Produces the Wind-Waker-style "illustrated gust" curve: a run that trends
 * along the wind direction with a gentle hand-drawn meander, sometimes
 * carrying one full 2π curl (the calligraphic loop-de-loop) part-way along.
 * The curve is built in intrinsic form — heading angle θ(s) integrated over
 * arc length — so the loop is a guaranteed clean circle inscribed in the
 * path rather than an emergent (and occasionally degenerate) wiggle.
 *
 * Pure math: no Three, no DOM, RNG injected — deterministic per seed and
 * unit-testable headlessly (`tests/unit/wind-streamline.test.ts`). World
 * concerns (anchoring near the camera, terrain/water clearance) belong to
 * the caller (`wind-trails.ts`); this module only shapes the curve, returned
 * with its midpoint at the origin so the caller can anchor it precisely.
 */

export type WindStreamlineSpec = {
  /** Wind direction in world XZ (normalized internally; (1,0) if ~zero). */
  dirX: number
  dirZ: number
  /** Curve arc length in metres. */
  lengthM: number
  /** Segment count — `points` holds `segments + 1` positions. */
  segments: number
  /** Chance [0..1] this streamline carries a full 2π curl. */
  loopChance: number
  /** Curl radius range (m). Clamped down if the curve is too short to fit. */
  loopRadiusMin: number
  loopRadiusMax: number
  /** Curl-plane tilt range (radians): 0 = flat curl in the horizontal plane
   *  (read from above), π/2 = upright curl in the vertical plane (read from
   *  the side / chase cam). */
  tiltMin: number
  tiltMax: number
  /** Heading-meander amplitude (radians). ~0.4 = a relaxed hand-drawn sway;
   *  values ≳1 start folding the run back on itself. */
  wander: number
  /** Vertical bob amplitude (m) added on top of the curl-plane lateral. */
  bobAmp: number
}

export type WindStreamline = {
  /** `(segments+1)·3` world-axis positions, curve midpoint at the origin. */
  points: Float32Array
  /** The inserted curl (centre as 0..1 of arc length), or null. */
  loop: { at: number; radius: number } | null
}

const smooth01 = (t: number): number => {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

export function generateWindStreamline(
  rng: () => number,
  spec: WindStreamlineSpec,
): WindStreamline {
  const n = Math.max(2, Math.floor(spec.segments))
  const L = Math.max(1e-3, spec.lengthM)
  const ds = L / n

  // Heading meander — two incommensurate sine bands with random phase so no
  // two streamlines sway alike, amplitudes bounded by `wander`.
  const wAmp1 = spec.wander * (0.55 + 0.45 * rng())
  const wAmp2 = spec.wander * 0.4 * rng()
  const wFreq1 = (Math.PI * 2) / (L * (0.65 + 0.55 * rng()))
  const wFreq2 = (Math.PI * 2) / (L * (0.22 + 0.2 * rng()))
  const wPh1 = rng() * Math.PI * 2
  const wPh2 = rng() * Math.PI * 2

  // Optional curl: the heading sweeps an extra ±2π across an arc window of
  // length 2πr (an inscribed circle of radius r). The sweep is smoothstepped
  // so the path eases into and out of the curl — the brush tightening then
  // releasing — rather than snapping to constant curvature.
  let loop: WindStreamline['loop'] = null
  let loopStart = 0
  let loopArc = 0
  let loopSign = 1
  if (rng() < spec.loopChance) {
    // Largest curl that still fits inside the middle ~56% of the run.
    const rFit = (0.56 * L) / (2 * Math.PI)
    const rMax = Math.min(spec.loopRadiusMax, rFit)
    if (rMax >= spec.loopRadiusMin * 0.6) {
      const rMin = Math.min(spec.loopRadiusMin, rMax)
      const r = rMin + rng() * (rMax - rMin)
      loopArc = 2 * Math.PI * r
      loopStart = 0.22 * L + rng() * (0.78 * L - loopArc - 0.22 * L)
      loopSign = rng() < 0.5 ? -1 : 1
      loop = { at: (loopStart + loopArc / 2) / L, radius: r }
    }
  }

  // Integrate the heading through the curl plane's 2D frame (u along-wind,
  // v lateral). θ is a direct function of s, so the run always trends +u and
  // only the curl window folds it back.
  const pts2 = new Float32Array((n + 1) * 2)
  let px = 0
  let py = 0
  for (let i = 1; i <= n; i++) {
    const s = (i - 0.5) * ds
    let th = wAmp1 * Math.sin(s * wFreq1 + wPh1) + wAmp2 * Math.sin(s * wFreq2 + wPh2)
    if (loop) th += loopSign * Math.PI * 2 * smooth01((s - loopStart) / loopArc)
    px += Math.cos(th) * ds
    py += Math.sin(th) * ds
    pts2[i * 2] = px
    pts2[i * 2 + 1] = py
  }

  // Embed into world axes: u runs along the wind, v along the tilted curl
  // plane's lateral (horizontal-perp blended toward world-up), plus a gentle
  // vertical bob so even curl-free runs aren't ruler-flat.
  const dl = Math.hypot(spec.dirX, spec.dirZ)
  const ax = dl > 1e-6 ? spec.dirX / dl : 1
  const az = dl > 1e-6 ? spec.dirZ / dl : 0
  const tilt = spec.tiltMin + rng() * (spec.tiltMax - spec.tiltMin)
  const ct = Math.cos(tilt)
  const st = Math.sin(tilt)
  // (-az, 0, ax) is the horizontal perpendicular; blending toward (0,1,0)
  // keeps the axis unit-length since the two are orthogonal.
  const lx = -az * ct
  const ly = st
  const lz = ax * ct
  const bobPh = rng() * Math.PI * 2
  const bobFreq = (Math.PI * 2) / (L * (0.5 + 0.45 * rng()))

  const out = new Float32Array((n + 1) * 3)
  for (let i = 0; i <= n; i++) {
    const u = pts2[i * 2]!
    const v = pts2[i * 2 + 1]!
    const bob = spec.bobAmp * Math.sin(i * ds * bobFreq + bobPh)
    out[i * 3 + 0] = ax * u + lx * v
    out[i * 3 + 1] = ly * v + bob
    out[i * 3 + 2] = az * u + lz * v
  }

  // Midpoint → origin so the caller can anchor the curve's visual centre.
  const mid = (n >> 1) * 3
  const mx = out[mid]!
  const my = out[mid + 1]!
  const mz = out[mid + 2]!
  for (let i = 0; i <= n; i++) {
    out[i * 3 + 0] = out[i * 3 + 0]! - mx
    out[i * 3 + 1] = out[i * 3 + 1]! - my
    out[i * 3 + 2] = out[i * 3 + 2]! - mz
  }
  return { points: out, loop }
}
