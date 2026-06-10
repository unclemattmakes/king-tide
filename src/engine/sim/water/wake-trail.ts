/**
 * Bike wake trails — the recorded path history every bike's wake follows.
 *
 * Pure math — no Three.js, sim layer (ADR 0002). One {@link WakeTrail} per
 * bike records breadcrumbs along the ridden line (fed once per fixed step by
 * `wakeUpdateSystem`), and the wake profile is evaluated in TRAIL
 * coordinates: "behind" is arc-meters back along the path, "perp" the
 * lateral distance to the nearest trail segment. The wake therefore curves
 * with the line the bike actually rode, a jump leaves a real gap (per-point
 * strength bakes the airborne weight × speed gate at drop time), and a
 * stopped bike's wake age-fades in place.
 *
 * Both consumers evaluate the SAME profile against the SAME points:
 *  - CPU buoyancy — {@link sampleWakeFromTrail}, summed by `sampleHeight` /
 *    `sampleSurface` in wave-field.ts. The trailing rider FEELS the curved
 *    ridge ("jump my wake"), exactly where it is drawn.
 *  - GPU shader — `emitTrailScan` in `src/engine/render/water.ts` mirrors
 *    the scan + profile in TSL and renders the same trail points (uploaded
 *    as uniforms each frame). Any change to the profile here must move the
 *    shader with it; the constants below are the single source (the shader
 *    imports them — never re-declare literals).
 *
 * Determinism, rollback, replay: trails are pure functions of sim history
 * (fed per fixed step from rigid-body state on the deterministic field
 * clock), so lockstep peers and re-simulated replays reproduce them
 * bit-for-bit. They are deliberately NOT snapshotted: after a rollback /
 * replay seek / respawn the trail self-heals within one trail-span
 * (~2 s of riding) via the gap rules in {@link feedWakeTrail} — the wake is
 * a bounded feel garnish (≤ {@link WAKE_DISP_AMP} m), not position-critical
 * state, so snapshot/serialization bloat isn't worth it.
 */

// ---- Wake profile constants ------------------------------------------------
//
// These must EXACTLY match the values baked into the TSL shader in
// `src/engine/render/water.ts` (which imports them from here, via the
// wave-field re-exports). Any change here without a matching shader change
// desyncs visuals from buoyancy.

/** Peak vertical displacement of the wake's ridge, meters. The wake
 * appears as a real bump in the geometry, not just a foam stripe. */
export const WAKE_DISP_AMP = 0.6
/** Speed at which the wake starts to appear (m/s). */
export const WAKE_SPEED_LOW = 1.5
/** Speed at which the wake reaches full strength (m/s). */
export const WAKE_SPEED_HIGH = 8.0
/** Tan of the V-wake half-angle (V opens at this rate behind the bike). */
export const WAKE_HALF_ANGLE_TAN = 0.4
/** Width of the V-wake at the bike before it widens behind, meters. */
export const WAKE_BASE_WIDTH = 0.55
/** Half-width of the amplitude bell that rides along each V edge, meters.
 * The wake's height peaks AT the V boundary (real Kelvin-style diverging
 * wave look) rather than uniformly across the inside of the V. Anything
 * past this many meters from the boundary fades to zero. */
export const WAKE_EDGE_BELL_HALFWIDTH = 0.7
/** Longitudinal ramp-in (1 / meters). Gives the wake a soft start so it
 * doesn't punch up directly under the bike. */
export const WAKE_LONG_RAMP = 0.6
/** Longitudinal decay (1 / meters). Wake fades to ~e^-1 at 1/this distance
 * behind the bike. 0.04 → e-folds at ~25 m. */
export const WAKE_LONG_DECAY = 0.04
/** Transverse-wave wavenumber (rad / meter, M9.35). Real Kelvin wakes
 * have oscillating ridges along the path — the "scallops" behind a moving
 * boat. K = 0.7 → wavelength ≈ 9m, so ~3 visible scallops fit in the 25m
 * wake length. */
