/**
 * Hover-system tuning constants — the single home for every feel knob the
 * hover subsystem reads.
 *
 * Split out of `hover.ts` (docs/systems-review.md §4/§5): this file gathers
 * BOTH the top-of-file exported feel block (re-used by the slope-momentum
 * unit test + the hover-debug overlay) AND the ~40 constants that used to
 * live inline in function bodies, so a tuning sweep has one place to look.
 * The "why" comments move with their constants — they encode hard-won
 * playtest rationale, not incidental notes.
 *
 * Pure leaf module: no Three, no physics, no `devSettings` singleton. The
 * live-tunable probe geometry + steer-release knobs flow through `SimTuning`
 * (see `sim-step.ts`), NOT through constants here.
 */

import { slopeAwareSweetSpot, TUCK_SCRAPE_FLOOR, TUCK_SWEET_SPOT, tuckFactor } from './tuck-curve'

// ── Probe ─────────────────────────────────────────────────────────────────

export const MAX_HOVER_PROBE = 6

// ── Frame / slope filtering ────────────────────────────────────────────────

/**
 * Fallback gravity magnitude for the `slopeMomentumAccel` default argument
 * (tests import the helper without spinning up a Rapier world). The live
 * hover loop reads gravity from `phys.world.gravity.y` each tick so a
 * change to the physics world's gravity propagates automatically — no
 * second hardcoded copy that can drift.
 */
export const DEFAULT_GRAVITY = 25

/** Time constant (s) of the surface-slope low-pass filter. Single-tick
 *  jitter on lumpy trimeshes (probe sample crossing a mesh edge, e.g.)
 *  used to spike climb-assist and the pitch PD target with raw bow/stern
 *  reads; a ~50ms low-pass cleans that up without losing responsiveness.
 *  At dt=1/60 this gives ~28% catch-up per tick (~150ms to settle). */
export const SLOPE_FILTER_TAU = 0.05

/** Air-roll-leveler taper bounds. Below LO (60°) the leveler runs at full
 *  authority; above HI (80°) it disengages entirely so a committed
 *  backflip isn't fought. Linearly faded between for a continuous handoff
 *  (no snap when re-entering the band). */
export const AIR_ROLL_TAPER_LO = (60 * Math.PI) / 180
export const AIR_ROLL_TAPER_HI = (80 * Math.PI) / 180

/** Bad-landing crash thresholds (land only, anti-grav exempt). */
export const BAD_LAND_PITCH = Math.PI / 3 // 60° off the surface contour
export const BAD_LAND_MIN_SPEED = 8 // m/s — slow tumbles just snap, no crash
export const BAD_GROUND_PITCH = (75 * Math.PI) / 180

/** Safety clamp on stats.surfaceFollow when mapped to the water
 *  longitudinal spring multiplier. Authoring outside this range is an
 *  authoring mistake; clamping prevents pathological launch / dive feel.
 *  Tuning band: ~0.4 = "plough" (heavy boat); ~0.85 = "attentive default";
 *  ~1.05 = "jet ski" (rides every ripple). */
export const SURFACE_FOLLOW_MIN = 0.1
export const SURFACE_FOLLOW_MAX = 1.5

/** Probe-spring-grounded gate. A corner whose local surface is further than
 *  this multiple of hoverHeight below the probe is "off the surface" and
 *  skipped by the spring — prevents the bow probe from firing a giant
 *  DOWN force off a ramp lip ("sticky nose" nose-dive). The same multiple
 *  decides whether the center probe sees the bike as grounded. */
export const GROUNDED_DISTANCE_MUL = 1.6

/** Hysteresis for the per-end (nose / base) grounded flags written to
 *  HoverState. An end already grounded lifts off when its local distance
 *  exceeds the full cutoff; an end already airborne only re-grounds once
 *  it drops back below `cutoff * NOSE_REGROUND_FRAC`. The gap debounces
 *  chattery trimesh edges around the threshold so a single lumpy tick
 *  can't flicker the trick-arming pop — small bumps are absorbed, a real
 *  lip flips the flag and holds it. Trigger-side only; the spring's own
 *  per-corner skip gate is unchanged. */
export const NOSE_REGROUND_FRAC = 0.85

// ============================================================================
// Exported feel constants (re-used by the slope-momentum unit test +
// the hover-debug overlay)
// ============================================================================

// Slope-momentum tuning — strongly asymmetric. A hard 1.0× push DOWN a wave
// face for the motocross slingshot, but only a feather-light 0.15× drag
// going UP. The hoverbike is supposed to glide up steep terrain (SF /
// Seattle grades, ramp faces) the way a real hover platform would — the
// engine fights gravity, it doesn't drag the chassis. Keep asymmetry > 1
// so the down/up ratio guard in slope-momentum.test still holds and the
// downhill payoff stays distinct.
export const SLOPE_DOWN_GAIN = 1.0
export const SLOPE_UP_BRAKE = 0.15

