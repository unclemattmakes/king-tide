import type { Quat, Vec3 } from '@/engine/sim/physics/vec'
import { type ShoreField, sampleShore } from './shore-field'
import { type SplashRing, sampleSplashRings } from './splash-rings'
import { sampleWakeFromTrail, type WakeSampleOut, type WakeTrail } from './wake-trail'

/**
 * Sum-of-sines Gerstner wave field. Pure math — no Three.js, runs in sim layer.
 *
 * The CPU sampler here is the source of truth for buoyancy. The render-side
 * water shader reads the SAME parameters and time so visuals match physics.
 *
 * Two contributions are summed:
 *   1. Ambient Gerstner waves (wind-driven swell + chop). Static parameters,
 *      animate via time only.
 *   2. Per-bike wake trails — each bike records a short breadcrumb TRAIL of
 *      its ridden path (`wake-trail.ts`, fed once per fixed step) and the
 *      wake profile is evaluated along it: a transverse oscillating ridge
 *      that curves with the line, gaps where the bike flew, and age-fades
 *      where it stopped. Buoyancy here and the GPU shader evaluate the SAME
 *      profile against the SAME trail points, so the bump a trailing rider
 *      feels ("jump my wake") is exactly the ridge the shader draws — turns
 *      included. Trails are deterministic per fixed step but deliberately
 *      not snapshotted (self-healing after rollback/seek; see wake-trail.ts).
 *
 * Ambient waves are a sum of sines:
 *   y(x, z, t) = Σ A_i · sin(k_i · (D_i · xz) − ω_i · t + φ_i)
 * When the field's `steepness` is 0 (the default, and what most tests use)
 * this vertical-only heightfield IS the surface — cheap, no inverse mapping.
 * When steepness > 0 the GPU shader also displaces vertices horizontally
 * (Gerstner crest-pinch); `sampleHeight`/`sampleSurface` then inverse-map that
 * displacement so buoyancy floats on exactly the surface the shader draws.
 * See the "Gerstner horizontal-displacement inverse map" section below.
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
  /** Per-wave Gerstner steepness coefficient, multiplied by the field's
   *  global `steepness`. Higher = sharper lateral crest pinch (chops sharper
   *  than swells). Optional — the samplers fall back to a default when absent
   *  (e.g. test-constructed waves). Mirrors the per-wave Q the GPU shader
   *  bakes, so CPU buoyancy and the rendered mesh pinch identically. */
  qBase?: number
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
  /** Per-bike wake trails — the recorded path history the wake profile is
   *  evaluated along (see wake-trail.ts). Fed once per fixed step by
   *  `wakeUpdateSystem` via `acquireWakeTrail` + `feedWakeTrail`; persistent
   *  across steps (unlike `wakes`, which is re-derived every step). Both the
   *  buoyancy samplers here and the GPU water shader read these same points,
   *  so the felt wake IS the drawn wake. */
  trails: WakeTrail[]
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
  /** Global Gerstner steepness Q (0 = vertical-only heightfield). When > 0,
   *  `sampleHeight`/`sampleSurface` inverse-map the horizontal displacement so
   *  buoyancy floats on the SAME surface the GPU shader draws (which pinches
   *  crests sideways). Set by the render layer / water menu; default 0 keeps
   *  the legacy vertical-only behaviour (and the unit tests) unchanged. The
   *  effective Q applied at sample time is clamped sub-folding — see
   *  `effectiveSteepness`. */
  steepness: number
  /** Pre-computed cos/sin of the Gerstner pinch direction (rotates the
   *  horizontal-displacement vector relative to wave travel). Mirrors the
   *  shader's pinch uniforms. Default (1, 0) = along-wave. */
  pinchCos: number
  pinchSin: number
  /** Splash-ring pool (water-next-research §7.5, P4.1) — deterministic
   *  landing waves spawned by the hover system's water-landing events;
   *  see splash-rings.ts. Self-healing (≤ 4 s decay), not snapshotted —
   *  the wake-trail discipline. */
  rings: SplashRing[]
  /** Splash-ring strength, 0..1.5 (1 = baseline, 0 = off). One scalar
   *  for BOTH buoyancy and the GPU (the shoreWaveStrength discipline) —
   *  set by the water debug menu. */
  splashRingStrength: number
  /** Authored wave stamps (water-next-research §7.10) — the per-track
   *  signature jump waves. Empty by default; installed via
   *  `setWaveStamps` from `track.waveStamps`. Both samplers and the GPU
   *  evaluate the same pulse math (uniform mirror synced by reference in
   *  the water mesh's tick, like zones). */
  stamps: WaveStampRuntime[]
  /** Shoaling v2 blend, 0..1 (water-next-research §7.3): 0 = the legacy
   *  quadratic shallow-water kill-switch, 1 = full surf behaviour
   *  (Green's-law gain + depth-limited breaking via `shoalAttenuation`).
   *  Owned by the field like `steepness` — the water debug menu sets it
   *  here AND on the GPU uniform from one scalar, so buoyancy and the
   *  rendered surface always shoal identically. Default 1 (surf ON);
   *  playtest-gated like every feel change. */
  shoalSurfStrength: number
  /** Wave-set envelope ("sets" — the surf rhythm of bigger wave groups
   *  arriving every few tens of seconds; water-next-research §7.2). A pure
   *  analytic amplitude factor `1 + depth·sin(2π·t/periodS + phase)` that
   *  multiplies the AMBIENT swell/chop in both CPU samplers and the GPU
   *  shader (mirrored uniforms, synced in tick()), layered ON TOP of
   *  whatever the static amplitude writers (Beaufort, lap-weather, menu
   *  sliders) put in `waves[i].amplitude` — a separate term rather than an
   *  amplitude mutation so it can never compound with those writers or
   *  drift across replays (it's a pure function of `time`). Wakes, the
   *  shore wave and zone surge are NOT enveloped (they're not sea-state).
   *  `swellSetPeriodS <= 0` or `swellSetDepth <= 0` disables it (factor 1,
   *  byte-identical to pre-envelope behaviour). Authored per track via
   *  `water.swellSets`. */
  swellSetPeriodS: number
  swellSetDepth: number
  swellSetPhase: number
}

/** The wave-set envelope factor at time `t` (default: the field's clock).
 *  1 when disabled. Mirrored EXACTLY by the GPU (`setEnvNode`) and the
 *  `renderVertex` CPU mirror — all three compute `1 + depth·sin(ω·t + φ)`
 *  from the same scalars, so buoyancy and the rendered surface breathe in
 *  lockstep through a set. */
export function waveSetFactor(field: WaveFieldState, t: number = field.time): number {
  if (field.swellSetDepth <= 0 || field.swellSetPeriodS <= 0) return 1
  const omega = (2 * Math.PI) / field.swellSetPeriodS
  return 1 + field.swellSetDepth * Math.sin(omega * t + field.swellSetPhase)
}