export const WAKE_TRANS_K = 0.7
/** Transverse-wave angular frequency (rad / s). 1.0 → period ≈ 6.3s,
 * a gentle scroll that makes the scallops feel alive without pulsing
 * distractingly. */
export const WAKE_TRANS_OMEGA = 1.0
/** Modulation amplitude (dimensionless multiplier, range 1 ± value).
 * 0.3 → wake amplitude varies between 0.7× and 1.3× of base across
 * each scallop period. */
export const WAKE_TRANS_AMP = 0.3
/** Age fade e-fold time, seconds. Arc decay handles the spatial falloff;
 * this dissolves the wake a slowed/stopped/airborne bike leaves behind. */
export const WAKE_AGE_TAU = 3.0

// ---- Trail recording constants ----------------------------------------------

/** Breadcrumbs kept per trail (oldest→newest ring). */
export const WAKE_TRAIL_HISTORY = 15
/** Shader uniform slots per trail: the history + 1 live head slot (the
 * bike's current position), so the GPU segment loop needs no special
 * head-segment branch. The render sizes its uniform blocks with this. */
export const WAKE_TRAIL_POINTS = WAKE_TRAIL_HISTORY + 1
/** Drop a breadcrumb every this many meters of XZ travel. 15 × 2 = 30 m of
 * recorded wake — past that the longitudinal decay has the tail near the
 * foam threshold anyway. 2 m keeps the ridge from showing polyline corners
 * in the tightest donut turns (chord error grows with spacing²). */
export const WAKE_TRAIL_SPACING = 2.0
/** Segments longer than this are skipped by both samplers: the gap an
 * airborne hop leaves, teleport breaks, and unfilled ring padding. 3× the
 * drop spacing leaves headroom for per-step drop overshoot. */
export const WAKE_TRAIL_MAX_SEG = WAKE_TRAIL_SPACING * 3
/** Head jumps up to this many meters keep the old trail (the flown
 * distance is added to the arc, so the old wake recedes + age-fades exactly
 * as if the bike rode away from it — correct for jumps). Beyond it is a
 * respawn / cross-map teleport: hard reset, the old wake is offscreen. */
export const WAKE_TRAIL_GAP_KEEP_MAX = 40
/** Trail pool cap — the race grid (player + 7 AI). Extra emitters evict the
 * stalest trail. */
export const MAX_WAKE_TRAILS = 8

/**
 * One bike's wake trail. Parallel flat arrays hold the breadcrumb ring
 * (`[0, count)` = oldest→newest); the live head is the bike's current
 * position. `arc` is cumulative ridden distance — `headArc − arc[i]` is how
 * far point i sits behind the bike, the profile's "behind" coordinate.
 * The AABB (+`cullReach`) is a cheap sampler reject, refit on every feed.
 */
export type WakeTrail = {
  /** Owning bike id (the ECS eid). -1 = never used. */
  id: number
  /** Live breadcrumbs in `[0, count)`. */
  count: number
  px: Float64Array
  pz: Float64Array
  arc: Float64Array
  dropT: Float64Array
  str: Float64Array
  headX: number
  headZ: number
  headArc: number
  headStr: number
  /** Field-clock stamp of the last feed — the head's dropTime. NOT advanced
   *  while the bike is airborne/absent, so an abandoned trail (head
   *  included) age-fades. Doubles as the eviction key. */
  headT: number
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  /** Widest lateral reach of the profile over the live span — AABB margin. */
  cullReach: number
}

export function createWakeTrail(): WakeTrail {
  return {
    id: -1,
    count: 0,
    px: new Float64Array(WAKE_TRAIL_HISTORY),
    pz: new Float64Array(WAKE_TRAIL_HISTORY),
    arc: new Float64Array(WAKE_TRAIL_HISTORY),
    dropT: new Float64Array(WAKE_TRAIL_HISTORY),
    str: new Float64Array(WAKE_TRAIL_HISTORY),
    headX: 0,
    headZ: 0,
    headArc: 0,
    headStr: 0,
    headT: 0,
    minX: 0,
    maxX: 0,
    minZ: 0,
    maxZ: 0,
    cullReach: 0,
  }
}

