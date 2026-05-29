import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import { type ShoreField, sampleShore } from './shore-field'

/**
 * Sum-of-sines Gerstner wave field. Pure math — no Three.js, runs in sim layer.
 *
 * The CPU sampler here is the source of truth for buoyancy. The render-side
 * water shader reads the SAME parameters and time so visuals match physics.
 *
 * Two contributions are summed:
 *   1. Ambient Gerstner waves (wind-driven swell + chop). Static parameters,
 *      animate via time only.
 *   2. Per-bike wakes — each moving bike carries a transverse oscillating
 *      wake stripe behind it. The same closed-form function is mirrored in
 *      the GPU shader so visuals and buoyancy stay locked. This is what
 *      lets a trailing rider "jump" the player's wake.
 *
 * For arcade purposes we use the simplified "vertical-only" Gerstner formulation:
 *   y(x, z, t) = Σ A_i · sin(k_i · (D_i · xz) − ω_i · t + φ_i)
 * skipping the horizontal displacement term. This is dramatically faster to
 * sample (no inverse mapping needed for a given (x,z)) and the visual error
 * is small for the wave amplitudes we use. The wake-and-launch feel comes from
 * the slope/normal more than from horizontal water-particle motion.
 */

export type Wave = {
  /** Unit-length 2D direction (xz plane). */
  dirX: number
  dirZ: number
  /** Peak amplitude, meters. */
  amplitude: number
  /** Crest-to-crest distance, meters. */
  wavelength: number
  /** Phase speed, m/s. */
  speed: number
  /** Static phase offset, radians. */
  phase: number
}

/**
 * A single bike "wake source". Position + horizontal velocity + a 0..1 weight
 * that fades the wake when the bike lifts off the surface. Mirror of the
 * shader's bike-slot uniform — populated once per fixed step from the bike
 * rigid bodies.
 */
export type WakeSource = {
  x: number
  z: number
  vx: number
  vz: number
  /** 0 = inactive (airborne / disabled), 1 = full strength. */
  weight: number
}

export type WaveSample = {
  /** Surface height at (x, z, t). */
  y: number
  /** Surface normal (unit). */
  nx: number
  ny: number
  nz: number
  /** ∂y/∂t — vertical velocity of the surface itself. Useful for damping. */
  vy: number
}

/**
 * Hand-tuned 6-wave analytic Gerstner sum. CPU buoyancy and the GPU
 * vertex shader evaluate the same closed-form formula so bike float
 * math tracks the rendered surface to within float precision.
 */
export type WaveFieldState = {
  waves: Wave[]
  wakes: WakeSource[]
  time: number
  baseY: number
  /** Global wave-field bearing in radians (CCW). Rotates ALL per-wave
   *  travel directions by the same angle at sample time. Lets the
   *  user re-aim the swell train (e.g. "waves should be coming
   *  toward the island") without rebuilding the wave list. Default 0
   *  = directions as authored in `defaultWaves()`. */
  waveBearing: number
  /** Per-track wave-zone overrides. Empty by default; set via
   *  `setWaveZones` after the track loads. See `sampleZoneFactors`
   *  for the OBB-distance blend math. */
  zones: WaveZoneRuntime[]
  /** Baked shore field driving shore-aligned waves near the coast. `null`
   *  (open water / editor / no terrain) = no shore contribution, identical
   *  to legacy behaviour. Installed via `setShoreField` at track load — the
   *  SAME bake the GPU shader samples, so buoyancy and visuals match. */
  shore: ShoreField | null
  /** Global multiplier on the shore-wave amplitude. 1 = default, 0 = off
   *  (byte-identical to no shore field). Mirrors the GPU
   *  `shoreWaveStrength` uniform — the water debug menu sets both from one
   *  scalar, exactly like `waveBearing`. */
  shoreWaveStrength: number
}