// Slope-aware hover-height boost. On a climb (or descent) the bike rides
// proportionally higher than the nominal `hoverHeight`, so the chassis
// stays well clear of the rising trimesh. 0.4 reads as "the bike floats
// over the hill" in playtest without over-tuning launch behaviour on
// lumpy terrain.
export const SLOPE_HOVER_BOOST = 0.4

// Fraction of slope-tangent velocity the hover damp is allowed to ignore.
// At 1.0, damp fires zero when the bike is climbing at exactly the
// slope-tangent rate — but then any spring spike (lumpy terrain mid-
// climb) goes unchecked. At 0.0, damp fires full (~70 m/s² downward force
// on a 25° hill at 18 m/s, overwhelms the spring, chassis drags). 0.5
// is the playtested middle.
export const SLOPE_DAMP_RELIEF = 0.5

// Water analogue of SLOPE_DAMP_RELIEF. On water the surface itself moves
// vertically (the wave's ∂y/∂t), so the hover damp's "excess upward velocity"
// reference is the wave's vertical velocity, not zero. At 1.0 the bike is free
// to ride straight up a rising crest (only velocity BEYOND the wave's is
// damped); at 0 it falls back to the legacy "damp any lift-off" behaviour that
// let tall fast crests overtake and submerge the bike. This is the core of the
// "ride on top of big waves" feel — the spring tracks the surface instead of
// fighting it.
export const WATER_SURFACE_FOLLOW = 1.0

// Upper clamp on the per-corner heightError fed into the hover spring.
// When the bow probe looks ahead at a steep climb, localDist goes deeply
// negative, and heightError grows unbounded. Clamping to one hoverHeight
// caps the corner kick to ~40 m/s² (~1.6 G); past the clamp the slope-
// momentum path still pre-pitches the chassis to climb.
export const MAX_BOW_LIFT_ERROR = 1.2 // metres, ≈ one hoverHeight

// Dive model — pitch-down input is rate-limited via a per-bike
// `diveHoldS` timer (see HoverState). On the rising edge of nose-down
// input the player's torque starts at DIVE_KICK_TORQUE_MUL × baseline
// and tapers linearly to zero over DIVE_KICK_DURATION_S. After that
// the grounded pitch PD (full-strength P) pulls the chassis back to
// surface-tangent attitude (parallel to slope on hills, level on
// flat). Sustained nose-down input then reads as ALTITUDE CONTROL
// via DIVE_HOVER_HEIGHT_MIN_MUL, not chassis tilt — the bike sinks
// lower while staying parallel.
//
// Bow / stern corner-spring boost curves (earlier iterations) are gone
// — with the chassis returning to level via PD, both ends naturally
// equilibrate at the lowered effHover and the per-corner asymmetry
// isn't needed.
export const DIVE_KICK_DURATION_S = 0.22
export const DIVE_KICK_TORQUE_MUL = 1.3

// Release kick — mirror of the dive kick that fires when the player
// LETS GO of a held nose-down input. Brief nose-UP torque so the bow
// leads as the bike rises back to baseline hover height. Triggered
// only when the prior dive lasted at least MIN_DIVE_FOR_RELEASE_S
// (avoids firing on a quick tap that didn't actually dive).
// Re-pressing pitch-down cancels the release kick.
export const RELEASE_KICK_DURATION_S = 0.18
export const RELEASE_KICK_TORQUE_MUL = 0.7
export const MIN_DIVE_FOR_RELEASE_S = 0.05

// Target hover height drops to this fraction of stats.hoverHeight at
// full pitch-down intent (linear ramp on |intent.pitch|). Slope-aware
// hover-height boost is applied AFTER this scale, so slopes still get
// their normal climb margin — only the level-flight target sinks.
export const DIVE_HOVER_HEIGHT_MIN_MUL = 0.5

// ── Drift physics modulation (read in `applyGroundBranch`) ─────────
// While `DriftState.driftDir` is non-zero, the bike's lateral drag is
// scaled down (so the bike actually slides sideways like an MK kart in
// drift), and the yaw torque is replaced by a drift-direction bias +
// reduced player authority. See [docs/drift-deep-dive.md] for the
// design rationale.

/** Fraction of `stats.lateralDrag` retained while drifting. Lower
 *  = more visible slide; too low (<0.2) and the bike fishtails out
 *  of control. 0.35 reads as a clean MK-style slide that the player
 *  can still hold against. */
export const DRIFT_LATERAL_DRAG_SCALE = 0.35