/** ∂(waveSetFactor)/∂t — needed for the exact surface vertical velocity
 *  (`vy`) the hover damping reads: y = env(t)·Σ(...) ⇒ ∂y/∂t picks up an
 *  `env'(t)·Σ(...)` term alongside the usual phase term. Small (≤ ~3 % of
 *  the wave's own vy at a 60 s / 0.3 set) but exact is cheap. */
export function waveSetFactorRate(field: WaveFieldState, t: number = field.time): number {
  if (field.swellSetDepth <= 0 || field.swellSetPeriodS <= 0) return 0
  const omega = (2 * Math.PI) / field.swellSetPeriodS
  return field.swellSetDepth * omega * Math.cos(omega * t + field.swellSetPhase)
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
// The wake profile + trail machinery live in `wake-trail.ts` (one bike =
// one recorded path trail; the profile is evaluated in trail coordinates by
// both this module's samplers and the TSL shader). Re-exported here so the
// shader and older call sites keep importing wake constants from the same
// module as every other sim↔render shared constant.
export {
  WAKE_AGE_TAU,
  WAKE_BASE_WIDTH,
  WAKE_DISP_AMP,
  WAKE_EDGE_BELL_HALFWIDTH,
  WAKE_HALF_ANGLE_TAN,
  WAKE_LONG_DECAY,
  WAKE_LONG_RAMP,
  WAKE_SPEED_HIGH,
  WAKE_SPEED_LOW,
  WAKE_TRANS_AMP,
  WAKE_TRANS_K,
  WAKE_TRANS_OMEGA,
} from './wake-trail'

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

// ---- Shore-wave v2 (shoaling v2, water-next-research §7.3) ----------------
//
// Two upgrades, both pure functions of already-mirrored state so CPU and
// GPU can't disagree (constants drift-tested like the rest of SHORE_*):
//
//  1. SWELL DRIVE — the breaker amplitude scales with the live ambient
//     swell (swell-band amplitude sum × the set envelope) instead of the
//     fixed SHORE_AMP: calm lagoons get lapping shore-break, storm seas
//     and big sets send bigger waves up the beach. Normalised against the
//     shipped default sea's swell sum, clamped so authoring extremes
//     can't kill or blow out the surf band.
//  2. FORWARD ASYMMETRY — a phase-locked second harmonic leans each
//     breaker's front (shoreward) face steeper than its back, the classic
//     near-breaking profile (War Thunder pitches its breaker tops forward
//     the same way). Pure waveform change: y = A·(sin φ + a₂·sin(2φ+β)),
//     derivatives follow by chain rule on both sides.

/** Reference swell-band amplitude sum (m) at which the swell drive is 1 —
 *  the shipped default sea's two swells at their boot tuning (0.5·3.2 +
 *  0.35·3.2 = 2.72). */
export const SHORE_SWELL_DRIVE_REF = 2.72
/** Clamp range for the swell drive so the surf band stays present but
 *  sane across authoring extremes (Beaufort 0 tutorials … storm finales
 *  mid-set). */
export const SHORE_SWELL_DRIVE_MIN = 0.35
export const SHORE_SWELL_DRIVE_MAX = 1.6
/** Second-harmonic strength a₂ (fraction of the fundamental). 0 = the old
 *  pure sine; 0.26 reads as a clear forward lean without cusping. */
export const SHORE_ASYM = 0.26
/** Second-harmonic phase offset β (rad). With y/A = sin φ + a₂·sin(2φ+β):
 *  β = ±π/2 only SHARPENS crests symmetrically (the waveform becomes a
 *  pure function of sin φ — Stokes-style, no lean); fore-aft asymmetry
 *  needs the harmonic IN PHASE (β = 0) or ANTI-PHASE (β = π). β = 0
 *  shifts each crest's apex to φ ≈ π/2 − 2a₂, compressing the SHOREWARD
 *  face (phase = K·dist + Ω·t marches toward −dist, so smaller φ = the
 *  face the wave is breaking onto) — the forward-leaning profile. The
 *  unit test measures the face-slope split and pins the direction
 *  (β = π was measured leaning the wrong way, split 0.5 vs ~2.0). */
export const SHORE_ASYM_PHASE = 0

// ---- Terrain shoaling -----------------------------------------------------
//
// In shallow water the rendered surface fades the ambient swell/chop (and its
// Gerstner crest-pinch) toward flat as the water column thins, so crests can't
// poke through the seabed. The CPU buoyancy sampler MUST apply the identical
// attenuation or the rider floats on a surface the shader never draws — a
// full-amplitude trough would otherwise drop the buoyancy target below the
// seabed (the "driving on the ocean floor" bug on terrain tracks). The depth
// driving it is the same `waterLevel − terrainY` the GPU samples, read here
// from the baked {@link ShoreField} (it stores that depth per cell). This
// constant MUST EXACTLY match the value baked into the TSL shader in
// `src/engine/render/water.ts` (which imports it from here);
// `tests/unit/shore-constants-drift.test.ts` enforces the single source.

/** Water depth (m) at which the ambient waves reach full strength. Below this
 *  the LEGACY shoaling factor fades the swell/chop out as
 *  `(depth / SHOAL_FADE_DEPTH)²` (squared so the tail of the fade reads as
 *  a gentle calming, not an abrupt edge); at or above it the factor is 1
 *  (open-water, full amplitude). Shoaling v2 (below) blends away from this
 *  kill-switch toward real surf behaviour; the legacy curve remains the
 *  `shoalSurfStrength = 0` endpoint. */
export const SHOAL_FADE_DEPTH = 3.0

// ---- Shoaling v2 — depth-driven surf (water-next-research §7.3, P3.1) -----
//
// The legacy factor above just KILLS the swell in shallow water. Real
// shoaling first amplifies it (energy flux conservation — Green's law,
// H ∝ h^(−1/4)) and then breaks it at a depth-determined line (H/h ≈ 0.78,
// the standard depth-limited breaking ratio). Modelled as a closed-form
// per-sample factor of (depth, live swell scale) so both samplers and the
// GPU vertex stage evaluate it identically through the SAME single
// `shoalFactor` slot the legacy curve used:
//
//   gain(d)  = clamp((SHOAL_GREEN_REF_DEPTH / d)^¼, 1, SHOAL_GAIN_MAX)
//   cap(d)   = SHOAL_BREAK_GAMMA · d / H_eff      (depth-limited breaking)
//   f_v2(d)  = min(gain, max(cap, 0))
//
// `H_eff` is the live swell-band amplitude sum × the set envelope — the
// same mirrored scalars buoyancy and the shader already share, so a big
// set BREAKS FARTHER OUT (deeper water) exactly like real surf. The break
// cap doubles as the seabed guard for the AMBIENT sum: its trough
// −H_eff·f ≥ −γ·d stays above the seabed while γ < 1, which is what lets
// v2 keep waves ALIVE right up the beach where the legacy quadratic had
// already flattened them — the rideable-surf payoff. (The combined
// surface — ambient + the shore breaker's own SHORE_DEPTH_CAP·d budget —
// can theoretically underdip the seabed by ≈ (γ + 0.5·(1+a₂) − 1)·d when
// every trough aligns; measured worst case is centimetres at the swash
// line, the dip hides UNDER the beach geometry, and buoyancy reads
// max(terrain, wave) so the bike never feels it — the v1 "driving on the
// ocean floor" bug was metre-scale unattenuated troughs, a different
// regime. The unit test pins the bounded-breach guarantee.)
// `field.shoalSurfStrength` blends legacy ↔ v2 (0 = byte-identical
// legacy, 1 = full surf; the water menu knob mirrors the GPU uniform
// like steepness/shoreWaveStrength).
//
// All four constants are imported by the TSL shader and drift-tested
// (`tests/unit/shore-constants-drift.test.ts`).

/** Depth (m) where the Green's-law gain starts to bite (≈ λ/4 of the
 *  primary 50 m swell — about where real groundswell feels the bottom). */
export const SHOAL_GREEN_REF_DEPTH = 14
/** Cap on the shoaling amplification. Green's law diverges as d → 0; real
 *  waves break first. 1.3× keeps the pre-break stack readable without
 *  doubling the buoyancy target. */
export const SHOAL_GAIN_MAX = 1.3
/** Depth-limited breaking ratio H/h — the textbook 0.78. */
export const SHOAL_BREAK_GAMMA = 0.78
/** Floor on the effective swell scale H_eff (m) so a near-flat calm sea
 *  (menu sliders at 0, Beaufort 0) can't divide the break cap toward
 *  infinity. */
export const SHOAL_HEFF_MIN = 0.2

// ---- Authored wave stamps (water-next-research §7.10, P3.2) ---------------
//
// The wave-mastery content layer: a stamp is an AUTHORED, LEARNABLE jump
// wave — a crest line placed by the designer plus a traveling pulse that
// approaches it on a fixed rhythm, peaks exactly ON the line, and dies
// past it. Same wave, same place, every lap: the motocross jump made of
// water (the Horizon/surf-game lesson — signature waves are content, not
// spectrum accidents).
//
// Geometry: the crest is a SEGMENT p0→p1 (curved fronts = chain 2–3
// stamps). The pulse is a sech² ridge parallel to the segment, traveling
// along the segment's LEFT normal (swap endpoints to flip approach
// direction), with:
//   s  = along-crest coordinate (feathered at the ends),
//   d  = signed travel coordinate (0 on the authored line),
//   c(t) = pulse center: enters at −approachM, crosses 0, exits at
//          +approachM·STAMP_RELEASE_RATIO, then waits out the rest of the
//          period (the "set" gap). Pure function of field.time —
//          deterministic, replay/multiplayer-safe.
//   y  = A · life(c) · sech²((d−c)/width) · feather(s)
// life() ramps the pulse up across the approach and decays it after the
// line, so the authored line is where it PEAKS — the jump spot.
//
// Both samplers and the GPU vertex stage evaluate this identical closed
// form (uniformArray mirror like zones/wakes; constants drift-tested), so
// the kick the rider feels IS the wave the player saw coming. Stamps are
// NOT shoal-attenuated or set-enveloped (they're authored absolutes —
// author the rhythm via periodS/phase01 to sit on the track's set
// timing); a depth cap keeps a stamp placed over shallows from breaching
// the seabed.

/** Hard cap on stamps per track — sizes the GPU uniform arrays (unrolled
 *  loop), mirrored by `setWaveStamps` truncation. One signature wave per
 *  track is the design target; 8 leaves room for chained/multi-line
 *  set-ups. */
export const MAX_WAVE_STAMPS = 8
/** Along-crest end feather (m) — the ridge fades to zero across this span
 *  at both segment ends instead of stopping in a wall. */
export const STAMP_END_FEATHER_M = 6
/** The pulse's post-line travel, as a fraction of `approachM`: it decays
 *  across this distance past the authored line. */
export const STAMP_RELEASE_RATIO = 0.6
/** Depth cap: stamp amplitude ≤ STAMP_DEPTH_CAP · water depth where a
 *  shore field exists, so an authored wave over a sandbar can't push its
 *  trough through the seabed (same guard family as SHORE_DEPTH_CAP). */
export const STAMP_DEPTH_CAP = 0.6

/** Authoring shape — mirrors `Track.waveStamps[]` in track JSON. */
export type WaveStampInput = {
  /** Crest-line endpoints, world XZ. The pulse travels along the
   *  segment's LEFT normal (normalize(p1−p0) rotated −90°); swap the
   *  endpoints to flip the approach direction. */
  x0: number
  z0: number
  x1: number
  z1: number
  /** Peak ridge height at the authored line, metres. */
  amplitude: number
  /** sech² half-width along the travel direction, metres (~ how fat the
   *  ridge reads; 4–8 m rides like a jump face). */
  widthM: number
  /** Seconds between pulses — author this onto the track's set rhythm
   *  (swellSets.periodS or a divisor of it). */
  periodS: number
  /** Cycle offset, 0..1. */
  phase01?: number
  /** Pulse travel speed, m/s (the deep-water swell band reads ~8–12). */
  speed: number
  /** Approach run-up (m): the pulse fades in from −approachM and peaks at
   *  the line. Must fit the period: speed·periodS ≥ (1+RELEASE)·approachM
   *  — `setWaveStamps` warns and clamps approachM down otherwise. */
  approachM: number
}

export type WaveStampRuntime = WaveStampInput & {
  /** Unit along-crest direction (cached). */
  _ux: number
  _uz: number
  /** Segment length (cached). */
  _len: number
}

/**
 * Install (or clear) the track's authored wave stamps. Validates +
 * caches segment frames; truncates to {@link MAX_WAVE_STAMPS} (the GPU
 * evaluates a fixed-size array — a stamp felt but never drawn is the
 * exact desync this cap prevents); drops degenerate segments; clamps
 * `approachM` so the full enter→peak→exit life fits inside one period
 * (otherwise the pulse would teleport mid-life at the cycle wrap and
 * buoyancy would feel a discontinuity).
 */
export function setWaveStamps(field: WaveFieldState, stamps: readonly WaveStampInput[]): void {
  let kept = stamps
  if (stamps.length > MAX_WAVE_STAMPS) {
    // biome-ignore lint/suspicious/noConsole: authoring-time misuse warning
    console.warn(
      `[wave-field] ${stamps.length} wave stamps requested; capping at ${MAX_WAVE_STAMPS}. Dropping the rest.`,
    )
    kept = stamps.slice(0, MAX_WAVE_STAMPS)
  }
  const out: WaveStampRuntime[] = []
  for (const st of kept) {
    const ex = st.x1 - st.x0
    const ez = st.z1 - st.z0
    const len = Math.hypot(ex, ez)
    if (!(len > 1e-3) || !(st.amplitude > 0) || !(st.widthM > 0) || !(st.periodS > 0)) {
      // biome-ignore lint/suspicious/noConsole: authoring-time misuse warning
      console.warn('[wave-field] dropping degenerate wave stamp', st)
      continue
    }
    const travelSpan = st.speed * st.periodS
    const lifeSpan = (1 + STAMP_RELEASE_RATIO) * st.approachM
    let approachM = st.approachM
    if (lifeSpan > travelSpan) {
      approachM = travelSpan / (1 + STAMP_RELEASE_RATIO)
      // biome-ignore lint/suspicious/noConsole: authoring-time misuse warning
      console.warn(
        `[wave-field] wave stamp life (${lifeSpan.toFixed(0)} m) exceeds its period's travel ` +
          `(${travelSpan.toFixed(0)} m); clamping approachM ${st.approachM} → ${approachM.toFixed(1)}`,
      )
    }
    out.push({ ...st, approachM, _ux: ex / len, _uz: ez / len, _len: len })
  }
  field.stamps = out
}

// Reused scratch for the stamp contribution (same single-threaded pattern
// as `_shore`).
const _stamps = { y: 0, dydx: 0, dydz: 0, vy: 0 }

function stampSmoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Sum every stamp's contribution at world (x, z, t) into `_stamps`.
 * Slopes carry the pulse's travel-direction gradient only (the life/
 * feather envelope gradients are omitted — the same approximation class
 * as the shore wave's envelope); `vy` is EXACT (pulse motion + life
 * rate), finite-difference-tested, because hover damping reads it.
 * `depth` < 0 means "no shore field / unknown" → no depth cap.
 */