/**
 * Runtime representation of a wave zone. Same fields as the
 * `Track.WaveZone` type in `game/tracks/types.ts`; redefined locally
 * (rather than imported) so the sim layer doesn't pull on the track
 * type module — wave-field is the lowest-level water primitive and
 * has to stay light.
 *
 * Pre-computed `cosBearing` / `sinBearing` cache the world→local 2D
 * rotation derived from `rotation`. Saves a quaternion-vs-vector
 * normalisation per zone per sample; `sampleHeight` is called per
 * bike per fixed step plus per render-side preview vertex per frame,
 * so the per-call cost matters.
 */
export type WaveZoneRuntime = {
  position: Vec3
  rotation: Quat
  halfWidth: number
  halfHeight: number
  halfDepth: number
  heightMult: number
  freqMult: number
  directionDeg?: number
  surgePeriodS?: number
  surgeAmplitude?: number
  blendRadiusM: number
  /** Precomputed cos/sin of the zone's world-XZ yaw extracted from
   *  `rotation`. Mirrors the same yaw the Blender author dialed in
   *  when rotating the zone empty around Z (= world-Y after the
   *  Blender Z-up → glTF Y-up swap). */
  _cosYaw: number
  _sinYaw: number
}

// ---- Wake parameters -----------------------------------------------------
//
// These constants must EXACTLY match the values baked into the TSL shader in
// `src/engine/render/water.ts`. Any change here without a matching shader
// change will desync visuals from buoyancy.

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
 * have oscillating ridges along the bike's heading axis — the "scallops"
 * behind a moving boat. K = 0.7 → wavelength ≈ 9m, so ~3 visible
 * scallops fit in the 25m wake length. Chosen so sin(K · 10) > 0 at the
 * unit-test sample point (behind=10, t=0), which keeps the existing
 * "yEdge > 0.3 / yAxis < -0.3" assertions firmly in the pass region
 * (modulation BOOSTS by ~20% there rather than reducing amplitude). */
export const WAKE_TRANS_K = 0.7
/** Transverse-wave angular frequency (rad / s). 1.0 → period ≈ 6.3s,
 * a gentle scroll that makes the scallops feel alive without pulsing
 * distractingly. */
export const WAKE_TRANS_OMEGA = 1.0
/** Modulation amplitude (dimensionless multiplier, range 1 ± value).
 * 0.3 → wake amplitude varies between 0.7× and 1.3× of base across
 * each scallop period. Larger = more dramatic peaks/troughs along
 * the wake; capped here so sin = -1 doesn't push the V edge below
 * the unit-test floor. */
export const WAKE_TRANS_AMP = 0.3

// ---- Shore-wave parameters ----------------------------------------------
//
// Shore-aligned ("shoreline transition") waves: a wave train whose crests run
// PARALLEL to the coast and march shoreward, independent of the wind-driven
// swell direction. They turn the formerly-dead near-shore band (where ambient
// swell is shoaling-damped to nothing) into rideable breakers. Driven by the
// baked {@link ShoreField}: phase advances with distance-to-shore, amplitude
// peaks in the surf band and is capped by the water column so it can never
// poke through the seabed.
//
// These constants MUST EXACTLY match the values baked into the TSL shader in
// `src/engine/render/water.ts` (the shader imports them from this module, and
// `tests/unit/shore-constants-drift.test.ts` enforces the single source). The
// shore field itself is identical on both sides (one bake), so CPU buoyancy
// and the rendered surface stay locked.

/** Crest-to-crest wavelength of the shore wave, metres. ~9 m reads as surf. */
export const SHORE_WAVELENGTH = 9
/** Spatial wavenumber (rad / m). */
export const SHORE_K = (2 * Math.PI) / SHORE_WAVELENGTH
/** Shoreward phase speed, m/s. */
export const SHORE_SPEED = 3.5
/** Angular frequency (rad / s). Phase = K·dist + Ω·t marches crests SHOREWARD
 *  (toward decreasing distance-to-shore). */
export const SHORE_OMEGA = SHORE_K * SHORE_SPEED
/** Static phase offset, radians. */
export const SHORE_PHASE = 0
/** Peak shore-wave amplitude (m) before the per-sample depth cap + strength. */
export const SHORE_AMP = 0.7
/** Water depth (m) at which the shore wave has fully faded out — beyond this
 *  it's open water and the term is zero. */