const smoothstep = (e0: number, e1: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return u * u * (3 - 2 * u)
}

/** Per-point deposit strength: airborne weight × speed gate, baked at drop
 *  time so a bike that slows keeps the fast wake it already laid. */
export function wakeDropStrength(weight: number, speed: number): number {
  return weight * smoothstep(WAKE_SPEED_LOW, WAKE_SPEED_HIGH, speed)
}

function hardResetTrail(tr: WakeTrail, id: number, x: number, z: number, s: number, time: number) {
  tr.id = id
  tr.count = 1
  tr.px[0] = x
  tr.pz[0] = z
  tr.arc[0] = 0
  tr.dropT[0] = time
  tr.str[0] = s
  tr.headX = x
  tr.headZ = z
  tr.headArc = 0
  tr.headStr = s
  tr.headT = time
  refitBounds(tr)
}

/** Find (or allocate, evicting the stalest) the trail owned by `id`. The
 *  trails array is the field's pool — capped at {@link MAX_WAKE_TRAILS}.
 *  Allocation order follows the caller's iteration order (the bitecs query),
 *  which is deterministic, so peers/replays build identical pools. */
export function acquireWakeTrail(
  trails: WakeTrail[],
  id: number,
  x: number,
  z: number,
  time: number,
): WakeTrail {
  for (const tr of trails) {
    if (tr.id === id) return tr
  }
  if (trails.length < MAX_WAKE_TRAILS) {
    const tr = createWakeTrail()
    hardResetTrail(tr, id, x, z, 0, time)
    trails.push(tr)
    return tr
  }
  let stalest = trails[0] as WakeTrail
  for (const tr of trails) {
    if (tr.headT < stalest.headT) stalest = tr
  }
  hardResetTrail(stalest, id, x, z, 0, time)
  return stalest
}