function computeStamps(
  field: WaveFieldState,
  x: number,
  z: number,
  t: number,
  depth: number,
): void {
  _stamps.y = 0
  _stamps.dydx = 0
  _stamps.dydz = 0
  _stamps.vy = 0
  const stamps = field.stamps
  for (const st of stamps) {
    const releaseM = st.approachM * STAMP_RELEASE_RATIO
    // Cycle phase → pulse center c ∈ [−approachM, …) sweeping at `speed`.
    const cyc = t / st.periodS + (st.phase01 ?? 0)
    const tt = cyc - Math.floor(cyc)
    const c = -st.approachM + tt * st.speed * st.periodS
    if (c > releaseM) continue // pulse done; waiting for the next set
    // Segment frame.
    const rx = x - st.x0
    const rz = z - st.z0
    const s = rx * st._ux + rz * st._uz
    if (s < -st.widthM || s > st._len + st.widthM) continue
    // Left normal = travel direction (pulse approaches from −n).
    const nx = -st._uz
    const nz = st._ux
    const d = rx * nx + rz * nz
    const xi = (d - c) / st.widthM
    if (xi < -6 || xi > 6) continue // sech² ≈ 0 past ±6
    // Life envelope: ramp in across the first 45 % of the approach, hold,
    // decay to zero by the release point. Zero at both cycle ends, so the
    // wrap teleport never moves a live pulse.
    const life =
      stampSmoothstep(-st.approachM, -st.approachM * 0.55, c) *
      (1 - stampSmoothstep(releaseM * 0.25, releaseM, c))
    if (life <= 0) continue
    const feather =
      stampSmoothstep(0, STAMP_END_FEATHER_M, s) *
      (1 - stampSmoothstep(st._len - STAMP_END_FEATHER_M, st._len, s))
    if (feather <= 0) continue
    let amp = st.amplitude
    if (depth >= 0) amp = Math.min(amp, STAMP_DEPTH_CAP * depth)
    if (amp <= 0) continue
    const sech = 1 / Math.cosh(xi)
    const sech2 = sech * sech
    const tanh = Math.tanh(xi)
    const envelope = amp * life * feather
    _stamps.y += envelope * sech2
    // ∂y/∂d = envelope · d/dd sech²(ξ) = envelope · (−2/w)·sech²·tanh.
    const dyDd = envelope * ((-2 / st.widthM) * sech2 * tanh)
    _stamps.dydx += dyDd * nx
    _stamps.dydz += dyDd * nz
    // ∂y/∂t — two exact terms: the pulse moving (ξ̇ = −ċ/w with ċ = speed)
    // and the life envelope changing. Feather is time-constant.
    const dLifeDc =
      smoothstepDeriv(-st.approachM, -st.approachM * 0.55, c) *
        (1 - stampSmoothstep(releaseM * 0.25, releaseM, c)) -
      stampSmoothstep(-st.approachM, -st.approachM * 0.55, c) *
        smoothstepDeriv(releaseM * 0.25, releaseM, c)
    _stamps.vy +=
      amp *
      feather *
      (dLifeDc * st.speed * sech2 + life * (2 / st.widthM) * sech2 * tanh * st.speed)
  }
}