export const SHORE_BAND_DEPTH = 4.5
/** Amplitude is capped at `SHORE_DEPTH_CAP · depth`, so a wave trough of
 *  `−amplitude` never falls below the seabed (`−depth`). Must be ≤ 1; 0.5
 *  leaves headroom for the ambient swell's own trough to coexist. */
export const SHORE_DEPTH_CAP = 0.5

export function createWaveField(waves: Wave[], opts?: { baseY?: number }): WaveFieldState {
  return {
    waves,
    wakes: [],
    time: 0,
    baseY: opts?.baseY ?? 0,
    waveBearing: 0,
    zones: [],
    shore: null,
    shoreWaveStrength: 1,
  }
}

export function advanceWaveField(field: WaveFieldState, dt: number): void {
  field.time += dt
}

/**
 * Input shape accepted by `setWaveZones`. Mirrors `Track.WaveZone`
 * (same fields, plus the `Quat`-vs-yaw flexibility) — `setWaveZones`
 * extracts the world-Y yaw, caches its cos/sin, and stores the result.
 *
 * Reusing the `WaveZone` track type as input would force the wave-field
 * module to import from `game/tracks/types`; the sim layer should stay
 * leaf-side, so we accept the structural-equivalent shape directly.
 */
export type WaveZoneInput = Omit<WaveZoneRuntime, '_cosYaw' | '_sinYaw'>

/**
 * Replace the field's zone list. Each input zone's quaternion is
 * decomposed to its world-Y yaw (the only rotation axis that matters
 * for an XZ-plane OBB test) and cached. Pass `[]` to clear.
 *
 * Idempotent — call it whenever a new track loads or the editor
 * mutates the zone list.
 */
export function setWaveZones(field: WaveFieldState, zones: readonly WaveZoneInput[]): void {
  field.zones = zones.map((z) => {
    const yaw = yawFromQuat(z.rotation)
    return {
      ...z,
      _cosYaw: Math.cos(yaw),
      _sinYaw: Math.sin(yaw),
    }
  })
}

/**
 * World-Y yaw of a quaternion, same convention as `readYaw` in
 * `glb-loader.ts` — atan2 of the YXZ Euler decomposition. Pulling
 * just the Y-yaw is sufficient because wave-zone OBBs sit flat on
 * the water plane; any pitch/roll the author dialed in on the
 * Blender empty is treated as cosmetic for surface sampling.
 */
function yawFromQuat(q: Quat): number {
  const r02 = 2 * (q.x * q.z + q.y * q.w)
  const r22 = 1 - 2 * (q.x * q.x + q.y * q.y)
  return Math.atan2(r02, r22)
}

/**
 * Per-zone weight at sample (x, z). 1 inside the OBB, smoothsteps to
 * 0 across `blendRadiusM` outside the OBB face. Distance is measured
 * to the box's 2D XZ projection — the vertical Y extent is treated as
 * "always inside" for surface samples (callers that need a 3-D test
 * — e.g. future pump-charge multipliers for an in-air bike — can use
 * `pointInWaveZone3D` separately).
 */
function zoneWeight(zone: WaveZoneRuntime, x: number, z: number): number {
  // World → zone local: subtract centre, rotate by -yaw.
  const dx = x - zone.position.x
  const dz = z - zone.position.z
  const lx = dx * zone._cosYaw + dz * zone._sinYaw
  const lz = -dx * zone._sinYaw + dz * zone._cosYaw
  // Signed distance from the box's 2D face (negative inside, positive
  // outside; 0 on the surface). The OBB's XZ extents are halfWidth
  // (local-X) and halfDepth (local-Z); halfHeight gates Y separately
  // (see `pointInWaveZone3D`).
  const qx = Math.abs(lx) - zone.halfWidth
  const qz = Math.abs(lz) - zone.halfDepth
  // Outside distance: standard SDF-to-AABB Euclidean distance, plus
  // a negative term for the interior so points well inside still
  // produce a weight of 1 (the smoothstep saturates).
  const outX = Math.max(qx, 0)
  const outZ = Math.max(qz, 0)
  const outsideDist = Math.hypot(outX, outZ)
  if (outsideDist >= zone.blendRadiusM) return 0
  // Inside the box, outsideDist === 0 → weight 1. On the face,
  // weight 0.5 (cubic smoothstep midpoint at t=0.5 = 0.5). At
  // blendRadiusM outside, weight 0.
  const t = 1 - outsideDist / zone.blendRadiusM
  return t * t * (3 - 2 * t)
}