function refitBounds(tr: WakeTrail): void {
  let minX = tr.headX
  let maxX = tr.headX
  let minZ = tr.headZ
  let maxZ = tr.headZ
  for (let i = 0; i < tr.count; i++) {
    const x = tr.px[i] as number
    const z = tr.pz[i] as number
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  tr.minX = minX
  tr.maxX = maxX
  tr.minZ = minZ
  tr.maxZ = maxZ
  const span = tr.headArc - (tr.count > 0 ? (tr.arc[0] as number) : tr.headArc)
  tr.cullReach = WAKE_BASE_WIDTH + WAKE_HALF_ANGLE_TAN * span + WAKE_EDGE_BELL_HALFWIDTH + 0.5
}

/**
 * Advance one trail for this fixed step. Call ONLY while the bike is on /
 * near the surface (weight > the deposit threshold) — while airborne the
 * head stays frozen, the laid wake age-fades, and the landing arrives here
 * as a head gap:
 *
 *  - gap ≤ {@link WAKE_TRAIL_MAX_SEG}: normal riding — breadcrumbs drop
 *    every {@link WAKE_TRAIL_SPACING} meters along the line actually ridden.
 *  - MAX_SEG < gap ≤ {@link WAKE_TRAIL_GAP_KEEP_MAX}: a hop — the head
 *    advances across the gap with NO breadcrumbs in between; the over-long
 *    segment is skipped by both samplers (the visible gap in the wake) and
 *    the flown distance is counted into the arc so the pre-jump wake
 *    recedes behind the bike like any other wake.
 *  - gap > GAP_KEEP_MAX: respawn / teleport — hard reset.
 */
export function feedWakeTrail(
  tr: WakeTrail,
  x: number,
  z: number,
  weight: number,
  speed: number,
  time: number,
): void {
  const s = wakeDropStrength(weight, speed)
  if (tr.count === 0) {
    hardResetTrail(tr, tr.id, x, z, s, time)
    return
  }
  const gap = Math.hypot(x - tr.headX, z - tr.headZ)
  if (gap > WAKE_TRAIL_GAP_KEEP_MAX) {
    hardResetTrail(tr, tr.id, x, z, s, time)
    return
  }
  if (gap > WAKE_TRAIL_MAX_SEG) {
    // Hop landing: count the flown distance into the arc, then lay a single
    // landing breadcrumb. The newest→landing segment length equals the gap
    // (> MAX_SEG), so the samplers skip it — that segment IS the gap.
    const landingArc = (tr.arc[tr.count - 1] as number) + gap
    pushPoint(tr, x, z, landingArc, time, s)
    tr.headX = x
    tr.headZ = z
    tr.headArc = landingArc
    tr.headStr = s
    tr.headT = time
    refitBounds(tr)
    return
  }
  tr.headX = x
  tr.headZ = z
  tr.headStr = s
  tr.headT = time
  // Drop breadcrumbs every SPACING meters of travel. At a 60 Hz fixed step
  // this fires at most once per step (≤ ~0.6 m of travel); the loop exists
  // for completeness and is guard-capped.
  let guard = 0
  while (guard++ < WAKE_TRAIL_HISTORY) {
    const newest = tr.count - 1
    const nx = tr.px[newest] as number
    const nz = tr.pz[newest] as number
    const d = Math.hypot(x - nx, z - nz)
    if (d < WAKE_TRAIL_SPACING) break
    const f = WAKE_TRAIL_SPACING / d
    pushPoint(
      tr,
      nx + (x - nx) * f,
      nz + (z - nz) * f,
      (tr.arc[tr.count - 1] as number) + WAKE_TRAIL_SPACING,
      time,
      s,
    )
  }
  tr.headArc =
    (tr.arc[tr.count - 1] as number) +
    Math.hypot(x - (tr.px[tr.count - 1] as number), z - (tr.pz[tr.count - 1] as number))
  refitBounds(tr)
}

function pushPoint(tr: WakeTrail, x: number, z: number, arc: number, t: number, s: number): void {
  if (tr.count === WAKE_TRAIL_HISTORY) {
    for (let j = 0; j < WAKE_TRAIL_HISTORY - 1; j++) {
      tr.px[j] = tr.px[j + 1] as number
      tr.pz[j] = tr.pz[j + 1] as number
      tr.arc[j] = tr.arc[j + 1] as number
      tr.dropT[j] = tr.dropT[j + 1] as number
      tr.str[j] = tr.str[j + 1] as number
    }
    tr.count--
  }
  tr.px[tr.count] = x
  tr.pz[tr.count] = z
  tr.arc[tr.count] = arc
  tr.dropT[tr.count] = t
  tr.str[tr.count] = s
  tr.count++
}

export type WakeSampleOut = { y: number; dydx: number; dydz: number }

/**
 * Wake displacement (+ gradient) of one trail at world (x, z), time t.
 * Writes into `out`; zeroes it when the sample is out of range.
 *
 * Mirror of the TSL `emitTrailScan` + vertex wake block in water.ts — the
 * nearest CAPSULE segment of the polyline (history points + live head) wins,
 * then the Kelvin-style cross profile is evaluated in (behind, perp) trail
 * coordinates:
 *
 *   inside V (perp < width):   -cos(π·perp/width)  → trough at the axis,
 *                              ridge (+1) at the V boundary
 *   outside (width..+bell):    linear fade to 0
 *   amp = DISP_AMP · strength(drop) · ramp(behind) · decay(behind)
 *         · (1 + TRANS_AMP·sin(K·behind − Ω·t)) · exp(−age/τ)
 *
 * The gradient keeps the shader's inside-V approximation (lateral term
 * only, longitudinal cross-term dropped) so felt slopes match drawn shading.
 */
export function sampleWakeFromTrail(
  tr: WakeTrail,
  x: number,
  z: number,
  t: number,
  out: WakeSampleOut,
): void {
  out.y = 0
  out.dydx = 0
  out.dydz = 0
  if (tr.count === 0) return
  // Fully age-faded (abandoned) trail — matches the render's parked-cull.
  if (t - tr.headT > WAKE_AGE_TAU * 5) return
  // AABB reject — the overwhelmingly common case for buoyancy probes.
  const reach = tr.cullReach
  if (x < tr.minX - reach || x > tr.maxX + reach || z < tr.minZ - reach || z > tr.maxZ + reach) {
    return
  }

  // Nearest-capsule-segment scan: history pairs + the newest→head segment.
  let bestD2 = Number.POSITIVE_INFINITY
  let bestBehind = 0
  let bestStrength = 0
  let bestAge = 0
  let bestDirX = 0
  let bestDirZ = 0
  const maxSeg2 = WAKE_TRAIL_MAX_SEG * WAKE_TRAIL_MAX_SEG
  for (let j = 0; j < tr.count; j++) {
    const ax = tr.px[j] as number
    const az = tr.pz[j] as number
    const isHeadSeg = j === tr.count - 1
    const bx = isHeadSeg ? tr.headX : (tr.px[j + 1] as number)
    const bz = isHeadSeg ? tr.headZ : (tr.pz[j + 1] as number)
    const abx = bx - ax
    const abz = bz - az
    const segLen2 = abx * abx + abz * abz
    if (segLen2 > maxSeg2 || segLen2 < 1e-12) continue
    const apx = x - ax
    const apz = z - az
    let tSeg = (apx * abx + apz * abz) / segLen2
    if (tSeg < 0) tSeg = 0
    else if (tSeg > 1) tSeg = 1
    const dxF = apx - abx * tSeg
    const dzF = apz - abz * tSeg
    const d2 = dxF * dxF + dzF * dzF
    if (d2 >= bestD2) continue
    bestD2 = d2
    const aArc = tr.arc[j] as number
    const bArc = isHeadSeg ? tr.headArc : (tr.arc[j + 1] as number)
    const arcAtFoot = aArc + (bArc - aArc) * tSeg
    bestBehind = Math.max(tr.headArc - arcAtFoot, 0)
    const aStr = tr.str[j] as number
    const bStr = isHeadSeg ? tr.headStr : (tr.str[j + 1] as number)
    bestStrength = aStr + (bStr - aStr) * tSeg
    const aT = tr.dropT[j] as number
    const bT = isHeadSeg ? tr.headT : (tr.dropT[j + 1] as number)
    bestAge = Math.max(t - (aT + (bT - aT) * tSeg), 0)
    const d = Math.max(Math.sqrt(d2), 1e-4)
    bestDirX = dxF / d
    bestDirZ = dzF / d
  }
  if (bestStrength <= 1e-3 || !Number.isFinite(bestD2)) return

  const perp = Math.sqrt(bestD2)
  const width = WAKE_BASE_WIDTH + WAKE_HALF_ANGLE_TAN * bestBehind
  const insideArg = (Math.min(perp, width) / width) * Math.PI
  const insidePart = -Math.cos(insideArg)
  const fadeOut = Math.max(0, 1 - Math.max(0, perp - width) / WAKE_EDGE_BELL_HALFWIDTH)
  const transverseSigned = insidePart * fadeOut
  const longRamp = 1 - Math.exp(-bestBehind * WAKE_LONG_RAMP)
  const longDecay = Math.exp(-bestBehind * WAKE_LONG_DECAY)
  const scallop = 1 + WAKE_TRANS_AMP * Math.sin(WAKE_TRANS_K * bestBehind - WAKE_TRANS_OMEGA * t)
  const ageFade = Math.exp(-bestAge / WAKE_AGE_TAU)
  const amp = WAKE_DISP_AMP * bestStrength * longRamp * longDecay * scallop * ageFade
  out.y = amp * transverseSigned
  const dProfileDPerp = Math.sin(insideArg) * (Math.PI / width)
  const ampDProfile = amp * dProfileDPerp
  out.dydx = ampDProfile * bestDirX
  out.dydz = ampDProfile * bestDirZ
}