/** Drift auto-turn-in bias as a fraction of `stats.turnTorque`. With
 *  no steer input the bike carves into the corner at this rate. Kept
 *  modest so the default arc is WIDE (MK-style) rather than a tight
 *  spiral — at `turnTorque=4` + the chassis angular damping this is
 *  ~0.7 rad/s → ~28 m radius at 20 m/s. Counter-steer
 *  (`DRIFT_STEER_FRAC`) can fully cancel it for an even wider line. */
export const DRIFT_YAW_BIAS_FRAC = 0.45

/** Player steer authority while drifting, as a fraction of
 *  `stats.turnTorque`. Sized so a FULL counter-steer cancels the
 *  auto-turn-in bias: the player's steer is pre-scaled to ~0.7 max
 *  (PLAYER_STEER_SCALE), so `0.65 × 0.7 ≈ 0.455 ≈ DRIFT_YAW_BIAS_FRAC`
 *  — holding away from the corner opens the drift to a straight,
 *  wide line; steering in tightens it. This is the knob that makes
 *  the drift feel like Mario Kart instead of a fixed spiral. */
export const DRIFT_STEER_FRAC = 0.65

/** Speed (m/s) at/above which the auto-turn-in bias runs at full
 *  strength. Below it the bias tapers linearly to zero, so a drift
 *  that has bled speed stops auto-rotating instead of whipping the
 *  bike around to a 180 (the classic low-speed drift spin-out). Only
 *  the BIAS tapers — the player's counter-steer keeps full authority
 *  at any speed so they can always straighten out. */
export const DRIFT_YAW_SPEED_REF = 8

/** Inside-drift "snap" window — duration of the initial bias spike
 *  for `driftStyle: 'inward'` bikes. Within this window the drift
 *  yaw bias is scaled by `INWARD_INITIAL_BIAS_MUL`; past it, the
 *  scale drops to `INWARD_TAIL_BIAS_MUL` so the overall arc widens.
 *  Read by the inward-drift branch in `applyGroundBranch`. */
export const INWARD_INITIAL_WINDOW_S = 0.25
export const INWARD_INITIAL_BIAS_MUL = 1.2
export const INWARD_TAIL_BIAS_MUL = 0.8

// Chassis pitch (relative to the surface tangent) safety clamp on the
// dive side. The dive-kick taper above bounds steady-state tilt to a
// small angle already; this limit is a backstop for momentum carried
// out of the kick or rapid-tap accumulation. Past the limit the
// player's nose-down torque is suppressed. Upper (wheelie) band
// still uses the original 45° committed-trick cutoff.
//
// Player-torque suppression also fires when AIRBORNE over water:
// without it, a brief pop off a wave crest lets the rider feed in more
// nose-down torque unopposed and complete a forward flip. There is NO
// air-side PD by design (no auto-leveling), so residual angular
// velocity carried airborne can still rotate the chassis somewhat —
// just no fresh torque input past the limit.
export const DIVE_PITCH_FWD_LIMIT_DEG = 12
export const DIVE_PITCH_FWD_LIMIT_RAD = (DIVE_PITCH_FWD_LIMIT_DEG * Math.PI) / 180

// ── Submerged buoyancy / drag (multi-point spring, water branch) ────────────
// The buoyancy pair below previously appeared TWICE inside
// `applyMultiPointHoverSpring` (once in the submerged single-point branch,
// once in the per-corner loop). Named once here (docs/systems-review.md §5).

/** Buoyancy acceleration per metre of submersion (m/s² per m). */
export const BUOYANCY_PER_M = 14
/** Cap on buoyancy acceleration so a deep dive walks back up at a bounded
 *  rate instead of slamming. */
export const BUOYANCY_CAP = 20

// Asymmetric Y-axis drag (submerged single-point branch): full strength when
// SINKING (kills dive momentum so the bike actually slows as it reaches max
// depth), much weaker when RISING so accumulated buoyancy isn't fought by
// drag on the way up.
export const DRAG_K_HORIZ = 0.1
export const DRAG_K_SINK = 0.1
export const DRAG_K_RISE = 0.03

// Per-point mass fraction for the multi-point hover spring (bow/stern/
// port/starboard each carry 1/4 of the chassis).
export const POINT_MASS_FRAC = 0.25

// ── Grounded pitch PD ────────────────────────────────────────────────────
export const GROUNDED_PITCH_P = 9 // rad/s² per rad of error
export const GROUNDED_PITCH_D = 3 // rad/s² per rad/s
// Upper-band cutoff at 45° lets a committed wheelie/backflip run free
// (P drops to 0 past the cutoff, only D damps).
export const PITCH_UPPER_BAND_RAD = (45 * Math.PI) / 180