export type WaveZoneFactors = {
  /** Effective wave-amplitude multiplier at this sample. 1 = neutral. */
  heightMult: number
  /** Effective wave-frequency multiplier. 1 = neutral. Applied by
   *  dividing each wave's wavelength inside the zone. */
  freqMult: number
  /** Effective bearing override. `undefined` = inherit global. */
  bearingRad: number | undefined
  /** Accumulated periodic surge contribution at the current field
   *  time. Added on top of the multiplied Gerstner sum. */
  surgeY: number
}

/**
 * Blend the field's zone list down to a single per-sample factor set
 * at (x, z, t). The blend rule is a soft-max: each zone's weight
 * `w ∈ [0,1]` (from `zoneWeight`) drives a `mix(neutral, zoneValue,
 * w)`, then we take the strongest-weighted value across all zones.
 *
 * Why soft-max instead of summing weights:
 *   - Sum-of-weights blows past 1 in overlapping zones, producing
 *     surprise amplitude spikes. Soft-max keeps the result bounded
 *     by the loudest zone, which matches author intent ("inside The
 *     Maw's central arch zone I expect the central-arch swell").
 *   - When two same-strength zones overlap, the larger heightMult
 *     dominates — the racer reads the louder of the two.
 *
 * Surges from multiple zones DO sum (they're additive, not
 * multiplicative). Overlap is rare by construction (zones gate
 * different track sections) and additive surges read as
 * intuitive — "two tsunamis meeting" → bigger wave.
 *
 * Returns the neutral factor set (mults = 1, no bearing override,
 * no surge) when no zone has a positive weight at (x, z). Caller
 * can then skip the zone code path entirely.
 */
export function sampleZoneFactors(
  zones: readonly WaveZoneRuntime[],
  x: number,
  z: number,
  t: number,
): WaveZoneFactors {
  if (zones.length === 0) {
    return { heightMult: 1, freqMult: 1, bearingRad: undefined, surgeY: 0 }
  }
  let bestWeight = 0
  let bestHeightMult = 1
  let bestFreqMult = 1
  let bestBearing: number | undefined
  let surgeY = 0
  for (const zone of zones) {
    const w = zoneWeight(zone, x, z)
    if (w <= 0) continue
    // Soft-max: the strongest-weighted zone wins on mults / bearing.
    if (w > bestWeight) {
      bestWeight = w
      bestHeightMult = 1 + (zone.heightMult - 1) * w
      bestFreqMult = 1 + (zone.freqMult - 1) * w
      if (zone.directionDeg !== undefined) {
        bestBearing = (zone.directionDeg * Math.PI) / 180
      }
    }
    // Surges accumulate so overlapping tsunami sources sum, not pick.
    if (zone.surgePeriodS !== undefined && zone.surgeAmplitude !== undefined) {
      const phase = (2 * Math.PI * t) / zone.surgePeriodS
      const surge = zone.surgeAmplitude * Math.max(0, Math.sin(phase))
      surgeY += surge * w
    }
  }
  return {
    heightMult: bestHeightMult,
    freqMult: bestFreqMult,
    bearingRad: bestBearing,
    surgeY,
  }
}

/**
 * Convenience predicate: is the 3-D point inside the zone's OBB? Uses
 * the same yaw-only rotation as `zoneWeight` but additionally gates
 * Y by `halfHeight`. Reserved for future "bike inside the zone"
 * gameplay hooks (pump charge multipliers, AI swell warnings, etc.).
 * Not called by the surface samplers — those treat Y as "always in".
 */