/**
 * Public stamp sampler: every stamp's summed contribution at world
 * (x, z, t), depth-capped from the field's shore bake when present.
 * Returns a module-level scratch (single-threaded synchronous callers
 * read it immediately — same pattern as `_shore`). Used by both CPU
 * samplers and the render layer's `renderVertex` mirror.
 */
export function sampleStampsAt(
  field: WaveFieldState,
  x: number,
  z: number,
  t: number,
): { y: number; dydx: number; dydz: number; vy: number } {
  if (field.stamps.length === 0) {
    _stamps.y = 0
    _stamps.dydx = 0
    _stamps.dydz = 0
    _stamps.vy = 0
    return _stamps
  }
  const depth = field.shore ? (sampleShore(field.shore, x, z)?.depth ?? -1) : -1
  computeStamps(field, x, z, t, depth)
  return _stamps
}

/** d/dx smoothstep(a, b, x) — 6t(1−t)/(b−a) inside the band, 0 outside. */
function smoothstepDeriv(a: number, b: number, x: number): number {
  const t = (x - a) / (b - a)
  if (t <= 0 || t >= 1) return 0
  return (6 * t * (1 - t)) / (b - a)
}

export function createWaveField(waves: Wave[], opts?: { baseY?: number }): WaveFieldState {
  return {
    waves,
    wakes: [],
    trails: [],
    time: 0,
    baseY: opts?.baseY ?? 0,
    waveBearing: 0,
    zones: [],
    shore: null,
    shoreWaveStrength: 1,
    shoalSurfStrength: 1,
    stamps: [],
    rings: [],
    splashRingStrength: 1,
    steepness: 0,
    pinchCos: 1,
    pinchSin: 0,
    swellSetPeriodS: 0,
    swellSetDepth: 0,
    swellSetPhase: 0,
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
 * Hard cap on zones per field. The GPU water shader evaluates the zone
 * blend per vertex from a fixed-size uniform array (unrolled loop), so
 * the cap is a real shader-side limit — `setWaveZones` truncates to it
 * on the CPU too, keeping buoyancy and visuals in lockstep even for an
 * over-authored track. Shipped tracks use 1–2 zones; 8 leaves ample
 * headroom without paying per-vertex ALU for slots nothing uses.
 * `tests/unit/wave-zone.test.ts` asserts the truncation and that no
 * shipped track JSON exceeds the cap; the shader imports THIS constant
 * (drift-tested) rather than re-declaring it.
 */
export const MAX_WAVE_ZONES = 8

/**
 * Replace the field's zone list. Each input zone's quaternion is
 * decomposed to its world-Y yaw (the only rotation axis that matters
 * for an XZ-plane OBB test) and cached. Pass `[]` to clear.
 *
 * Zones beyond {@link MAX_WAVE_ZONES} are dropped (with a warning) —
 * the GPU shader can only evaluate that many, and a zone felt by
 * buoyancy but never drawn is exactly the desync this cap prevents.
 *
 * Idempotent — call it whenever a new track loads or the editor
 * mutates the zone list.
 */
export function setWaveZones(field: WaveFieldState, zones: readonly WaveZoneInput[]): void {
  let kept = zones
  if (zones.length > MAX_WAVE_ZONES) {
    // biome-ignore lint/suspicious/noConsole: authoring-time misuse warning
    console.warn(
      `[wave-field] ${zones.length} wave zones requested; capping at ${MAX_WAVE_ZONES} (the GPU shader evaluates a fixed-size zone array). Dropping the rest.`,
    )
    kept = zones.slice(0, MAX_WAVE_ZONES)
  }
  field.zones = kept.map((z) => {
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

// (The closed-form heading-ray wake — `sampleWakeFromSource` — was replaced
// by the trail-based `sampleWakeFromTrail` in wake-trail.ts: same Kelvin
// cross-profile, but "behind" is arc-distance back along the bike's RECORDED
// path instead of a ray from its current heading, so the felt wake curves
// with the line exactly like the drawn one.)

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
// Reused scratch for the per-trail wake contribution — same single-threaded
// pattern as `_shore`/`_disp` (`sampleWakeFromTrail` writes, the sampler
// loop reads immediately).
const _wake: WakeSampleOut = { y: 0, dydx: 0, dydz: 0 }

/** The shore wave's swell drive (shoaling v2): how hard the live ambient
 *  swell is pushing the surf band, normalised against the shipped default
 *  sea and clamped. Both samplers and the GPU evaluate it from the same
 *  mirrored scalars. `shoalSurfStrength` blends it away toward the legacy
 *  constant-amplitude behaviour (drive = 1). */
export function shoreSwellDrive(field: WaveFieldState, t: number = field.time): number {
  if (field.shoalSurfStrength <= 0) return 1
  let sum = 0
  for (const w of field.waves) {
    if (w.wavelength >= SWELL_WAVELENGTH_MIN) sum += Math.abs(w.amplitude)
  }
  const raw = (sum * waveSetFactor(field, t)) / SHORE_SWELL_DRIVE_REF
  const drive = Math.min(SHORE_SWELL_DRIVE_MAX, Math.max(SHORE_SWELL_DRIVE_MIN, raw))
  return 1 + (drive - 1) * Math.min(1, field.shoalSurfStrength)
}

/**
 * Evaluate the shore-aligned wave at world (x, z, t) into `_shore`. Single
 * source of truth so `sampleHeight` (reads `.y`) and `sampleSurface` (reads
 * `.y`, `.dydx`, `.dydz`, `.vy`) can never disagree on the height.
 *
 * Amplitude envelope: zero on dry land (`depth ≤ 0`) and in open water
 * (`depth ≥ SHORE_BAND_DEPTH`), peaking in the surf band; capped at
 * `SHORE_DEPTH_CAP · depth` so a trough never breaches the seabed; scaled
 * by the live swell drive (shoaling v2 — big sets send bigger breakers up
 * the beach). Phase `K·dist + Ω·t` marches crests shoreward; the waveform
 * carries a phase-locked second harmonic that leans each breaker's
 * shoreward face steeper than its back (`SHORE_ASYM`/`SHORE_ASYM_PHASE`),
 * fading in with `shoalSurfStrength`. Slopes are in WORLD frame (the
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
  // Swell drive scales the pre-cap amplitude; the depth cap still has the
  // final word so a driven trough can never breach the seabed.
  const drive = shoreSwellDrive(field, t)
  const ampCap = Math.min(SHORE_AMP * drive, SHORE_DEPTH_CAP * depth)
  const A = ampCap * bandGate * field.shoreWaveStrength
  if (A <= 0) return
  const phase = SHORE_K * s.dist + SHORE_OMEGA * t + SHORE_PHASE
  const sinP = Math.sin(phase)
  const cosP = Math.cos(phase)
  // Breaker-forward asymmetry: y/A = sin φ + a₂·sin(2φ + β). The harmonic
  // budget stays inside the seabed guard: |sin φ + a₂·sin(...)| ≤ 1 + a₂,
  // and SHORE_DEPTH_CAP (0.5) leaves 2× headroom against the column.
  const asym = SHORE_ASYM * Math.min(1, Math.max(0, field.shoalSurfStrength))
  const phase2 = 2 * phase + SHORE_ASYM_PHASE
  const sin2 = Math.sin(phase2)
  const cos2 = Math.cos(phase2)
  _shore.y = A * (sinP + asym * sin2)
  // ∂phase/∂x = K·nrmX (nrm = ∇dist, offshore, world frame); the harmonic
  // contributes at 2K. Envelope gradient omitted — matches the ambient
  // shoaling slope approximation.
  const waveSlope = A * SHORE_K * (cosP + 2 * asym * cos2)
  _shore.dydx = waveSlope * s.nrmX
  _shore.dydz = waveSlope * s.nrmZ
  // ∂y/∂t with phase = K·dist + Ω·t (harmonic at 2Ω). The drive's own
  // slow set-envelope rate is omitted (≤ cm/s — same approximation class
  // as the envelope gradient above).
  _shore.vy = A * SHORE_OMEGA * (cosP + 2 * asym * cos2)
  _shore.active = true
}

/** Live effective swell scale H_eff (m): the swell-band amplitude sum ×
 *  the set envelope, floored by {@link SHOAL_HEFF_MIN}. The denominator of
 *  the depth-limited break cap — both samplers and the GPU evaluate it
 *  from the same mirrored scalars (`waveAmpUniform` swell subset ×
 *  `setEnvNode`), so the break line can never disagree across sides. */
export function shoalEffectiveSwell(field: WaveFieldState, t: number = field.time): number {
  let sum = 0
  for (const w of field.waves) {
    if (w.wavelength >= SWELL_WAVELENGTH_MIN) sum += Math.abs(w.amplitude)
  }
  return Math.max(SHOAL_HEFF_MIN, sum * waveSetFactor(field, t))
}

/** The shoaling-v2 factor at `depth`, given the live swell scale `hEff` —
 *  Green's-law gain capped by depth-limited breaking (see the constants
 *  block above). Pure math shared by {@link shoalAttenuation} and the
 *  unit tests; the TSL shader mirrors it from the same constants. */
export function shoalSurfFactor(depth: number, hEff: number): number {
  if (depth <= 0) return 0
  const gain = Math.min(SHOAL_GAIN_MAX, Math.max(1, (SHOAL_GREEN_REF_DEPTH / depth) ** 0.25))
  const cap = (SHOAL_BREAK_GAMMA * depth) / Math.max(hEff, SHOAL_HEFF_MIN)
  return Math.min(gain, cap)
}

/**
 * Terrain shoaling factor at world (x, z) — the multiplier applied to the
 * ambient swell/chop (and its Gerstner displacement) so shallow water behaves,
 * mirroring the GPU vertex shader bit-for-bit. Reads the water depth from the
 * baked {@link ShoreField} (the same `waterLevel − terrainY` the shader
 * samples from the terrain heightmap; baked from the same heightmap + water
 * level, so they agree).
 *
 * Two regimes, blended by `field.shoalSurfStrength`:
 *  - LEGACY (strength 0): quadratic fade to flat below SHOAL_FADE_DEPTH —
 *    the original kill-switch.
 *  - SURF v2 (strength 1, default): Green's-law amplification as the swell
 *    feels the bottom, then a depth-limited breaking cap (γ·d / H_eff) that
 *    keeps waves alive — and breaking — right up the beach while doubling
 *    as the seabed guard (trough ≥ −γ·d > −d). See the §7.3 constants
 *    block.
 *
 * Returns 1 (full amplitude, no attenuation) when there's no shore field
 * installed (open water / editor / the `?waveriders=1` test map) or when the
 * sample is outside the baked terrain AABB (open horizon) — identical to the
 * shader's `terrainEnabledUniform = 0` / out-of-bounds fallback. Wakes are NOT
 * attenuated (they ride full strength, same as the shader); the shore wave has
 * its own depth cap in `computeShore`.
 */
export function shoalAttenuation(field: WaveFieldState, x: number, z: number): number {
  const shore = field.shore
  if (!shore) return 1
  const s = sampleShore(shore, x, z)
  if (!s) return 1
  const depth = s.depth
  // Open water: both regimes are exactly 1 beyond the deeper of their two
  // onset depths, so skip the math (and the v2 gain's fractional pow) for
  // the vast majority of samples.
  if (depth >= SHOAL_GREEN_REF_DEPTH) return 1
  if (depth <= 0) return 0
  const surf = field.shoalSurfStrength
  const v2 = surf > 0 ? shoalSurfFactor(depth, shoalEffectiveSwell(field)) : 0
  if (surf >= 1) return v2
  const raw = Math.min(1, depth / SHOAL_FADE_DEPTH)
  const legacy = raw * raw
  return legacy + (v2 - legacy) * surf
}

// ---- Gerstner horizontal-displacement inverse map -----------------------
//
// The GPU shader draws full Gerstner waves: besides the vertical heightfield
// it pushes each vertex SIDEWAYS toward crests (∝ Q·A) to sharpen them. So the
// rendered surface height at a world point (x,z) is the height of the rest
// vertex that displaced TO (x,z) — NOT the vertical-only Σ A·sin(phase(x,z)).
// To float buoyancy on exactly what the shader draws, we invert that
// displacement: find the rest (x0,z0) whose displaced position is (x,z), then
// evaluate the heightfield there. A few fixed-point iterations converge while
// the steepness budget stays sub-folding (see `effectiveSteepness`).

/** Fixed-point iterations for the inverse map. The displacement is a
 *  contraction with factor ≈ Σ Q·qBase·A·k (kept < the limit below), so 4
 *  steps drive the residual to sub-millimetre at game steepness. */
const GERSTNER_INVERSE_ITERS = 4
/** Hard ceiling on Σ Q·qBase·A·k. Past ~1 the Gerstner crest self-intersects
 *  (folds) and the inverse map stops being single-valued; clamping the
 *  effective steepness below this keeps it convergent AND auto-eases the
 *  pinch as the player cranks amplitude. */
export const STEEPNESS_SUM_LIMIT = 0.85
/** qBase used when a wave omits it (e.g. test-constructed waves). */
const Q_BASE_FALLBACK = 0.7

// Module scratch — single-threaded synchronous callers read immediately.
const _disp = { dx: 0, dz: 0 }
const _rest = { x: 0, z: 0 }

/** Σ qBase_i · |A_i| · k_i across the ambient waves — the steepness budget at
 *  Q = 1. The effective Q is clamped so Q · this ≤ {@link STEEPNESS_SUM_LIMIT}. */
export function steepnessSum(field: WaveFieldState): number {
  let s = 0
  for (const w of field.waves) {
    const k = (2 * Math.PI) / w.wavelength
    s += (w.qBase ?? Q_BASE_FALLBACK) * Math.abs(w.amplitude) * k
  }
  return s
}

/** Effective Gerstner steepness after the no-folding clamp. BOTH the CPU
 *  sampler (here) and the GPU shader (which reads this each frame) use it, so
 *  they displace by exactly the same amount. Returns 0 when steepness is off. */
export function effectiveSteepness(field: WaveFieldState): number {
  if (field.steepness <= 0) return 0
  const s = steepnessSum(field)
  return s > 0 ? Math.min(field.steepness, STEEPNESS_SUM_LIMIT / s) : field.steepness
}

/** Ambient Gerstner horizontal displacement at REST (x0, z0), world frame.
 *  Mirrors the shader's `gerstnerDisp` (global waves + bearing + pinch +
 *  per-zone height/freq/bearing factors, exactly as the shader does it).
 *  The zone factors are passed in pre-blended: the caller samples them ONCE
 *  at the world query point and reuses them for every inverse-map iteration
 *  — same approximation class as evaluating shoaling at the world point
 *  rather than the rest point (the displacement is sub-meter at game
 *  steepness while zone blend radii are tens of meters, so the factor
 *  difference across that distance is negligible). The GPU evaluates its
 *  zone factors at the rest-grid vertex; both land on the same surface to
 *  within that approximation. Writes `_disp`. */
function ambientDisp(
  field: WaveFieldState,
  x0: number,
  z0: number,
  qEff: number,
  heightMult: number,
  freqMult: number,
  cosB: number,
  sinB: number,
): void {
  const t = field.time
  const xRot = x0 * cosB + z0 * sinB
  const zRot = -x0 * sinB + z0 * cosB
  const pcos = field.pinchCos
  const psin = field.pinchSin
  let dxRot = 0
  let dzRot = 0
  for (const w of field.waves) {
    const k = ((2 * Math.PI) / w.wavelength) * freqMult
    const omega = w.speed * k
    const phase = k * (w.dirX * xRot + w.dirZ * zRot) - omega * t + w.phase
    const c = Math.cos(phase)
    const qScaled = qEff * (w.qBase ?? Q_BASE_FALLBACK)
    const rotDirX = w.dirX * pcos - w.dirZ * psin
    const rotDirZ = w.dirX * psin + w.dirZ * pcos
    dxRot += qScaled * rotDirX * w.amplitude * heightMult * c
    dzRot += qScaled * rotDirZ * w.amplitude * heightMult * c
  }
  _disp.dx = dxRot * cosB - dzRot * sinB
  _disp.dz = dxRot * sinB + dzRot * cosB
}

/** Invert the ambient Gerstner displacement: find the REST (x0,z0) whose
 *  displaced position is world (X,Z). Fixed-point iteration; writes `_rest`.
 *  Zone factors + effective bearing are threaded through to `ambientDisp`
 *  so the rest point matches the zone-modified surface the shader draws. */
function inverseGerstner(
  field: WaveFieldState,
  X: number,
  Z: number,
  qEff: number,
  heightMult: number,
  freqMult: number,
  cosB: number,
  sinB: number,
): void {
  let x0 = X
  let z0 = Z
  for (let i = 0; i < GERSTNER_INVERSE_ITERS; i++) {
    ambientDisp(field, x0, z0, qEff, heightMult, freqMult, cosB, sinB)
    x0 = X - _disp.dx
    z0 = Z - _disp.dz
  }
  _rest.x = x0
  _rest.z = z0
}

/** Surface y only — the cheap path used per-bike per-tick.
 *
 *  `includeWakes = false` returns the AMBIENT surface (no bike-wake trails):
 *  used by `wakeUpdateSystem`'s altitude→weight fade so the weight a bike
 *  deposits can't depend on wakes (its own or others') — that was previously
 *  guaranteed by clearing `field.wakes` before sampling, but trails persist
 *  across steps, so the exclusion is now explicit. */
export function sampleHeight(
  field: WaveFieldState,
  x: number,
  z: number,
  includeWakes = true,
): number {
  let y = field.baseY
  const t = field.time
  // Per-zone factors are blended once per sample. When no zones are
  // active the call returns the neutral (1, 1, no-bearing, 0) tuple,
  // so the multiplications below are no-ops and we avoid a branch
  // explosion across the two wave-field kinds.
  const zoneFx = sampleZoneFactors(field.zones, x, z, t)
  // Wave-set envelope folds into the same amplitude-multiplier slot the
  // zones use — one effective heightMult feeds the wave loop AND the
  // Gerstner inverse map, mirroring the GPU exactly (which multiplies
  // `setEnvNode` into the zone factor's heightMult on every layer).
  const envHeightMult = zoneFx.heightMult * waveSetFactor(field, t)
  const effectiveBearing = zoneFx.bearingRad ?? field.waveBearing
  const cosB = Math.cos(effectiveBearing)
  const sinB = Math.sin(effectiveBearing)
  // Gerstner: float on what the shader DRAWS at (x,z) — the height of the rest
  // vertex that displaced to (x,z). Inverse-map the ambient displacement;
  // (ax,az) is that rest point. Off (steepness 0) → ax,az = x,z, the legacy
  // vertical-only path (unit tests unchanged). Wakes/shore/surge stay at the
  // world point, matching the shader.
  // Terrain shoaling: fade the ambient waves toward flat in shallow water,
  // identical to the GPU. Also scales the Gerstner displacement fed to the
  // inverse map (the shader displaces by `shoal · disp`), so the rest point
  // we solve for matches the surface the shader actually draws.
  const shoal = shoalAttenuation(field, x, z)
  let ax = x
  let az = z
  const qEff = effectiveSteepness(field) * shoal
  if (qEff > 1e-6) {
    inverseGerstner(field, x, z, qEff, envHeightMult, zoneFx.freqMult, cosB, sinB)
    ax = _rest.x
    az = _rest.z
  }
  // Rotate sample coords by -bearing — equivalent to rotating each
  // per-wave direction by +bearing. Lets one global angle re-aim the
  // whole wave train without mutating per-wave dirX/dirZ.
  const xRot = ax * cosB + az * sinB
  const zRot = -ax * sinB + az * cosB
  for (const w of field.waves) {
    // freqMult shortens the wavelength inside the zone — chop bands
    // become choppier, swells get tighter. heightMult (zone × set
    // envelope) scales the amplitude.
    const k = ((2 * Math.PI) / w.wavelength) * zoneFx.freqMult
    const omega = w.speed * k
    const phase = k * (w.dirX * xRot + w.dirZ * zRot) - omega * t + w.phase
    y += shoal * envHeightMult * w.amplitude * Math.sin(phase)
  }
  y += zoneFx.surgeY
  if (includeWakes) {
    for (const tr of field.trails) {
      sampleWakeFromTrail(tr, x, z, t, _wake)
      y += _wake.y
    }
  }
  // Shore-aligned wave — rideable breakers in the near-shore band.
  computeShore(field, x, z, t)
  if (_shore.active) y += _shore.y
  // Authored wave stamps — the signature jump waves (depth-capped where a
  // shore field exists so an over-shallows stamp can't breach the seabed).
  // Evaluated at the REST point (ax, az), not the world query point: the
  // GPU adds the stamp at the rest vertex and then displaces it sideways
  // with the ambient pinch, and a stamp's 6 m-scale face is steep enough
  // that the half-metre pinch offset is a real felt-vs-drawn gap (the
  // sync spec measured ~4 cm) — unlike the tens-of-metres zone blends
  // where the world-point approximation is fine.
  if (field.stamps.length > 0) {
    y += sampleStampsAt(field, ax, az, t).y
  }
  // Splash rings — landing waves other riders feel. Rest-point evaluation
  // for the same reason as stamps (2 m-scale faces vs the pinch offset).
  if (field.rings.length > 0) {
    y += sampleSplashRings(field, ax, az, t).y
  }
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
  // Zone × wave-set envelope — one effective amplitude multiplier, exactly
  // as in `sampleHeight` (and the GPU). The envelope is itself a function
  // of time, so `vy` picks up an extra `env'(t) · Σ ambient` term below.
  const envFactor = waveSetFactor(field, t)
  const envHeightMult = zoneFx.heightMult * envFactor
  const effectiveBearing = zoneFx.bearingRad ?? field.waveBearing
  const cosB = Math.cos(effectiveBearing)
  const sinB = Math.sin(effectiveBearing)
  // Gerstner inverse-map (same as sampleHeight) so the surface height here
  // matches buoyancy AND the shader. Slopes/vy are evaluated at the rest
  // point — a good approximation of the rendered Gerstner normal for tilt.
  // Terrain shoaling — see `sampleHeight`. Mirrors the GPU's shallow-water
  // fade on the ambient height, slopes, vertical velocity AND the Gerstner
  // displacement, so buoyancy floats on exactly the surface drawn.
  const shoal = shoalAttenuation(field, x, z)
  let ax = x
  let az = z
  const qEff = effectiveSteepness(field) * shoal
  if (qEff > 1e-6) {
    inverseGerstner(field, x, z, qEff, envHeightMult, zoneFx.freqMult, cosB, sinB)
    ax = _rest.x
    az = _rest.z
  }
  const xRot = ax * cosB + az * sinB
  const zRot = -ax * sinB + az * cosB
  let ambientY = 0
  for (const w of field.waves) {
    const k = ((2 * Math.PI) / w.wavelength) * zoneFx.freqMult
    const omega = w.speed * k
    const phase = k * (w.dirX * xRot + w.dirZ * zRot) - omega * t + w.phase
    const s = Math.sin(phase)
    const c = Math.cos(phase)
    const a = shoal * envHeightMult * w.amplitude
    y += a * s
    ambientY += a * s
    rotDydx += a * c * (k * w.dirX)
    rotDydz += a * c * (k * w.dirZ)
    vy += a * c * -omega
  }
  // Envelope rate term: y = env(t)·f(x,z,t) ⇒ ∂y/∂t = env·f' (the loop
  // above, since `a` carries env) + env'·f. `ambientY` IS env·f, so
  // env'·f = ambientY · (env'/env). env is bounded away from 0 (depth is
  // clamped ≤ 0.6 at the setters), so the division is safe; when the
  // envelope is off the rate is 0 and this is a no-op.
  if (envFactor > 1e-6) {
    vy += ambientY * (waveSetFactorRate(field, t) / envFactor)
  }
  // Surge adds height only — its ∂/∂x and ∂/∂z are zero (uniform
  // inside the zone's weight envelope), so we don't bias slopes /
  // normals here. The bike's buoyancy reads `y` directly, which is
  // what authors want from a "the whole zone lifts" surge.
  y += zoneFx.surgeY
  // Convert rotated-frame slopes back to world frame.
  let dydx = rotDydx * cosB - rotDydz * sinB
  let dydz = rotDydx * sinB + rotDydz * cosB
  for (const tr of field.trails) {
    sampleWakeFromTrail(tr, x, z, t, _wake)
    y += _wake.y
    dydx += _wake.dydx
    dydz += _wake.dydz
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
  // Authored wave stamps — world-frame slopes (the pulse travels along
  // its own segment normal), added after the bearing back-rotation like
  // the wake/shore terms.
  if (field.stamps.length > 0) {
    // Rest-point evaluation — see the sampleHeight note.
    const st = sampleStampsAt(field, ax, az, t)
    y += st.y
    dydx += st.dydx
    dydz += st.dydz
    vy += st.vy
  }
  if (field.rings.length > 0) {
    const rg = sampleSplashRings(field, ax, az, t)
    y += rg.y
    dydx += rg.dydx
    dydz += rg.dydz
    vy += rg.vy
  }
  // Normal of y = f(x, z) is (−∂y/∂x, 1, −∂y/∂z), normalized.
  const nx = -dydx
  const ny = 1
  const nz = -dydz
  const len = Math.hypot(nx, ny, nz)
  return { y, nx: nx / len, ny: ny / len, nz: nz / len, vy }
}

/**
 * Swell/chop classification threshold (m). Waves at or above this
 * wavelength are "swell" — the long-period components that carry the
 * sea's readable silhouette; everything shorter is "chop" texture.
 * Consumed by the render layer (the swell-only outer/skirt geometry,
 * the P1 readability field, the debug menu's swell/chop sliders) and by
 * the spectrum generator's energy-tilt + sorting (spectrum.ts), so the
 * classification can never disagree across sim and render. The default
 * bank's split lands exactly where it was hand-tagged: 50 m + 85 m
 * swells above, 4–16 m chop below.
 */
export const SWELL_WAVELENGTH_MIN = 30

/**
 * The per-band amplitude scales the SHIPPED LOOK runs at. The water
 * debug menu's swell/chop sliders default to these, and
 * `applyStoredWaterTuning` applies them at every boot (storage empty or
 * not) — so the sea every track was graded against is `defaultWaves()`
 * with its swells ×3.2 and its chop ×0.9, NOT the raw bank. Single
 * source shared by the menu defaults (water.ts) and the spectrum
 * generator (spectrum.ts), which works in this post-scale "effective"
 * space and pre-divides its output so the boot-time stomp lands every
 * generated bank exactly on its designed sea. If the look re-tunes
 * these, generated banks follow automatically.
 */
export const DEFAULT_SWELL_TUNING_SCALE = 3.2
export const DEFAULT_CHOP_TUNING_SCALE = 0.9

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
  // `qBase` is the per-wave steepness coefficient (chops pinch sharper than
  // swells); it must stay index-aligned with the GPU shader's bake so CPU
  // buoyancy and the rendered crest displace identically.
  return [
    // Primary swell — the dominant set rolling toward the bike.
    { dirX: 1.0, dirZ: 0.0, amplitude: 0.5, wavelength: 50, speed: 8.6, phase: 0.4, qBase: 0.35 },
    // Secondary swell — same direction, slightly different period so the
    // two swells beat into bigger "sets" every ~24 s.
    //
    // P2.1 note (water-next-research §7.2): this accidental bichromatic
    // pair STAYS as the global texture-level beat. The per-track,
    // AUTHORABLE set rhythm is the separate `swellSets` envelope
    // (waveSetFactor) rather than re-spacing this pair per track — hitting
    // a target beat period bichromatically means resolving λ₁ from the
    // dispersion relation (detuning phase speed instead reads wrong;
    // players subconsciously track group timing), which changes the
    // silhouette per track. The envelope is orthogonal, exact on both
    // sides, and leaves this bank alone.
    {
      dirX: 0.985,
      dirZ: 0.174,
      amplitude: 0.35,
      wavelength: 85,
      speed: 11.2,
      phase: 2.2,
      qBase: 0.35,
    },
    // Mid-band chop riding the swell face, dead-on with the bearing.
    { dirX: 1.0, dirZ: 0.0, amplitude: 0.22, wavelength: 16, speed: 5.0, phase: 0.0, qBase: 0.85 },
    // Cross-chop fanned ±25° around the bearing for surface variety
    // without re-introducing the omni-directional jostle.
    {
      dirX: 0.906,
      dirZ: 0.423,
      amplitude: 0.16,
      wavelength: 10,
      speed: 4.0,
      phase: 1.1,
      qBase: 0.95,
    },
    { dirX: 0.94, dirZ: -0.342, amplitude: 0.1, wavelength: 6, speed: 3.1, phase: 2.3, qBase: 1.0 },
    {
      dirX: 0.985,
      dirZ: 0.174,
      amplitude: 0.06,
      wavelength: 4,
      speed: 2.5,
      phase: 3.7,
      qBase: 1.0,
    },
  ]
}