// ── Player pitch torque ──────────────────────────────────────────────────
// Grounded torque coefficient (both pitch directions). Paired with the
// grounded pitch PD (P=9, D=3, ±45° band); equilibrium under a held wheelie
// is ~21° on land / ~31° on water — committed but bounded. Also drives the
// release-kick magnitude and the motocross-pivot rebalance below.
// (Previously the bare literal `7` appeared 3× — named once here, §5.)
export const GROUND_PITCH_COEF = 7
// Air torque coefficient: 60% of the prior 3.0 — air pitch felt twitchy at
// 3.0. 1.8 stretches a full backflip to ~3s while keeping fwd.y monotonic
// over the 1s m9-air-control sample window.
export const AIR_PITCH_COEF = 1.8
// Off-center rebalance — motocross pivot. 0.3m = capsule halfHeight (see
// bike.ts collider) — lines up with the chassis end visually.
export const PIVOT_OFFSET = 0.3
// I_pitch ≈ m·0.34 for the capsule (see the torque-coefficient comment in
// applyPlayerPitchTorque) — used to convert the torque impulse into the Δω
// the pivot rebalance cancels.
export const PITCH_INERTIA_COEF = 0.34

// ── Air control branch ───────────────────────────────────────────────────
// Hang-time: counter ~60% of gravity so the bike floats through arcs
// JetMoto-style instead of dropping like a brick.
export const AIR_LIFT_FRAC = 0.6
// Airborne thrust is slightly weaker than ground thrust so the player can't
// infinite-hover by aiming up + boost.
export const AIR_THRUST_MUL = 0.85
// Reduced air yaw authority — preserved for landing alignment.
export const AIR_TURN_MUL = 0.3
// Air roll leveler PD gains (gentle pull toward zero roll over ~2s).
export const AIR_ROLL_P = 3
export const AIR_ROLL_D = 2

// ── Ground branch ────────────────────────────────────────────────────────
/** Peak braking deceleration at full brake (m/s²). */
export const BRAKE_ACCEL = 18
/** Thrust multiplier on water (extra drag — slightly less responsive). */
export const WATER_THRUST_MUL = 0.85
/** Climb assist: compensate this fraction of the gravity-along-slope tax as
 *  extra forward thrust so climbs read closer to flat-ground speed. */
export const CLIMB_ASSIST_FRAC = 0.7
// Velocity redirect into the slope tangent on a fast steep climb.
export const REDIRECT_RATE = 10 // soft pull, ~70 ms half-life
// Landing-momentum redirect (motocross "hit the lip right" reward).
export const LANDING_REDIRECT_MAX = 0.7
export const LANDING_REDIRECT_SLOPE_FULL = Math.PI / 4 // 45° = full payoff
// Water yaw gets a touch more bite.
export const WATER_TURN_MUL = 1.1
// Fishtail bias — shifts the perceived yaw pivot forward of CoM.
export const YAW_PIVOT_FWD = 0.7 // metres forward of CoM
// Roll PD (ground, non-anti-grav).
export const ROLL_LEAN_LIMIT = (40 * Math.PI) / 180 // 40° at "normal" speed
export const LEAN_SPEED_FULL = 6
export const LEAN_SPEED_HIGH = 24
export const LEAN_HIGH_SPEED_BOOST = 0.5 // up to 50% more lean → ~60°
export const LEAN_BASE = 0.4 // stationary = 40% of base limit (~16°)
export const ROLL_P = 40
export const ROLL_D = 8
// Lateral drag: water has more lateral resistance (skis don't slide
// sideways easily).
export const WATER_LATERAL_DRAG_MUL = 1.4

// ── P4.2 wave-feel prototype gains (DEV-FLAGGED, default OFF) ───────────────
export const WAVE_PUSH_GAIN = 1.2 // m/s² per (m/s rise × alignment) at gain 1
export const DRAFT_GAIN = 1.5 // m/s² at full trough, gain 1
/** Wake-trough depth (m) at which the draft boost saturates. */
export const DRAFT_TROUGH_SAT = 0.15

// ── Anti-grav trailing corrections ──────────────────────────────────────────
export const AG_ALIGN_P = 20
export const AG_ALIGN_D = 5

// ── Re-exports of the tuck-curve leaf (kept here so the orchestrator
//    facade re-exports them from a single hover-tuning surface) ──────────────
// `tuckFactor` + its constants live in ./tuck-curve (a pure, test-pinned
// leaf so the making-of demo can import them without dragging in this
// module's physics graph). Re-exported so existing call sites keep
// importing them from `@/game/systems/hover`.
export { slopeAwareSweetSpot, TUCK_SCRAPE_FLOOR, TUCK_SWEET_SPOT, tuckFactor }