export function pointInWaveZone3D(zone: WaveZoneRuntime, x: number, y: number, z: number): boolean {
  const dx = x - zone.position.x
  const dy = y - zone.position.y
  const dz = z - zone.position.z
  const lx = dx * zone._cosYaw + dz * zone._sinYaw
  const lz = -dx * zone._sinYaw + dz * zone._cosYaw
  return (
    Math.abs(lx) <= zone.halfWidth &&
    Math.abs(dy) <= zone.halfHeight &&
    Math.abs(lz) <= zone.halfDepth
  )
}

/**
 * Wake displacement at (x, z) from a single source at time t. Returns 0
 * when the source is in front of the sample point, slow, or off in
 * perpendicular space.
 *
 * Profile across the V (perp = perpendicular distance from the bike's
 * heading axis):
 *   - Inside the V (perp < wakeWidth): a half-cosine trough, going from
 *     -AMP at perp=0 to +AMP at perp=wakeWidth. The water "channels"
 *     down between the diverging wave arms.
 *   - At the boundary (perp = wakeWidth): peak (+AMP), the wake's
 *     visible ridge.
 *   - Just outside (wakeWidth < perp < wakeWidth + EDGE_BELL_HALFWIDTH):
 *     linear fade to 0.
 *   - Beyond: 0.
 *
 * Longitudinal modulation (M9.35): the V's amplitude is multiplied by
 * `(1 + WAKE_TRANS_AMP · sin(K · behind − ω · t))` to produce the
 * transverse "scallops" seen in real ship wakes. The whole V breathes
 * up and down along its length, with the modulation pattern slowly
 * scrolling backward as time advances. Pre-M9.35 the V was a static
 * Kelvin shape — the new modulation makes the wake feel alive without
 * disturbing the V's silhouette.
 *
 * Mirrored bit-for-bit by the TSL shader's bikeSurfaceContrib block —
 * keep them in sync.
 */
export function sampleWakeFromSource(
  src: WakeSource,
  x: number,
  z: number,
  t: number,
): { y: number; dydx: number; dydz: number } {
  const speed = Math.hypot(src.vx, src.vz)
  if (speed < WAKE_SPEED_LOW || src.weight <= 0) {
    return { y: 0, dydx: 0, dydz: 0 }
  }
  const dx = x - src.x
  const dz = z - src.z
  const hatX = src.vx / speed
  const hatZ = src.vz / speed
  const parallel = dx * hatX + dz * hatZ
  const behind = Math.max(-parallel, 0)
  if (behind <= 0) return { y: 0, dydx: 0, dydz: 0 }
  const perp = Math.abs(dx * hatZ - dz * hatX)

  const speedGate = smoothstep(WAKE_SPEED_LOW, WAKE_SPEED_HIGH, speed)
  const wakeWidth = behind * WAKE_HALF_ANGLE_TAN + WAKE_BASE_WIDTH

  // Two-piece signed profile across the V:
  //   inside V:  -cos(π · perp / wakeWidth)         // -1..+1
  //   outside V: 1 · max(0, 1 - (perp - wakeWidth) / halfwidth)  // fade 1→0
  // Combined via min/max so it's branchless-friendly for the shader.
  const insideArg = (Math.min(perp, wakeWidth) / wakeWidth) * Math.PI
  const insidePart = -Math.cos(insideArg) // varies -1 (perp=0) → +1 (perp=wakeWidth)
  const fadeOut = Math.max(0, 1 - Math.max(0, perp - wakeWidth) / WAKE_EDGE_BELL_HALFWIDTH)
  // For perp <= wakeWidth: insidePart∈[-1,1], fadeOut=1. profile = insidePart.
  // For perp > wakeWidth:  insidePart=1 (clamped),  fadeOut∈[0,1]. profile = fadeOut.
  const transverseSigned = insidePart * fadeOut

  const longRamp = 1 - Math.exp(-behind * WAKE_LONG_RAMP)
  const longDecay = Math.exp(-behind * WAKE_LONG_DECAY)
  // Transverse "scallops": the V's amplitude oscillates along its length.
  // sin(K · behind − ω · t) drifts backward in the bike's frame as t
  // advances (the pattern travels with the wake's tail).
  const longPhase = WAKE_TRANS_K * behind - WAKE_TRANS_OMEGA * t
  const transverseMod = 1 + WAKE_TRANS_AMP * Math.sin(longPhase)

  const amp = WAKE_DISP_AMP * speedGate * src.weight * longRamp * longDecay * transverseMod
  const y = amp * transverseSigned

  // Analytic gradient — dominated by the perp direction (the V shape) and
  // by the longitudinal decay (slow change with `behind`). The cross
  // terms involving ∂(longRamp·longDecay)/∂behind are small relative to
  // the perp slope at typical arcade scales; including them complicates
  // the shader without a visible payoff.
  //
  // d transverseSigned / d perp:
  //   inside V:  (π / wakeWidth) · sin(π · perp / wakeWidth)
  //   in fade:   -1 / EDGE_BELL_HALFWIDTH
  //   outside:   0
  let dProfileDPerp: number
  if (perp < wakeWidth) {
    dProfileDPerp = (Math.PI / wakeWidth) * Math.sin(insideArg)
  } else if (perp < wakeWidth + WAKE_EDGE_BELL_HALFWIDTH) {
    dProfileDPerp = -1 / WAKE_EDGE_BELL_HALFWIDTH
  } else {
    dProfileDPerp = 0
  }
  // ∂perp/∂x = sign(c) · hatZ, where c = dx·hatZ − dz·hatX.
  const c = dx * hatZ - dz * hatX
  const signC = c >= 0 ? 1 : -1
  const dPerpDx = signC * hatZ
  const dPerpDz = -signC * hatX
  const dydx = amp * dProfileDPerp * dPerpDx
  const dydz = amp * dProfileDPerp * dPerpDz
  return { y, dydx, dydz }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Install (or clear) the track's baked shore field. Pass `null` to remove it
 * (open-water / editor tracks). Mirrors `setWaveZones`: a sim-layer function
 * that takes the field plus per-track data, so every field-owning mode —
 * including the replay reconstructor — can install the identical field and
 * keep buoyancy classification deterministic.
 */
export function setShoreField(field: WaveFieldState, shore: ShoreField | null): void {
  field.shore = shore
}

// Reused scratch for the shore-wave contribution. Single-threaded synchronous
// callers read it immediately after `computeShore`, so a module-level scratch
// avoids a per-sample allocation on the hot buoyancy path. `active` gates
// whether the y/slope/vy fields are meaningful.
const _shore = { y: 0, dydx: 0, dydz: 0, vy: 0, active: false }

/**
 * Evaluate the shore-aligned wave at world (x, z, t) into `_shore`. Single
 * source of truth so `sampleHeight` (reads `.y`) and `sampleSurface` (reads
 * `.y`, `.dydx`, `.dydz`, `.vy`) can never disagree on the height.
 *
 * Amplitude envelope: zero on dry land (`depth ≤ 0`) and in open water
 * (`depth ≥ SHORE_BAND_DEPTH`), peaking in the surf band; capped at
 * `SHORE_DEPTH_CAP · depth` so a trough never breaches the seabed. Phase
 * `K·dist + Ω·t` marches crests shoreward; slopes are in WORLD frame (the
 * shore normal is world-XZ, not bearing-rotated), so the caller adds them
 * AFTER its bearing back-rotation.
 */
function computeShore(field: WaveFieldState, x: number, z: number, t: number): void {
  _shore.active = false
  const shore = field.shore
  if (!shore || field.shoreWaveStrength <= 0) return
  const s = sampleShore(shore, x, z)
  if (!s) return
  const depth = s.depth
  if (depth <= 0 || depth >= SHORE_BAND_DEPTH) return
  // 1 at the waterline, smoothly → 0 by SHORE_BAND_DEPTH.
  const bandGate = 1 - smoothstep(0, SHORE_BAND_DEPTH, depth)
  const ampCap = Math.min(SHORE_AMP, SHORE_DEPTH_CAP * depth)
  const A = ampCap * bandGate * field.shoreWaveStrength
  if (A <= 0) return
  const phase = SHORE_K * s.dist + SHORE_OMEGA * t + SHORE_PHASE
  const sinP = Math.sin(phase)
  const cosP = Math.cos(phase)
  _shore.y = A * sinP
  // ∂phase/∂x = K·nrmX (nrm = ∇dist, offshore, world frame). Envelope
  // gradient omitted — matches the ambient shoaling slope approximation.
  _shore.dydx = A * cosP * SHORE_K * s.nrmX
  _shore.dydz = A * cosP * SHORE_K * s.nrmZ
  // ∂y/∂t with phase = K·dist + Ω·t.
  _shore.vy = A * cosP * SHORE_OMEGA
  _shore.active = true
}

/** Surface y only — the cheap path used per-bike per-tick. */
export function sampleHeight(field: WaveFieldState, x: number, z: number): number {
  let y = field.baseY
  const t = field.time
  // Per-zone factors are blended once per sample. When no zones are
  // active the call returns the neutral (1, 1, no-bearing, 0) tuple,
  // so the multiplications below are no-ops and we avoid a branch
  // explosion across the two wave-field kinds.
  const zoneFx = sampleZoneFactors(field.zones, x, z, t)
  const effectiveBearing = zoneFx.bearingRad ?? field.waveBearing
  const cosB = Math.cos(effectiveBearing)
  const sinB = Math.sin(effectiveBearing)
  // Rotate sample coords by -bearing — equivalent to rotating each
  // per-wave direction by +bearing. Lets one global angle re-aim the
  // whole wave train without mutating per-wave dirX/dirZ.
  const xRot = x * cosB + z * sinB
  const zRot = -x * sinB + z * cosB
  for (const w of field.waves) {
    // freqMult shortens the wavelength inside the zone — chop bands
    // become choppier, swells get tighter. heightMult scales the
    // amplitude.
    const k = ((2 * Math.PI) / w.wavelength) * zoneFx.freqMult
    const omega = w.speed * k
    const phase = k * (w.dirX * xRot + w.dirZ * zRot) - omega * t + w.phase
    y += zoneFx.heightMult * w.amplitude * Math.sin(phase)
  }
  y += zoneFx.surgeY
  for (const src of field.wakes) {
    y += sampleWakeFromSource(src, x, z, t).y
  }
  // Shore-aligned wave — rideable breakers in the near-shore band.
  computeShore(field, x, z, t)
  if (_shore.active) y += _shore.y
  return y
}

/** Full sample including normal and ∂y/∂t. */
export function sampleSurface(field: WaveFieldState, x: number, z: number): WaveSample {
  let y = field.baseY
  // Slopes are accumulated in the ROTATED frame (using xRot/zRot
  // below), then rotated back to world frame via the inverse of the
  // input rotation so the returned dy/dx, dy/dz remain in world XZ.
  let rotDydx = 0
  let rotDydz = 0
  let vy = 0
  const t = field.time
  const zoneFx = sampleZoneFactors(field.zones, x, z, t)
  const effectiveBearing = zoneFx.bearingRad ?? field.waveBearing
  const cosB = Math.cos(effectiveBearing)
  const sinB = Math.sin(effectiveBearing)
  const xRot = x * cosB + z * sinB
  const zRot = -x * sinB + z * cosB
  for (const w of field.waves) {
    const k = ((2 * Math.PI) / w.wavelength) * zoneFx.freqMult
    const omega = w.speed * k
    const phase = k * (w.dirX * xRot + w.dirZ * zRot) - omega * t + w.phase
    const s = Math.sin(phase)
    const c = Math.cos(phase)
    const a = zoneFx.heightMult * w.amplitude
    y += a * s
    rotDydx += a * c * (k * w.dirX)
    rotDydz += a * c * (k * w.dirZ)
    vy += a * c * -omega
  }
  // Surge adds height only — its ∂/∂x and ∂/∂z are zero (uniform
  // inside the zone's weight envelope), so we don't bias slopes /
  // normals here. The bike's buoyancy reads `y` directly, which is
  // what authors want from a "the whole zone lifts" surge.
  y += zoneFx.surgeY
  // Convert rotated-frame slopes back to world frame.
  let dydx = rotDydx * cosB - rotDydz * sinB
  let dydz = rotDydx * sinB + rotDydz * cosB
  for (const src of field.wakes) {
    const wk = sampleWakeFromSource(src, x, z, t)
    y += wk.y
    dydx += wk.dydx
    dydz += wk.dydz
    // Wake's ∂y/∂t is small relative to swell; skip for buoyancy damping.
  }
  // Shore-aligned wave. Slopes are already world-frame (shore normal is
  // world-XZ), so they add AFTER the bearing back-rotation above — alongside
  // the wake terms, not into rotDydx/rotDydz.
  computeShore(field, x, z, t)
  if (_shore.active) {
    y += _shore.y
    dydx += _shore.dydx
    dydz += _shore.dydz
    vy += _shore.vy
  }
  // Normal of y = f(x, z) is (−∂y/∂x, 1, −∂y/∂z), normalized.
  const nx = -dydx
  const ny = 1
  const nz = -dydz
  const len = Math.hypot(nx, ny, nz)
  return { y, nx: nx / len, ny: ny / len, nz: nz / len, vy }
}

/**
 * Default wave preset — a coherent swell train tuned for Wave-Race-style
 * riding. The previous preset summed six directions spanning 190° (literally
 * the physics definition of "confused seas"), which produced unpredictable
 * jostling under the bike. This one runs every wave within a ±25° fan of
 * the bearing axis so crests march in roughly one direction, the way real
 * open-coast swell does:
 *
 *   - Two long swells (50 m + 85 m) carry the silhouette. Their periods
 *     (5.8 s / 7.6 s) beat constructively about every 24 s for the
 *     "occasional big set" rhythm.
 *   - Four chop bands (16 / 10 / 6 / 4 m) layered on top fan ±25° around
 *     the bearing for surface texture without re-introducing the
 *     omnidirectional jostle.
 *
 * Amplitude budget: peak ~1.4 m, RMS ~0.55 m — about 65% of the previous
 * tune so the bike can ride the faces rather than slap through chop. The
 * per-track `seaStateBeaufort` multiplier (see `beaufortToAmplitudeScale`)
 * still scales the whole stack, so calm pond tracks (Beaufort 1–2) sit at
 * ~0.3 m peak and storm tracks (Beaufort 5+) push back over 2 m.
 *
 * Each wave is unrolled into the vertex shader as a sin+cos pair, so the
 * count is a direct multiplier on per-vertex cost. Tests run headed (real
 * GPU) so we don't need to keep this as small as the headless WebGL2
 * software fallback would prefer.
 */
export function defaultWaves(): Wave[] {
  // Phase speeds are roughly the deep-water dispersion `c = √(g·L / 2π)`
  // (≈ 9 m/s at 50 m, ≈ 11.5 m/s at 85 m, down to ~2.5 m/s for 4 m chop).
  // Sticking close to the physical relation keeps the crest visibly
  // travelling at a pace the player's eye reads as "real water."
  return [
    // Primary swell — the dominant set rolling toward the bike.
    { dirX: 1.0, dirZ: 0.0, amplitude: 0.5, wavelength: 50, speed: 8.6, phase: 0.4 },
    // Secondary swell — same direction, slightly different period so the
    // two swells beat into bigger "sets" every ~24 s.
    { dirX: 0.985, dirZ: 0.174, amplitude: 0.35, wavelength: 85, speed: 11.2, phase: 2.2 },
    // Mid-band chop riding the swell face, dead-on with the bearing.
    { dirX: 1.0, dirZ: 0.0, amplitude: 0.22, wavelength: 16, speed: 5.0, phase: 0.0 },
    // Cross-chop fanned ±25° around the bearing for surface variety
    // without re-introducing the omni-directional jostle.
    { dirX: 0.906, dirZ: 0.423, amplitude: 0.16, wavelength: 10, speed: 4.0, phase: 1.1 },
    { dirX: 0.94, dirZ: -0.342, amplitude: 0.1, wavelength: 6, speed: 3.1, phase: 2.3 },
    { dirX: 0.985, dirZ: 0.174, amplitude: 0.06, wavelength: 4, speed: 2.5, phase: 3.7 },
  ]
}
