import type RAPIER from '@dimforge/rapier3d-compat'
import { query } from 'bitecs'
import { devSettings } from '@/engine/dev-settings'
import { isHoverDebugEnabled } from '@/engine/sim/debug-flags'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate } from '@/engine/sim/physics/vec'
import { sampleHeight, type WaveFieldState } from '@/engine/sim/water/wave-field'
import {
  AntiGravOverrideStore,
  BikeStats,
  type BikeStatsData,
  BikeStatsStore,
  BikeTag,
  BoostMeterStore,
  ControlIntent,
  type ControlIntentData,
  ControlIntentStore,
  HoverDebugStore,
  HoverState,
  HoverStateStore,
  type HoverProbe,
  RBHandle,
  RBHandleStore,
} from '@/game/components'
import { getCurrentBoostMultiplier } from '@/game/systems/pickup'

// ============================================================================
// Module constants
// ============================================================================

const MAX_HOVER_PROBE = 6

/**
 * Fallback gravity magnitude for the `slopeMomentumAccel` default argument
 * (tests import the helper without spinning up a Rapier world). The live
 * hover loop reads gravity from `phys.world.gravity.y` each tick so a
 * change to the physics world's gravity propagates automatically — no
 * second hardcoded copy that can drift.
 */
const DEFAULT_GRAVITY = 25

/** Time constant (s) of the surface-slope low-pass filter. Single-tick
 *  jitter on lumpy trimeshes (probe sample crossing a mesh edge, e.g.)
 *  used to spike climb-assist and the pitch PD target with raw bow/stern
 *  reads; a ~50ms low-pass cleans that up without losing responsiveness.
 *  At dt=1/60 this gives ~28% catch-up per tick (~150ms to settle). */
const SLOPE_FILTER_TAU = 0.05

/** Air-roll-leveler taper bounds. Below LO (60°) the leveler runs at full
 *  authority; above HI (80°) it disengages entirely so a committed
 *  backflip isn't fought. Linearly faded between for a continuous handoff
 *  (no snap when re-entering the band). */
const AIR_ROLL_TAPER_LO = (60 * Math.PI) / 180
const AIR_ROLL_TAPER_HI = (80 * Math.PI) / 180

/** Bad-landing crash thresholds (land only, anti-grav exempt). */
const BAD_LAND_PITCH = Math.PI / 3 // 60° off the surface contour
const BAD_LAND_MIN_SPEED = 8 // m/s — slow tumbles just snap, no crash
const BAD_GROUND_PITCH = (75 * Math.PI) / 180

/** Safety clamp on stats.surfaceFollow when mapped to the water
 *  longitudinal spring multiplier. Authoring outside this range is an
 *  authoring mistake; clamping prevents pathological launch / dive feel.
 *  Tuning band: ~0.4 = "plough" (heavy boat); ~0.85 = "attentive default";
 *  ~1.05 = "jet ski" (rides every ripple). */
const SURFACE_FOLLOW_MIN = 0.1
const SURFACE_FOLLOW_MAX = 1.5

/** Probe-spring-grounded gate. A corner whose local surface is further than
 *  this multiple of hoverHeight below the probe is "off the surface" and
 *  skipped by the spring — prevents the bow probe from firing a giant
 *  DOWN force off a ramp lip ("sticky nose" nose-dive). The same multiple
 *  decides whether the center probe sees the bike as grounded. */
const GROUNDED_DISTANCE_MUL = 1.6

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

// Upper clamp on the per-corner heightError fed into the hover spring.
// When the bow probe looks ahead at a steep climb, localDist goes deeply
// negative, and heightError grows unbounded. Clamping to one hoverHeight
// caps the corner kick to ~40 m/s² (~1.6 G); past the clamp the slope-
// momentum path still pre-pitches the chassis to climb.
export const MAX_BOW_LIFT_ERROR = 1.2 // metres, ≈ one hoverHeight

// Dive model — pitch-down input is rate-limited via a per-bike
// `diveHoldS` timer (see HoverState). On the rising edge of nose-down
// input the player's torque starts at full strength and tapers linearly
// to zero over DIVE_KICK_DURATION_S. After that the grounded pitch PD
// (full-strength P) pulls the chassis back to surface-tangent attitude
// (parallel to slope on hills, level on flat). Sustained nose-down
// input then reads as ALTITUDE CONTROL via DIVE_HOVER_HEIGHT_MIN_MUL,
// not chassis tilt — the bike sinks lower while staying parallel.
//
// Bow / stern corner-spring boost curves (earlier iterations) are gone
// — with the chassis returning to level via PD, both ends naturally
// equilibrate at the lowered effHover and the per-corner asymmetry
// isn't needed.
export const DIVE_KICK_DURATION_S = 0.15

// Target hover height drops to this fraction of stats.hoverHeight at
// full pitch-down intent (linear ramp on |intent.pitch|). Slope-aware
// hover-height boost is applied AFTER this scale, so slopes still get
// their normal climb margin — only the level-flight target sinks.
export const DIVE_HOVER_HEIGHT_MIN_MUL = 0.5

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
const DIVE_PITCH_FWD_LIMIT_RAD = (DIVE_PITCH_FWD_LIMIT_DEG * Math.PI) / 180

/**
 * Marble-on-incline acceleration along the bike's horizontal forward axis.
 * Driven by the terrain-tracking pitch (positive = nose-down on a
 * downslope, zero on flat ground, negative on an upslope). This is the
 * surface signal, NOT the chassis's current pitch — feeding chassis pitch
 * would let the rider pitch the nose down on flat ground and harvest free
 * downhill thrust.
 */
export function slopeMomentumAccel(
  surfacePitchTarget: number,
  gravity: number = DEFAULT_GRAVITY,
  downGain: number = SLOPE_DOWN_GAIN,
  upBrake: number = SLOPE_UP_BRAKE,
): number {
  const gain = surfacePitchTarget > 0 ? downGain : upBrake
  return Math.sin(surfacePitchTarget) * gravity * gain
}

/**
 * Map `stats.surfaceFollow` to the water-side longitudinal spring
 * multiplier with a defensive clamp. Pure helper — exported so tests can
 * lock in the variant ordering without spinning up a Rapier world.
 */
export function resolveWaterLongitudinalSpringMul(stats: BikeStatsData): number {
  return Math.max(SURFACE_FOLLOW_MIN, Math.min(SURFACE_FOLLOW_MAX, stats.surfaceFollow))
}

// ============================================================================
// Surface probing
// ============================================================================

// Reused per-probe Ray. Each bike fires 5 probes per fixed tick (1 center +
// 4 footprint); at 5 bikes × 60 Hz that's ~1500 allocations/sec if we new
// the Ray every call. Lazy-init on first use because the Ray constructor is
// only valid after Rapier WASM has loaded — `phys.rapier` carries it in.
// `castRay` reads origin/dir synchronously and doesn't retain a reference,
// so reuse across sequential calls in the same tick is safe. (NOT safe
// across threads — any Web Worker physics offload will need a per-context
// allocator here.)
let scratchRay: RAPIER.Ray | null = null
function rayAlong(
  phys: PhysicsWorld,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
): RAPIER.Ray {
  if (!scratchRay) {
    scratchRay = new phys.rapier.Ray({ x, y, z }, { x: dx, y: dy, z: dz })
    return scratchRay
  }
  scratchRay.origin.x = x
  scratchRay.origin.y = y
  scratchRay.origin.z = z
  scratchRay.dir.x = dx
  scratchRay.dir.y = dy
  scratchRay.dir.z = dz
  return scratchRay
}

/**
 * Surface probe result. `surfaceProj` is the hit's projection onto the up
 * axis — equals world-Y when up=(0,1,0), the natural distance-along-up in
 * anti-grav zones. `hasSurface=false` means no ground hit and no reachable
 * water (e.g. bike floating in the void).
 */
type SurfaceProbe = {
  surfaceProj: number
  isWater: boolean
  hasSurface: boolean
}

/**
 * Center probe. Casts from (fromX,fromY,fromZ) along (dx,dy,dz) and also
 * samples the wave field for water. Returns the higher surface (projected
 * on up) as the ride surface — same controller for land and water, just a
 * different surface y. Water sampling is XZ-only — only call with a
 * non-null `field` when up ≈ world-Y (anti-grav callers pass null).
 */
function probeSurface(
  phys: PhysicsWorld,
  field: WaveFieldState | null,
  fromX: number,
  fromY: number,
  fromZ: number,
  dx: number,
  dy: number,
  dz: number,
  upX: number,
  upY: number,
  upZ: number,
  ignore: ReturnType<PhysicsWorld['world']['getRigidBody']>,
): SurfaceProbe {
  const ray = rayAlong(phys, fromX, fromY, fromZ, dx, dy, dz)
  const hit = phys.world.castRay(
    ray,
    MAX_HOVER_PROBE,
    true,
    undefined,
    undefined,
    undefined,
    ignore ?? undefined,
  )
  let groundProj = Number.NEGATIVE_INFINITY
  if (hit) {
    const hx = fromX + dx * hit.timeOfImpact
    const hy = fromY + dy * hit.timeOfImpact
    const hz = fromZ + dz * hit.timeOfImpact
    groundProj = hx * upX + hy * upY + hz * upZ
  }
  const waterY = field ? sampleHeight(field, fromX, fromZ) : Number.NEGATIVE_INFINITY

  if (groundProj === Number.NEGATIVE_INFINITY && waterY === Number.NEGATIVE_INFINITY) {
    return { surfaceProj: 0, isWater: false, hasSurface: false }
  }
  if (groundProj > waterY) {
    return { surfaceProj: groundProj, isWater: false, hasSurface: true }
  }
  // Water can be sampled anywhere, so water is "always reachable" — but
  // only counts as a ride surface if the bike is within probe range of
  // it. When `field` is non-null we're in world-up land, so fromY is the
  // bike's proj on up and waterY is the surface proj.
  const reachable = fromY - waterY < MAX_HOVER_PROBE
  return { surfaceProj: waterY, isWater: true, hasSurface: reachable }
}

/**
 * Footprint probe: returns the surface projection on up at the probe's
 * XYZ. Returns NEGATIVE_INFINITY if neither ground nor water is found
 * (caller falls back to the center probe).
 *
 * `lift` raises the ray origin `lift` metres along +up so the cast can
 * see surface rising ABOVE the probe — critical for ramp / wall
 * anticipation. A bow probe at the bike's level casting along the bike's
 * "down" would MISS an upcoming ramp face. Cast distance grows to
 * compensate so the same set of surface beyond stays reachable.
 */
function probeSurfaceY(
  phys: PhysicsWorld,
  field: WaveFieldState | null,
  fromX: number,
  fromY: number,
  fromZ: number,
  dx: number,
  dy: number,
  dz: number,
  upX: number,
  upY: number,
  upZ: number,
  ignore: ReturnType<PhysicsWorld['world']['getRigidBody']>,
  lift = 0,
): number {
  const ox = fromX + upX * lift
  const oy = fromY + upY * lift
  const oz = fromZ + upZ * lift
  const ray = rayAlong(phys, ox, oy, oz, dx, dy, dz)
  const hit = phys.world.castRay(
    ray,
    MAX_HOVER_PROBE + lift,
    true,
    undefined,
    undefined,
    undefined,
    ignore ?? undefined,
  )
  let groundProj = Number.NEGATIVE_INFINITY
  if (hit) {
    const hx = ox + dx * hit.timeOfImpact
    const hy = oy + dy * hit.timeOfImpact
    const hz = oz + dz * hit.timeOfImpact
    groundProj = hx * upX + hy * upY + hz * upZ
  }
  const waterY = field ? sampleHeight(field, fromX, fromZ) : Number.NEGATIVE_INFINITY
  if (groundProj === Number.NEGATIVE_INFINITY && waterY === Number.NEGATIVE_INFINITY) {
    return Number.NEGATIVE_INFINITY
  }
  return Math.max(groundProj, waterY)
}

// ============================================================================
// Per-bike state passed between phases
// ============================================================================

/**
 * The frame-of-reference + tick-snapshot bundle every phase reads from.
 * Built once at the top of the per-bike loop body; never mutated by the
 * helpers (they just `applyImpulse`/`applyTorqueImpulse` against `rb`).
 *
 * `linvel` and `q` are TICK-START snapshots — applyImpulse updates the
 * body's velocity immediately in Rapier, so callers that need fresher
 * values (e.g. the slope velocity redirect) re-read `rb.linvel()` /
 * `rb.angvel()` explicitly. Tick-start is fine for "what did this tick
 * look like" reads (drag, brake, fishtail).
 */
type HoverFrame = {
  eid: number
  rb: RAPIER.RigidBody
  stats: BikeStatsData
  intent: ControlIntentData
  dt: number
  m: number
  gravity: number
  t: { x: number; y: number; z: number }
  linvel: { x: number; y: number; z: number }
  q: { x: number; y: number; z: number; w: number }
  upX: number
  upY: number
  upZ: number
  dnX: number
  dnY: number
  dnZ: number
  /** True while an anti-grav source has non-negligible weight. The
   *  world up vector is blended toward source up; per-body Rapier
   *  gravity is scaled to (1 - weight) by `antiGravSystem`, and the
   *  hover system makes up the rest along −up via the AG corrections
   *  block at the end of the ground branch. */
  agActive: boolean
  agWeight: number
}

/**
 * Multi-probe footprint sample. Only meaningful while the bike is
 * grounded — when airborne we leave the projections at NEGATIVE_INFINITY
 * and the slope at zero (the air branch never consults these).
 *
 * `surfaceForwardSlopeRaw` is the per-tick measurement, used for landing-
 * transition gates (bad-landing crash, landing-momentum redirect) where
 * a one-frame value is what we want. `surfaceForwardSlope` is the
 * LOW-PASS-FILTERED reading, used by every steady-state feel force
 * (slope-momentum, climb-assist, slope-velocity-redirect, slope-aware
 * hover-height boost, slope-damp relief, grounded pitch PD target).
 */
type Footprint = {
  bowProj: number
  sternProj: number
  starboardProj: number
  portProj: number
  surfaceForwardSlope: number
  surfaceForwardSlopeRaw: number
  probeHalfLength: number
  probeHalfWidth: number
  /** Up-plane projected forward — used as the probe sample direction
   *  and as the slope-damp-relief horizontal-fwd reference. */
  sampleFwdX: number
  sampleFwdY: number
  sampleFwdZ: number
  sampleRightX: number
  sampleRightY: number
  sampleRightZ: number
  /** Full 3D bike-fwd / -right — used to position the spring's force
   *  application points at the bike's *real* bow/stern/port/starboard
   *  (including pitch contribution). */
  forceFwdX: number
  forceFwdY: number
  forceFwdZ: number
  forceRightX: number
  forceRightY: number
  forceRightZ: number
}

/** Placeholder when the bike is airborne. The air branch consults none
 *  of these so the values are inert. */
function emptyFootprint(): Footprint {
  return {
    bowProj: Number.NEGATIVE_INFINITY,
    sternProj: Number.NEGATIVE_INFINITY,
    starboardProj: Number.NEGATIVE_INFINITY,
    portProj: Number.NEGATIVE_INFINITY,
    surfaceForwardSlope: 0,
    surfaceForwardSlopeRaw: 0,
    probeHalfLength: 0.8,
    probeHalfWidth: 0.4,
    sampleFwdX: 0,
    sampleFwdY: 0,
    sampleFwdZ: 1,
    sampleRightX: 1,
    sampleRightY: 0,
    sampleRightZ: 0,
    forceFwdX: 0,
    forceFwdY: 0,
    forceFwdZ: 1,
    forceRightX: 1,
    forceRightY: 0,
    forceRightZ: 0,
  }
}

// ============================================================================
// Anti-grav frame resolution
// ============================================================================

/** Per-bike dedup for the AG degenerate-blend warning. Logging once per
 *  bike (not per tick) keeps the signal clear without spamming the
 *  console if a track author drives a bike into a pathological banking. */
const _agDegenerateWarned = new Set<number>()
function warnAGDegenerateBlend(eid: number): void {
  if (_agDegenerateWarned.has(eid)) return
  _agDegenerateWarned.add(eid)
  console.warn(
    `[hover] anti-grav up-blend collapsed for bike eid=${eid}. Source up is ~opposite world up at a half-blend weight. Smooth out the banking transition or move the inversion outside the falloff radius.`,
  )
}

/**
 * Build the bike's frame-of-reference for this tick. Reads the anti-grav
 * override (written by `antiGravSystem` earlier in the same tick) and
 * blends the source up vector with world up by weight. When no anti-grav
 * source is active the frame degenerates to (upY=1, agWeight=0) and
 * every downstream phase reduces to world-down behaviour.
 */
function buildHoverFrame(
  eid: number,
  rb: RAPIER.RigidBody,
  stats: BikeStatsData,
  intent: ControlIntentData,
  dt: number,
  gravity: number,
): HoverFrame {
  const t = rb.translation()
  const linvel = rb.linvel()
  const q = rb.rotation()

  let agActive = false
  let upX = 0
  let upY = 1
  let upZ = 0
  let agWeight = 0
  const agOverride = AntiGravOverrideStore.get(eid)
  if (agOverride?.active) {
    agActive = true
    agWeight = agOverride.weight
    // Effective up = blend(worldUp, sourceUp, weight). Normalize so the
    // probe / spring math stays unit-length-correct. Degenerate only
    // when source up ≈ −worldUp at exactly weight=0.5 (a half-blend
    // between right-side-up and upside-down). Fallback warns dev once.
    const blendX = agWeight * agOverride.upX
    const blendY = (1 - agWeight) + agWeight * agOverride.upY
    const blendZ = agWeight * agOverride.upZ
    const bLen = Math.hypot(blendX, blendY, blendZ)
    if (bLen > 1e-3) {
      upX = blendX / bLen
      upY = blendY / bLen
      upZ = blendZ / bLen
    } else {
      warnAGDegenerateBlend(eid)
      upX = agOverride.upX
      upY = agOverride.upY
      upZ = agOverride.upZ
    }
  }
  return {
    eid,
    rb,
    stats,
    intent,
    dt,
    m: stats.mass,
    gravity,
    t,
    linvel,
    q,
    upX,
    upY,
    upZ,
    dnX: -upX,
    dnY: -upY,
    dnZ: -upZ,
    agActive,
    agWeight,
  }
}

// ============================================================================
// Multi-probe footprint sampling
// ============================================================================

/**
 * Read the surface height at four points around the bike — bow, stern,
 * port, starboard — and derive the bow→stern forward slope.
 *
 * Multi-probe sampling (SoT/Atlas-style), unified across water + ground:
 * each probe takes max(ground raycast, wave field height), so a bike
 * straddling the shoreline correctly reads the high terrain on one side
 * and the wave on the other. More correct than reading the local wave
 * normal under the bike's center because the bike has a real footprint:
 *   1. Long swells naturally tilt the bike across the wave.
 *   2. Short chops + sub-footprint terrain bumps average between probes
 *      so the bike doesn't whip-snap to every ripple or trimesh edge.
 *   3. Mixed water/terrain transitions read continuously instead of
 *      flickering between water-only and ground-only branches.
 *
 * Slope is computed raw and low-pass-filtered (~50ms tau, dt-aware) so
 * lumpy trimeshes don't translate to single-tick thrust/torque kicks.
 * The raw slope is preserved on the footprint for landing-transition
 * gates that need a fresh reading.
 */
function sampleSurfaceFootprint(
  frame: HoverFrame,
  phys: PhysicsWorld,
  probe: SurfaceProbe,
  probeField: WaveFieldState | null,
  debugOn: boolean,
  debugCorners: HoverProbe[],
  prevForwardSlope: number,
): Footprint {
  const { upX, upY, upZ, dnX, dnY, dnZ, t, linvel, q, rb, dt } = frame

  // Probe footprint matches the bike's visual scale (~1.6m × 0.8m) at
  // rest, then extends fore/aft with bike speed (anticipation: at 25 m/s
  // the bow probe is ~2m out in front, so the bike pitches to match the
  // slope it's about to hit). Speed measured in the up-plane so the
  // anticipation works on tilted anti-grav roads too.
  const linvelUp = linvel.x * upX + linvel.y * upY + linvel.z * upZ
  const planeVx = linvel.x - upX * linvelUp
  const planeVy = linvel.y - upY * linvelUp
  const planeVz = linvel.z - upZ * linvelUp
  const speedPlane = Math.hypot(planeVx, planeVy, planeVz)
  // Probe geometry is read live from devSettings so the F4 hover-debug
  // overlay can preview tuning changes immediately. The anticipation cap
  // (1.4 m) stays hardcoded — it's a guard against speed-driven
  // overshoot, not a tuning knob.
  const probeHalfLength =
    devSettings.hoverProbeHalfLength + Math.min(speedPlane * devSettings.hoverProbeSpeedScale, 1.4)
  const probeHalfWidth = devSettings.hoverProbeHalfWidth

  // Full 3D bike-fwd / bike-right (used for spring force positions).
  const fwd3D = quatRotate(q, { x: 0, y: 0, z: 1 })
  const right3D = quatRotate(q, { x: 1, y: 0, z: 0 })

  // Project bike-fwd onto the up-plane, then normalize → the "horizontal"
  // forward in zone-local frame. Used to position the probe samples.
  // Falls back to fwd3D when degenerate (bike-fwd colinear with up).
  const fwdDotUp = fwd3D.x * upX + fwd3D.y * upY + fwd3D.z * upZ
  let pfX = fwd3D.x - upX * fwdDotUp
  let pfY = fwd3D.y - upY * fwdDotUp
  let pfZ = fwd3D.z - upZ * fwdDotUp
  const pfLen = Math.hypot(pfX, pfY, pfZ)
  if (pfLen > 0.01) {
    pfX /= pfLen
    pfY /= pfLen
    pfZ /= pfLen
  } else {
    pfX = fwd3D.x
    pfY = fwd3D.y
    pfZ = fwd3D.z
  }
  // Right = up × fwdInUpPlane (unit, since both are unit and orthogonal).
  const sampleRightX = upY * pfZ - upZ * pfY
  const sampleRightY = upZ * pfX - upX * pfZ
  const sampleRightZ = upX * pfY - upY * pfX

  // Each probe casts from PROBE_LIFT *along +up* of the bike center so a
  // rising surface in front of the bike (a ramp face, a wall on
  // approach) is correctly intersected from above. Live-tunable.
  const PROBE_LIFT = devSettings.hoverProbeLift
  // Falls back to the center probe's surface projection if neither
  // hit (bike overhanging an edge with nothing below — read the missing
  // side as flat with the center rather than NaN).
  const fallbackProj = probe.surfaceProj
  const sampleAt = (px: number, py: number, pz: number, dbgIdx: number): number => {
    const v = probeSurfaceY(
      phys,
      probeField,
      px,
      py,
      pz,
      dnX,
      dnY,
      dnZ,
      upX,
      upY,
      upZ,
      rb,
      PROBE_LIFT,
    )
    if (debugOn) {
      const c = debugCorners[dbgIdx]!
      // Lifted origin = (px,py,pz) + up * PROBE_LIFT — what the ray
      // actually starts from. Stored so the renderer can draw the
      // probe ray from its true origin.
      c.ox = px + upX * PROBE_LIFT
      c.oy = py + upY * PROBE_LIFT
      c.oz = pz + upZ * PROBE_LIFT
      if (v !== Number.NEGATIVE_INFINITY) {
        const liftedProj = c.ox * upX + c.oy * upY + c.oz * upZ
        const along = liftedProj - v
        c.hx = c.ox + dnX * along
        c.hy = c.oy + dnY * along
        c.hz = c.oz + dnZ * along
      } else {
        c.hx = Number.NEGATIVE_INFINITY
      }
    }
    return v === Number.NEGATIVE_INFINITY ? fallbackProj : v
  }
  const bowProj = sampleAt(
    t.x + pfX * probeHalfLength,
    t.y + pfY * probeHalfLength,
    t.z + pfZ * probeHalfLength,
    0,
  )
  const sternProj = sampleAt(
    t.x - pfX * probeHalfLength,
    t.y - pfY * probeHalfLength,
    t.z - pfZ * probeHalfLength,
    1,
  )
  const starboardProj = sampleAt(
    t.x + sampleRightX * probeHalfWidth,
    t.y + sampleRightY * probeHalfWidth,
    t.z + sampleRightZ * probeHalfWidth,
    2,
  )
  const portProj = sampleAt(
    t.x - sampleRightX * probeHalfWidth,
    t.y - sampleRightY * probeHalfWidth,
    t.z - sampleRightZ * probeHalfWidth,
    3,
  )
  const surfaceForwardSlopeRaw = (bowProj - sternProj) / (2 * probeHalfLength)
  // Exponential low-pass toward this tick's raw reading. dt-aware so a
  // stretched frame catches up faster instead of doubling the lag. The
  // HoverState write resets `forwardSlope` to 0 while airborne, so on
  // the first ground tick after a flight the filter seeds cleanly.
  const slopeAlpha = 1 - Math.exp(-dt / SLOPE_FILTER_TAU)
  const surfaceForwardSlope =
    prevForwardSlope + (surfaceForwardSlopeRaw - prevForwardSlope) * slopeAlpha

  return {
    bowProj,
    sternProj,
    starboardProj,
    portProj,
    surfaceForwardSlope,
    surfaceForwardSlopeRaw,
    probeHalfLength,
    probeHalfWidth,
    sampleFwdX: pfX,
    sampleFwdY: pfY,
    sampleFwdZ: pfZ,
    sampleRightX,
    sampleRightY,
    sampleRightZ,
    forceFwdX: fwd3D.x,
    forceFwdY: fwd3D.y,
    forceFwdZ: fwd3D.z,
    forceRightX: right3D.x,
    forceRightY: right3D.y,
    forceRightZ: right3D.z,
  }
}

// ============================================================================
// Bad-landing / bad-attitude crash detection
// ============================================================================

/**
 * Two transient checks that kill horizontal velocity so the rider-crash
 * Δv detector can ragdoll next tick. Both LAND-ONLY (water nose-dives are
 * supposed to plough under, not throw the rider) and ANTI-GRAV-EXEMPT
 * (the world-Y pitch they measure isn't meaningful on a tilted road).
 *
 *  1. Bad LANDING: on airborne→grounded transition, chassis is wildly off
 *     the surface contour while moving forward.
 *  2. Continuous bad ATTITUDE: pitch past 75° on the ground. Without this
 *     the multi-point spring's restoring `r × F` torque collapses to zero
 *     (corner-to-CoM displacement parallel to up) and the bike sits
 *     happily nose-down on flat ground.
 */
function applyBadLandingChecks(
  frame: HoverFrame,
  probe: SurfaceProbe,
  surfaceForwardSlopeRaw: number,
  prevGrounded: boolean,
  isGrounded: boolean,
): void {
  const { rb, linvel, agActive } = frame
  if (probe.isWater || agActive) return
  if (!isGrounded) return

  // Bad landing
  if (!prevGrounded) {
    const qLand = rb.rotation()
    const r12Land = 2 * (qLand.y * qLand.z - qLand.x * qLand.w)
    const pitchLand = Math.asin(Math.max(-1, Math.min(1, -r12Land)))
    // RAW slope — filter is still seeded from zero on the first ground
    // tick after a flight, so the smoothed value would under-report the
    // landing slope.
    const surfacePitchAtLanding = -Math.atan(surfaceForwardSlopeRaw)
    const pitchOffSurface = Math.abs(pitchLand - surfacePitchAtLanding)
    const horizSpeedLand = Math.hypot(linvel.x, linvel.z)
    if (pitchOffSurface > BAD_LAND_PITCH && horizSpeedLand > BAD_LAND_MIN_SPEED) {
      rb.setLinvel({ x: 0, y: linvel.y, z: 0 }, true)
      return
    }
  }

  // Continuous bad attitude
  const qBad = rb.rotation()
  const r12Bad = 2 * (qBad.y * qBad.z - qBad.x * qBad.w)
  const pitchBad = Math.asin(Math.max(-1, Math.min(1, -r12Bad)))
  if (Math.abs(pitchBad) > BAD_GROUND_PITCH) {
    rb.setLinvel({ x: 0, y: linvel.y, z: 0 }, true)
  }
}

// ============================================================================
// Multi-point hover spring
// ============================================================================

/**
 * Multi-point hover spring. Fires only while grounded. Instead of a
 * single force at CoM, apply 1/4-mass vertical impulses at each of the
 * bow, stern, port, starboard probe positions. Each point's upward
 * force is sized by its LOCAL height error vs the surface below it;
 * differential forces naturally torque the chassis to align with the
 * surface contour — bow dips on flat ground → stronger upward kick at
 * bow → pitch nose-up to neutral; starboard sinks into a wave trough
 * → strong kick on starboard → roll left.
 *
 * Sum of per-point forces equals the old single-point force when all
 * four heights agree, so vertical tuning (hoverSpring, hoverDamp)
 * transfers directly. The alignment torque is a free byproduct of the
 * multi-point geometry — no PD reading orientation.
 *
 * Underwater branch (Wave Race feel) stays single-point: when the bike
 * has dived below the water surface (groundDistance < 0 on water),
 * depth-proportional buoyancy + asymmetric drag take over. Symmetric
 * spring would slam the bike back up the instant it dipped below;
 * instead we let dive momentum carry it under, drag bleeds it off,
 * capped buoyancy walks it back up. Tuning targets a peak depth around
 * 1–2 m on a hard dive.
 *
 * `stats.surfaceFollow` scales the WATER longitudinal spring multiplier
 * (bow + stern only; lateral roll stiffness unchanged). Low values
 * plough through chop; high values follow every crest. See
 * `resolveWaterLongitudinalSpringMul` for the clamp.
 */
function applyMultiPointHoverSpring(
  frame: HoverFrame,
  footprint: Footprint,
  probe: SurfaceProbe,
  groundDistance: number,
  debugOn: boolean,
  debugCorners: HoverProbe[],
): void {
  const { rb, stats, dt, m, gravity, t, linvel, upX, upY, upZ } = frame

  if (probe.isWater && groundDistance < 0) {
    // Submerged: capped buoyancy + asymmetric drag, single-point.
    const submersion = -groundDistance
    const BUOYANCY_PER_M = 14
    const BUOYANCY_CAP = 20
    // Asymmetric Y-axis drag: full strength when SINKING (kills dive
    // momentum so the bike actually slows as it reaches max depth),
    // much weaker when RISING so accumulated buoyancy isn't fought by
    // drag on the way up.
    const DRAG_K_HORIZ = 0.1
    const DRAG_K_SINK = 0.1
    const DRAG_K_RISE = 0.03
    const aBuoy = Math.min(submersion * BUOYANCY_PER_M, BUOYANCY_CAP)
    const speed = Math.hypot(linvel.x, linvel.y, linvel.z)
    const horizDragCoef = -DRAG_K_HORIZ * speed
    const yDragK = linvel.y > 0 ? DRAG_K_RISE : DRAG_K_SINK
    const yDragCoef = -yDragK * speed
    rb.applyImpulse(
      {
        x: linvel.x * horizDragCoef * m * dt,
        y: (gravity + aBuoy + linvel.y * yDragCoef) * m * dt,
        z: linvel.z * horizDragCoef * m * dt,
      },
      true,
    )
    return
  }

  const angv = rb.angvel()
  const POINT_MASS_FRAC = 0.25
  // Force vs sample length: `probeHalfLength` grows with speed
  // (anticipation reach — sampling the surface ahead helps the bike
  // pre-pitch into climbs). The FORCE arm, though, has to stay at the
  // bike's physical footprint, otherwise the spring's restoring torque
  // on a wheelie scales with speed²: longer arm × bigger height
  // differential on a tilted chassis = wheelies become impossible at
  // top speed. `forceHalfLength` decouples the two — sampling still
  // anticipates, but the impulse is applied at the body's real
  // bow/stern position. Width has no speed anticipation so port /
  // starboard use the physical arm directly.
  const forceHalfLength = devSettings.hoverProbeHalfLength
  const halfW = footprint.probeHalfWidth
  const points = [
    {
      ox: footprint.forceFwdX * forceHalfLength,
      oy: footprint.forceFwdY * forceHalfLength,
      oz: footprint.forceFwdZ * forceHalfLength,
      surfProj: footprint.bowProj,
      longitudinal: true,
    },
    {
      ox: -footprint.forceFwdX * forceHalfLength,
      oy: -footprint.forceFwdY * forceHalfLength,
      oz: -footprint.forceFwdZ * forceHalfLength,
      surfProj: footprint.sternProj,
      longitudinal: true,
    },
    {
      ox: footprint.forceRightX * halfW,
      oy: footprint.forceRightY * halfW,
      oz: footprint.forceRightZ * halfW,
      surfProj: footprint.starboardProj,
      longitudinal: false,
    },
    {
      ox: -footprint.forceRightX * halfW,
      oy: -footprint.forceRightY * halfW,
      oz: -footprint.forceRightZ * halfW,
      surfProj: footprint.portProj,
      longitudinal: false,
    },
  ]
  // Dive-aid takes the form of a hover-height drop + a rate-limited
  // pitch torque (see DIVE_KICK_DURATION_S); per-corner spring
  // multipliers aren't modulated by dive intent.
  const diveAmount = Math.max(-frame.intent.pitch, 0)
  // Per-bike longitudinal water spring multiplier — sourced from
  // `stats.surfaceFollow` so variants differentiate on chop behaviour.
  const waterLongMul = resolveWaterLongitudinalSpringMul(stats)
  const BUOYANCY_PER_M = 14
  const BUOYANCY_CAP = 20
  const slopeBoost = probe.isWater
    ? 0
    : Math.abs(footprint.surfaceForwardSlope) * SLOPE_HOVER_BOOST
  // Dive aid: target ride height drops with held pitch-down. Scale is
  // applied BEFORE slopeBoost so the climb-margin reaches its normal
  // value — the dive sinks the level-flight target only.
  const diveHoverMul = 1 - (1 - DIVE_HOVER_HEIGHT_MIN_MUL) * diveAmount
  const effHover = stats.hoverHeight * diveHoverMul + slopeBoost
  const heightErrorCap = MAX_BOW_LIFT_ERROR + slopeBoost
  const groundedCutoff = stats.hoverHeight * GROUNDED_DISTANCE_MUL

  for (let pi = 0; pi < points.length; pi++) {
    const p = points[pi]!
    // Probe point's projection on up = (t + offset) · up.
    const probeProj = (t.x + p.ox) * upX + (t.y + p.oy) * upY + (t.z + p.oz) * upZ
    const localDist = probeProj - p.surfProj
    // Per-corner "locally grounded" gate. The bow probe, with its
    // speed-anticipation reach, projects past a ramp lip before the
    // bike does — past the lip it samples the much lower surface
    // beyond, and a naive heightError would fire a huge DOWNWARD
    // spring force at the bow right at takeoff (the "sticky nose"
    // nose-dive). Skip a corner once its local surface is further
    // than the grounded threshold below it.
    if (localDist > groundedCutoff) continue

    // v at this offset, projected on up:
    //   v_at_point = linvel + (angv × offset)
    //   v_at_point · up = linvel·up + (angv × offset)·up
    const crossX = angv.y * p.oz - angv.z * p.oy
    const crossY = angv.z * p.ox - angv.x * p.oz
    const crossZ = angv.x * p.oy - angv.y * p.ox
    const vAtPointUp =
      linvel.x * upX +
      linvel.y * upY +
      linvel.z * upZ +
      crossX * upX +
      crossY * upY +
      crossZ * upZ
    // Damp only the EXCESS upward velocity beyond what a steady climb
    // of this slope requires. On flat ground tangentUpVel=0 and we get
    // legacy "damp any lift-off" behaviour. On a climb at v m/s along a
    // tan(θ) slope, vy must be v·tan(θ) just to stay on the surface;
    // treating that as "lifting off" would let damp (~70 m/s² on a 25°
    // hill at 18 m/s) overwhelm the spring and pin the chassis below
    // hoverHeight — visible as "dragging".
    const horizFwdSpeed =
      linvel.x * footprint.sampleFwdX +
      linvel.y * footprint.sampleFwdY +
      linvel.z * footprint.sampleFwdZ
    const tangentUpVel = probe.isWater
      ? 0
      : horizFwdSpeed * footprint.surfaceForwardSlope * SLOPE_DAMP_RELIEF
    const dampV = Math.max(vAtPointUp - tangentUpVel, 0)

    let aUp: number
    if (probe.isWater && localDist < 0) {
      // Submerged on water — capped buoyancy instead of the stiff
      // spring so a nose-dive actually goes under. Anti-grav can't
      // reach here (probe.isWater is false when probeField is null).
      const submersion = -localDist
      const aBuoy = Math.min(submersion * BUOYANCY_PER_M, BUOYANCY_CAP)
      aUp = gravity + aBuoy - dampV * stats.hoverDamp
    } else {
      // heightError clamped on the positive side (a bow probe looking
      // ahead at a steep slope can read +5m+, which would fire the
      // spring at ~6-8G of corner lift and whip-pitch the chassis sky-
      // ward). Slope-momentum handles the climb signal via the bow /
      // stern projection differential — the clamp only limits the
      // CORNER lift kick.
      const rawHeightError = effHover - localDist
      const heightError = Math.min(rawHeightError, heightErrorCap)
      const springMul = probe.isWater && p.longitudinal ? waterLongMul : 1.0
      aUp = gravity + heightError * stats.hoverSpring * springMul - dampV * stats.hoverDamp
    }
    if (debugOn) {
      const dc = debugCorners[pi]!
      dc.aUp = aUp
      dc.active = true
    }
    // Lift along +up at the probe point's world position. The point
    // location includes the bike's pitch contribution, which is what
    // gives flat-ground attitude restoration (nose-up bike's bow is
    // higher → spring pushes bow DOWN → levels chassis).
    const impMag = aUp * POINT_MASS_FRAC * m * dt
    rb.applyImpulseAtPoint(
      { x: upX * impMag, y: upY * impMag, z: upZ * impMag },
      { x: t.x + p.ox, y: t.y + p.oy, z: t.z + p.oz },
      true,
    )
  }
}

// ============================================================================
// Pitch PD + player pitch torque
// ============================================================================

/**
 * Grounded pitch PD — self-righting torque while on land OR water.
 *
 * P targets the surface's pitch attitude (`-atan(slope)`) so flat ground /
 * flat water reads as "sit level" and a slope or wave face still lets the
 * chassis tilt onto its tangent. The level band is ±45°; past that, P
 * drops and only D damps so a deliberate committed trick (wave-pump dive,
 * big-air wheelie) isn't fought.
 *
 * Originally water-only — on water the multi-point spring is softened
 * along the longitudinal axis and can't restore from a held pitch input
 * on its own. On land the multi-point spring provides strong differential
 * lift, but holding a wheelie at low speed pumps the chassis past the
 * locally-airborne gate and runs away to a backflip crash. Sharing the PD
 * between both surfaces bounds the wheelie equilibrium to ~21° on land /
 * ~31° on water with a held back-stick — committed but not crashy.
 */
function applyGroundedPitchPD(frame: HoverFrame, surfaceForwardSlope: number): void {
  const { rb, dt, m } = frame
  const rightG = quatRotate(rb.rotation(), { x: 1, y: 0, z: 0 })
  const angvG = rb.angvel()
  const pitchVelG = angvG.x * rightG.x + angvG.y * rightG.y + angvG.z * rightG.z
  const qG = rb.rotation()
  const r12G = 2 * (qG.y * qG.z - qG.x * qG.w)
  const pitchAngleG = Math.asin(Math.max(-1, Math.min(1, -r12G)))
  const surfacePitchTarget = -Math.atan(surfaceForwardSlope)
  const pitchErrG = pitchAngleG - surfacePitchTarget
  const GROUNDED_PITCH_P = 9 // rad/s² per rad of error
  const GROUNDED_PITCH_D = 3 // rad/s² per rad/s
  // Upper-band cutoff at 45° lets a committed wheelie/backflip run
  // free (P drops to 0 past the cutoff, only D damps). Dive side is
  // P-active all the way to the safety clamp; no dive-side softening
  // since the player-torque rate limit handles "let me dive" already.
  const UPPER_BAND_RAD = (45 * Math.PI) / 180
  const aPitchP = pitchErrG > UPPER_BAND_RAD ? 0 : -pitchErrG * GROUNDED_PITCH_P
  const aPitchD = -pitchVelG * GROUNDED_PITCH_D
  const aPitchG = aPitchP + aPitchD
  rb.applyTorqueImpulse(
    {
      x: rightG.x * aPitchG * m * dt,
      y: rightG.y * aPitchG * m * dt,
      z: rightG.z * aPitchG * m * dt,
    },
    true,
  )
}

/**
 * Player pitch torque — applied around the bike's right axis. Fires in
 * BOTH grounded and airborne states with different coefficients.
 *
 * Sign: intent.pitch=+1 ("nose up") → torque around -rightAxis, rotates
 * fwd toward +y. intent.pitch=-1 ("nose down / dive").
 *
 * Magnitude is a *torque coefficient*, not the angular acceleration
 * directly: it multiplies `mass * dt` to form the torque impulse, so the
 * effective angular acceleration is `coef * mass / I_pitch`. For the
 * capsule (I_pitch ≈ m·0.34) that's roughly `coef × 2.94` rad/s² at full
 * input.
 *
 *   - Grounded (7, both directions): paired with the grounded pitch PD
 *     above (P=9, D=3, ±45° band). Equilibrium under held wheelie is
 *     ~21° on land / ~31° on water — committed but bounded. Grounded
 *     also fires the motocross-pivot rebalance below — see comments
 *     inside the function.
 *   - Air (1.8): 60% of the prior 3.0 — air pitch felt twitchy at 3.0.
 *     1.8 stretches a full backflip to ~3s while still keeping fwd.y
 *     monotonic over the 1s m9-air-control sample window. Air keeps the
 *     pure-torque feel; flips spin around CM.
 */
function applyPlayerPitchTorque(
  frame: HoverFrame,
  isGrounded: boolean,
  isOverWater: boolean,
  surfaceForwardSlope: number,
  diveHoldS: number,
): void {
  const { rb, intent, q, dt, m } = frame
  if (Math.abs(intent.pitch) <= 0.05) return
  // Dive-clamp safety: past DIVE_PITCH_FWD_LIMIT_RAD below the surface
  // tangent, suppress the nose-down torque. Primary dive bounding is the
  // diveHoldS taper below; this is a backstop for rapid-tap accumulation
  // or kick-out-of-band momentum. Grounded path also gets full-P
  // restoring from applyGroundedPitchPD; the airborne-over-water path
  // relies on input suppression alone (air has no PD by design —
  // residual nose-down angular velocity carried airborne will still
  // rotate the chassis somewhat, just no fresh torque past the limit).
  // Airborne over LAND is unaffected — jump tricks off ramps run free.
  if ((isGrounded || isOverWater) && intent.pitch < 0) {
    const qChk = rb.rotation()
    const r12Chk = 2 * (qChk.y * qChk.z - qChk.x * qChk.w)
    const pitchAngle = Math.asin(Math.max(-1, Math.min(1, -r12Chk)))
    const surfacePitchTarget = -Math.atan(surfaceForwardSlope)
    if (pitchAngle - surfacePitchTarget < -DIVE_PITCH_FWD_LIMIT_RAD) return
  }
  const rightP = quatRotate(q, { x: 1, y: 0, z: 0 })
  const coef = isGrounded ? 7 : 1.8
  // Dive-kick taper: nose-down torque fades from full to zero over
  // DIVE_KICK_DURATION_S after the player starts holding pitch-down.
  // After the kick, the pitch PD pulls the chassis back to surface
  // tangent and sustained input reads as altitude control via the
  // hover-height drop. Pitch-up (wheelie) is unaffected.
  const kickMul =
    intent.pitch < 0 ? Math.max(0, 1 - diveHoldS / DIVE_KICK_DURATION_S) : 1
  const aPitch = -intent.pitch * coef * kickMul
  const tx = rightP.x * aPitch * m * dt
  const ty = rightP.y * aPitch * m * dt
  const tz = rightP.z * aPitch * m * dt
  rb.applyTorqueImpulse({ x: tx, y: ty, z: tz }, true)
  if (!isGrounded) return

  // Off-center rebalance — motocross pivot. A pure torque rotates the
  // chassis around its CM, so a wheelie swings the front up AND the rear
  // down by the same arc, which reads as "the whole bike tips". To make
  // pitch feel like pivoting around the rear (wheelie) or the front
  // (endo/stoppie), add a linear impulse that cancels the angular
  // contribution to velocity at the chosen pivot: Δv_cm = -Δω × r_anchor.
  // Net effect, the chosen end is instantaneously stationary and the
  // opposite end swings through twice the arc.
  //
  // Asymmetric on purpose — pitch-up pivots rear (wheelie), pitch-down
  // pivots front (endo) — matching how a real motorcycle pivots on each
  // direction. Air pitch keeps its center-pivot feel so backflips spin
  // around CM as before; flips that pivoted off-axis felt floaty.
  //
  // Note: at held-pitch equilibrium the player torque is still applied
  // every tick (the grounded pitch PD cancels it), so this rebalance is
  // also still applied each tick. The hover spring absorbs the resulting
  // steady upward bias; expect the chassis to ride slightly higher
  // during a sustained wheelie. Reads as "the bike rises while popped"
  // which matches the motocross feel — but if it floats too much in
  // playtest, dial PIVOT_OFFSET down toward 0.
  const fwdP = quatRotate(q, { x: 0, y: 0, z: 1 })
  // 0.3m = capsule halfHeight (see bike.ts collider) — lines up with the
  // chassis end visually.
  const PIVOT_OFFSET = 0.3
  const sign = intent.pitch > 0 ? -1 : 1
  const rx = fwdP.x * PIVOT_OFFSET * sign
  const ry = fwdP.y * PIVOT_OFFSET * sign
  const rz = fwdP.z * PIVOT_OFFSET * sign
  // Δω = T / I_pitch. I_pitch ≈ m·0.34 for the capsule (see torque
  // coefficient comment above). Linear impulse = m · -Δω × r_anchor.
  const invI = 1 / (m * 0.34)
  const wx = tx * invI
  const wy = ty * invI
  const wz = tz * invI
  rb.applyImpulse(
    {
      x: -m * (wy * rz - wz * ry),
      y: -m * (wz * rx - wx * rz),
      z: -m * (wx * ry - wy * rx),
    },
    true,
  )
}

// ============================================================================
// Air control branch
// ============================================================================

/**
 * Air control — lift (hang-time), pitch-vectored thrust, reduced-authority
 * yaw, and a soft-tapered roll leveler. The air branch is fully free
 * physics aside from these arcade aids: backflips, barrel rolls, dives,
 * whatever the player commits to via input integrates freely.
 */
function applyAirControlBranch(frame: HoverFrame): void {
  const { rb, stats, intent, dt, m, gravity, eid, linvel, q, upX, upY, upZ } = frame

  // Hang-time: counter ~60% of gravity so the bike floats through arcs
  // JetMoto-style instead of dropping like a brick. Effective gravity in
  // air ≈ 0.4·G ≈ 10 m/s² — close to real-world Earth pull, well below
  // arcade ground gravity. In anti-grav, lift is along the zone's up
  // (matching the manual gravity applied at end-of-loop along −up).
  const AIR_LIFT_FRAC = 0.6
  const airLiftMag = gravity * AIR_LIFT_FRAC * m * dt
  rb.applyImpulse({ x: upX * airLiftMag, y: upY * airLiftMag, z: upZ * airLiftMag }, true)

  // Pitch-vectored thrust: airborne thrust pushes along bike-fwd.
  //   Q (intent.pitch=-1) → fwd.y < 0 → thrust dives.
  //   E (intent.pitch=+1) → fwd.y > 0 → thrust extends air time.
  // Slightly weaker than ground thrust so the player can't infinite-
  // hover by aiming up + boost; speedFalloff3d (with boost-raised cap)
  // still caps any sustained climb at the effective top speed.
  const fwdAir = quatRotate(q, { x: 0, y: 0, z: 1 })
  if (Math.abs(intent.throttle) > 0) {
    const speed3d = Math.hypot(linvel.x, linvel.y, linvel.z)
    const dirAir = intent.throttle >= 0 ? 1 : -1
    const scaleAir = intent.throttle >= 0 ? 1 : stats.reverseScale
    // Held-boost is gated by the boost-meter `active` flag — see
    // boost-meter.ts for the rising-edge / drain rules.
    const meterActive = BoostMeterStore.get(eid)?.active === true
    const boostAir = (meterActive ? stats.boostMul : 1) * getCurrentBoostMultiplier(eid)
    // Boost raises the speed cap: speedFalloff stays positive past base
    // topSpeed as long as boost > 1, so the boost actually pushes the
    // bike faster on a long straight (Burnout feel). Without this, at
    // speed=topSpeed thrust vanishes regardless of boost — the meter
    // would only shorten the time-to-cap, not the cap itself.
    const speedFalloff3d = Math.max(0, 1 - speed3d / (stats.topSpeed * boostAir))
    const AIR_THRUST_MUL = 0.85
    const aAir =
      Math.abs(intent.throttle) *
      stats.accel *
      scaleAir *
      speedFalloff3d *
      boostAir *
      dirAir *
      AIR_THRUST_MUL
    rb.applyImpulse(
      { x: fwdAir.x * aAir * m * dt, y: fwdAir.y * aAir * m * dt, z: fwdAir.z * aAir * m * dt },
      true,
    )
  }

  // Yaw around the "pure heading" axis: up with the bike-fwd projection
  // removed (then normalised). Perpendicular to bike-fwd by construction,
  // so steering in the air can't leak into roll even when the bike is
  // pitched up after a ramp. In anti-grav we use the zone's up so yaw
  // rotates around the road normal, not world-Y. Reduced authority
  // (×0.3) preserved for landing alignment.
  const AIR_TURN_MUL = 0.3
  const aTurnAir = -intent.steer * stats.turnTorque * AIR_TURN_MUL
  const fwdAxisDot = fwdAir.x * upX + fwdAir.y * upY + fwdAir.z * upZ
  const yawAxXAir = upX - fwdAxisDot * fwdAir.x
  const yawAxYAir = upY - fwdAxisDot * fwdAir.y
  const yawAxZAir = upZ - fwdAxisDot * fwdAir.z
  const yawAxLenAir = Math.hypot(yawAxXAir, yawAxYAir, yawAxZAir)
  if (yawAxLenAir > 0.01) {
    const invLen = 1 / yawAxLenAir
    rb.applyTorqueImpulse(
      {
        x: yawAxXAir * invLen * aTurnAir * m * dt,
        y: yawAxYAir * invLen * aTurnAir * m * dt,
        z: yawAxZAir * invLen * aTurnAir * m * dt,
      },
      true,
    )
  }

  // Air roll leveler — gentle PD toward zero roll. The roll ANGLE at
  // takeoff (e.g. a fully laid-over corner) is preserved by the air
  // branch's "free physics" approach, which left the bike stuck on its
  // side mid-jump. Low gain so steer-driven aerial banking still works
  // as a transient, but neutral is the attractor over ~2s.
  //
  // Softly tapered out between 60° and 80° of pitch (was a hard cutoff
  // at 60°). Past 80° we don't touch roll at all so a committed
  // backflip/dive runs free; below 60° full restoring authority; lerped
  // between for a continuous handoff (no snap when re-entering the band).
  const r10A = 2 * (q.x * q.y + q.z * q.w)
  const r11A = 1 - 2 * (q.x * q.x + q.z * q.z)
  const r12A = 2 * (q.y * q.z - q.x * q.w)
  const pitchA = Math.asin(Math.max(-1, Math.min(1, -r12A)))
  const absPitchA = Math.abs(pitchA)
  if (absPitchA < AIR_ROLL_TAPER_HI) {
    const taper =
      absPitchA <= AIR_ROLL_TAPER_LO
        ? 1
        : 1 - (absPitchA - AIR_ROLL_TAPER_LO) / (AIR_ROLL_TAPER_HI - AIR_ROLL_TAPER_LO)
    const currentRollA = Math.atan2(r10A, r11A)
    const angvA = rb.angvel()
    const rollVelA = angvA.x * fwdAir.x + angvA.y * fwdAir.y + angvA.z * fwdAir.z
    const AIR_ROLL_P = 3
    const AIR_ROLL_D = 2
    const aRollAir = (-currentRollA * AIR_ROLL_P - rollVelA * AIR_ROLL_D) * taper
    rb.applyTorqueImpulse(
      {
        x: fwdAir.x * aRollAir * m * dt,
        y: fwdAir.y * aRollAir * m * dt,
        z: fwdAir.z * aRollAir * m * dt,
      },
      true,
    )
  }
}

// ============================================================================
// Ground branch — motion + steering + anti-grav corrections
// ============================================================================

/**
 * The grounded-body update: brake, thrust, slope momentum + climb assist
 * + velocity redirect, landing-momentum redirect, yaw + fishtail, roll
 * PD, lateral drag, and the trailing anti-grav corrections.
 *
 * Force order matters — see the inline comments. Notable ordering rule:
 * the slope velocity redirect re-reads `rb.linvel()` mid-tick so it sees
 * post-brake / post-thrust velocity; the landing redirect and lateral
 * drag deliberately use the TICK-START `linvel` (captured on the frame)
 * so the fishtail's lateral kick this tick isn't immediately damped.
 */
function applyGroundBranch(
  frame: HoverFrame,
  footprint: Footprint,
  probe: SurfaceProbe,
  prevGrounded: boolean,
  groundDistance: number,
): void {
  const { rb, stats, intent, dt, m, gravity, eid, linvel, q, upX, upY, upZ, agActive } = frame
  const fwd = quatRotate(q, { x: 0, y: 0, z: 1 })

  // Bike-fwd projected into the up-plane — the "horizontal" forward in
  // the bike's local frame. When up = Y this is just (fwd.x, 0, fwd.z),
  // matching the historic XZ horizontal forward. In anti-grav this stays
  // in the road plane so thrust pushes the bike along the road surface.
  const fwdDotUpG = fwd.x * upX + fwd.y * upY + fwd.z * upZ
  let planeFwdX = fwd.x - upX * fwdDotUpG
  let planeFwdY = fwd.y - upY * fwdDotUpG
  let planeFwdZ = fwd.z - upZ * fwdDotUpG
  const planeFwdLen = Math.hypot(planeFwdX, planeFwdY, planeFwdZ)
  if (planeFwdLen > 0.01) {
    planeFwdX /= planeFwdLen
    planeFwdY /= planeFwdLen
    planeFwdZ /= planeFwdLen
  }
  // Up-plane "right" — used by lateral drag + fishtail.
  const planeRightX = upY * planeFwdZ - upZ * planeFwdY
  const planeRightY = upZ * planeFwdX - upX * planeFwdZ
  const planeRightZ = upX * planeFwdY - upY * planeFwdX

  // Velocity projected onto the up-plane. Used for brake / thrust /
  // drag / slope-momentum speed reads.
  const linvelUpG = linvel.x * upX + linvel.y * upY + linvel.z * upZ
  const vPlaneX = linvel.x - upX * linvelUpG
  const vPlaneY = linvel.y - upY * linvelUpG
  const vPlaneZ = linvel.z - upZ * linvelUpG
  const speed = Math.hypot(vPlaneX, vPlaneY, vPlaneZ)

  const surfaceForwardSlope = footprint.surfaceForwardSlope

  // ── Brake ──────────────────────────────────────────────────────────
  if (intent.brake > 0 && speed > 0.5) {
    const brakeAccel = intent.brake * 18 // m/s^2 at full brake
    rb.applyImpulse(
      {
        x: -(vPlaneX / speed) * brakeAccel * m * dt,
        y: -(vPlaneY / speed) * brakeAccel * m * dt,
        z: -(vPlaneZ / speed) * brakeAccel * m * dt,
      },
      true,
    )
  }

  // ── Forward thrust (boost-raised cap) ──────────────────────────────
  // Water adds extra drag — slightly less responsive. Applied along the
  // full bike-fwd vector (not the up-plane projection) so chassis pitch
  // vectors thrust on the ground the same way it does in the air: pop a
  // wheelie + throttle and the bike lifts; tip into a downslope and the
  // throttle drives you into the wave face. Lets pitch be an expressive
  // control on land/water, not just airborne.
  const throttle = intent.throttle
  const direction = throttle >= 0 ? 1 : -1
  const scale = throttle >= 0 ? 1 : stats.reverseScale
  const meterActive = BoostMeterStore.get(eid)?.active === true
  const heldBoost = meterActive ? stats.boostMul : 1
  const pickupBoost = getCurrentBoostMultiplier(eid)
  const boost = heldBoost * pickupBoost
  // Boost raises the speed cap (see air branch for rationale).
  const speedFalloff = Math.max(0, 1 - speed / (stats.topSpeed * boost))
  const surfaceMul = probe.isWater ? 0.85 : 1.0
  const aThrust =
    Math.abs(throttle) * stats.accel * scale * speedFalloff * boost * direction * surfaceMul
  rb.applyImpulse(
    {
      x: fwd.x * aThrust * m * dt,
      y: fwd.y * aThrust * m * dt,
      z: fwd.z * aThrust * m * dt,
    },
    true,
  )

  // ── Slope momentum + climb assist + velocity redirect ──────────────
  // Slope momentum: project gravity along the surface's forward axis
  // (marble-on-incline). The hover spring cancels gravity vertically, so
  // without this the chassis would pitch on a slope but coast at the
  // same speed regardless of grade. Strongly asymmetric coupling (see
  // SLOPE_DOWN_GAIN / SLOPE_UP_BRAKE) gives the motocross slingshot down
  // and a featherweight tax up.
  //
  // Climb assist: arcade compensator for the gravity-along-slope tax.
  // On a 25° hill the physically-honest tax is m·g·tan(θ) ≈ 11.7 m/s²,
  // saturating the bike's 19 m/s² accel curve at a steady-state ~12 m/s.
  // Compensate CLIMB_ASSIST_FRAC of the tax as extra forward thrust so
  // climbs read closer to flat-ground speed. Uphill only, land only.
  //
  // Velocity redirect: when entering a fast steep climb the spring can't
  // generate enough lift to lift the chassis at the surface's vertical
  // rate; the capsule clips the trimesh and the contact resolver burns
  // ~50% of forward speed in 150 ms. Below the hover band on a positive
  // slope, nudge velocity toward the slope tangent so the chassis rides
  // the slope instead of plowing into it.
  if (planeFwdLen > 0.01) {
    const aSlope = slopeMomentumAccel(-Math.atan(surfaceForwardSlope), gravity)
    rb.applyImpulse(
      {
        x: planeFwdX * aSlope * m * dt,
        y: planeFwdY * aSlope * m * dt,
        z: planeFwdZ * aSlope * m * dt,
      },
      true,
    )

    if (surfaceForwardSlope > 0.05 && !probe.isWater) {
      const CLIMB_ASSIST_FRAC = 0.7
      const aClimb = surfaceForwardSlope * gravity * CLIMB_ASSIST_FRAC
      rb.applyImpulse(
        {
          x: planeFwdX * aClimb * m * dt,
          y: planeFwdY * aClimb * m * dt,
          z: planeFwdZ * aClimb * m * dt,
        },
        true,
      )
    }

    if (
      !agActive &&
      !probe.isWater &&
      surfaceForwardSlope > 0.05 &&
      groundDistance < stats.hoverHeight * 0.85
    ) {
      // Fresh-read linvel — earlier `linvel` is the tick-start snapshot.
      const cur = rb.linvel()
      const speedH = Math.hypot(cur.x, cur.z)
      if (speedH > 4) {
        const slopeAngle = Math.atan(surfaceForwardSlope)
        const cs = Math.cos(slopeAngle)
        const sn = Math.sin(slopeAngle)
        const speed3d = Math.hypot(cur.x, cur.y, cur.z)
        // Target: velocity along bike-fwd tilted up by slopeAngle,
        // preserving total speed.
        const tangentVx = planeFwdX * cs * speed3d
        const tangentVy = sn * speed3d
        const tangentVz = planeFwdZ * cs * speed3d
        // Soft pull (~70 ms half-life) — quick enough to clear a slope
        // transition before the capsule clips the trimesh, slow enough
        // not to fight intentional player Q/E pitch input.
        const REDIRECT_RATE = 10
        const blend = Math.min(1, REDIRECT_RATE * dt)
        const dvx = (tangentVx - cur.x) * blend
        const dvy = (tangentVy - cur.y) * blend
        const dvz = (tangentVz - cur.z) * blend
        rb.applyImpulse({ x: dvx * m, y: dvy * m, z: dvz * m }, true)
      }
    }
  }

  // ── Landing momentum redirect ─────────────────────────────────────
  // Motocross "hit the lip right" reward. On airborne→grounded, if the
  // bike is descending onto a downward slope, convert part of the
  // vertical descent into forward velocity along the slope. The spring
  // would otherwise eat the descent (damp kills upward velocity but the
  // descending KE just becomes spring-displacement work). Redirecting
  // before the spring sees it makes a clean ramp landing read as a
  // slingshot exit, not a slap.
  //
  // RAW slope here — fires only on the transition, when the filter is
  // still seeded from zero. Filtered value would gate the redirect off
  // on the first ground tick.
  if (
    !prevGrounded &&
    linvel.y < -2 &&
    footprint.surfaceForwardSlopeRaw < -0.1 &&
    planeFwdLen > 0.01
  ) {
    const descend = -linvel.y // positive m/s
    const slopeAngle = Math.atan(-footprint.surfaceForwardSlopeRaw) // positive
    const REDIRECT_MAX = 0.7
    const REDIRECT_SLOPE_FULL = Math.PI / 4 // 45° = full payoff
    const redirectFrac = Math.min(slopeAngle / REDIRECT_SLOPE_FULL, 1) * REDIRECT_MAX
    const dvForward = descend * redirectFrac
    rb.applyImpulse(
      {
        x: planeFwdX * dvForward * m,
        y: planeFwdY * dvForward * m,
        z: planeFwdZ * dvForward * m,
      },
      true,
    )
  }

  // ── Yaw torque around the "pure heading" axis ─────────────────────
  // Up with the bike-fwd projection removed — perpendicular to bike-fwd
  // by construction, so steering can't leak into roll regardless of
  // pitch. In anti-grav we substitute the zone's up so yaw rotates
  // around the road normal (MK8 anti-grav feel).
  const turnMul = probe.isWater ? 1.1 : 1.0
  const aTurn = -intent.steer * stats.turnTorque * turnMul
  const yawAxXG = upX - fwdDotUpG * fwd.x
  const yawAxYG = upY - fwdDotUpG * fwd.y
  const yawAxZG = upZ - fwdDotUpG * fwd.z
  const yawAxLenG = Math.hypot(yawAxXG, yawAxYG, yawAxZG)
  if (yawAxLenG > 0.01) {
    const invLenG = 1 / yawAxLenG
    rb.applyTorqueImpulse(
      {
        x: yawAxXG * invLenG * aTurn * m * dt,
        y: yawAxYG * invLenG * aTurn * m * dt,
        z: yawAxZG * invLenG * aTurn * m * dt,
      },
      true,
    )
  }

  // ── Fishtail bias ─────────────────────────────────────────────────
  // Shifts the perceived yaw pivot forward of CoM so the front "bites"
  // and the rear sweeps out, Jet-Moto-style. Geometric trick: a lateral
  // CoM acceleration of `α × pivotOffset` timed with the yaw torque
  // makes the point YAW_PIVOT_FWD metres ahead of CoM the instantaneous
  // rotation centre instead of CoM itself; the rear swings outward by
  // `2 × YAW_PIVOT_FWD × ω`. Faded in with speed so parking-lot wiggles
  // don't slide the bike sideways — fishtail is a high-speed feel.
  const YAW_PIVOT_FWD = 0.7 // metres forward of CoM
  const fishtailFade = Math.min(speed / 8, 1)
  if (fishtailFade > 0) {
    const aLatFish = -aTurn * YAW_PIVOT_FWD * fishtailFade
    rb.applyImpulse(
      {
        x: planeRightX * aLatFish * m * dt,
        y: planeRightY * aLatFish * m * dt,
        z: planeRightZ * aLatFish * m * dt,
      },
      true,
    )
  }

  // ── Roll PD (ground, non-anti-grav only) ─────────────────────────
  // Corrals roll toward `surfaceRoll + steer × leanLimit × speed-scale`.
  // Critical for keeping racers from spinning out after a fishtail or
  // wave strike (free roll runs away inside a few hundred ms otherwise).
  //
  // In anti-grav: skipped. The world-Y roll target fights zone-up
  // alignment. The multi-point spring's port/starboard differential plus
  // the AG alignment torque below handle roll there.
  if (!agActive) {
    const ROLL_LEAN_LIMIT = (40 * Math.PI) / 180 // 40° at "normal" speed
    const LEAN_SPEED_FULL = 6
    const LEAN_SPEED_HIGH = 24
    const LEAN_HIGH_SPEED_BOOST = 0.5 // up to 50% more lean → ~60°
    const LEAN_BASE = 0.4 // stationary = 40% of base limit (~16°)
    const speedFracR = Math.min(speed / LEAN_SPEED_FULL, 1)
    const baseLeanScale = LEAN_BASE + (1 - LEAN_BASE) * speedFracR
    const highSpeedFrac = Math.min(
      Math.max(speed - LEAN_SPEED_FULL, 0) / (LEAN_SPEED_HIGH - LEAN_SPEED_FULL),
      1,
    )
    const leanScale = baseLeanScale + highSpeedFrac * LEAN_HIGH_SPEED_BOOST
    // Surface roll component — multi-probe height differential across
    // the bike's width. Banks the bike into a wave normal when riding
    // diagonally across chop.
    const surfaceRollTarget = Math.atan2(
      footprint.starboardProj - footprint.portProj,
      2 * footprint.probeHalfWidth,
    )
    const targetRoll = surfaceRollTarget + intent.steer * ROLL_LEAN_LIMIT * leanScale
    // Extract true YXZ roll from current rotation.
    const r10R = 2 * (q.x * q.y + q.z * q.w)
    const r11R = 1 - 2 * (q.x * q.x + q.z * q.z)
    const currentRoll = Math.atan2(r10R, r11R)
    const fwdR = quatRotate(q, { x: 0, y: 0, z: 1 })
    const angvR = rb.angvel()
    const rollVel = angvR.x * fwdR.x + angvR.y * fwdR.y + angvR.z * fwdR.z
    // PD gains tuned for a ~0.3s settle, slightly underdamped (lively).
    const ROLL_P = 40
    const ROLL_D = 8
    const aRollPD = (targetRoll - currentRoll) * ROLL_P - rollVel * ROLL_D
    rb.applyTorqueImpulse(
      {
        x: fwdR.x * aRollPD * m * dt,
        y: fwdR.y * aRollPD * m * dt,
        z: fwdR.z * aRollPD * m * dt,
      },
      true,
    )
  }

  // ── Lateral drag ──────────────────────────────────────────────────
  // Water has *more* lateral resistance (skis don't slide sideways
  // easily). Measured along the up-plane right axis so drag opposes
  // sideways drift across the road surface (not across world XZ).
  const dragMul = probe.isWater ? 1.4 : 1.0
  const lateralVel = linvel.x * planeRightX + linvel.y * planeRightY + linvel.z * planeRightZ
  const aDrag = -lateralVel * stats.lateralDrag * dragMul
  rb.applyImpulse(
    {
      x: planeRightX * aDrag * m * dt,
      y: planeRightY * aDrag * m * dt,
      z: planeRightZ * aDrag * m * dt,
    },
    true,
  )
}

/**
 * Anti-grav trailing corrections — manual gravity along −up + PD that
 * aligns the bike's local +Y to the zone up. Runs only on grounded ticks
 * with `agActive` set; the spring's port/starboard differential already
 * does the bulk of the alignment, so this PD is mostly a transition aid
 * that speeds up rotation on zone enter/exit.
 */
function applyAntiGravCorrections(frame: HoverFrame): void {
  const { rb, dt, m, gravity, upX, upY, upZ } = frame
  rb.applyImpulse(
    {
      x: -upX * gravity * m * dt,
      y: -upY * gravity * m * dt,
      z: -upZ * gravity * m * dt,
    },
    true,
  )
  // PD alignment: bring the bike's local +Y onto up. cross(bikeUp, up) is
  // the rotation-axis × sin(angle) — standard restoring torque direction
  // for "align A to B". Reduced gain (20) now that the spring also
  // aligns; this just smooths the transition.
  const bUp = quatRotate(rb.rotation(), { x: 0, y: 1, z: 0 })
  const cx = bUp.y * upZ - bUp.z * upY
  const cy = bUp.z * upX - bUp.x * upZ
  const cz = bUp.x * upY - bUp.y * upX
  const AG_ALIGN_P = 20
  const AG_ALIGN_D = 5
  const angvA = rb.angvel()
  rb.applyTorqueImpulse(
    {
      x: (cx * AG_ALIGN_P - angvA.x * AG_ALIGN_D) * m * dt,
      y: (cy * AG_ALIGN_P - angvA.y * AG_ALIGN_D) * m * dt,
      z: (cz * AG_ALIGN_P - angvA.z * AG_ALIGN_D) * m * dt,
    },
    true,
  )
}

// ============================================================================
// Persisted state + debug overlay writes
// ============================================================================

function writeHoverState(
  eid: number,
  groundDistance: number,
  isGrounded: boolean,
  isWater: boolean,
  surfaceForwardSlope: number,
  diveHoldS: number,
): void {
  HoverStateStore.set(eid, {
    groundDistance,
    isGrounded,
    surfaceIsWater: isWater,
    // Reset filtered slope to 0 while airborne so the next landing
    // seeds the filter from zero.
    forwardSlope: isGrounded ? surfaceForwardSlope : 0,
    diveHoldS,
  })
}

function writeHoverDebug(
  frame: HoverFrame,
  probe: SurfaceProbe,
  groundDistance: number,
  isGrounded: boolean,
  surfaceForwardSlope: number,
  debugCorners: HoverProbe[],
  centerHitX: number,
  centerHitY: number,
  centerHitZ: number,
): void {
  // Effective hover-height target — matches the slope-aware boost
  // applied per-corner inside the spring loop so the renderer's
  // target ring sits at the same height the spring is aiming for.
  const slopeBoostDbg = probe.isWater ? 0 : Math.abs(surfaceForwardSlope) * SLOPE_HOVER_BOOST
  HoverDebugStore.set(frame.eid, {
    upX: frame.upX,
    upY: frame.upY,
    upZ: frame.upZ,
    dnX: frame.dnX,
    dnY: frame.dnY,
    dnZ: frame.dnZ,
    cx: frame.t.x,
    cy: frame.t.y,
    cz: frame.t.z,
    centerHitX,
    centerHitY,
    centerHitZ,
    hasSurface: probe.hasSurface,
    isWater: probe.isWater,
    groundDistance,
    effHoverHeight: frame.stats.hoverHeight + slopeBoostDbg,
    isGrounded,
    corners: debugCorners,
    surfaceForwardSlope,
    probeLift: devSettings.hoverProbeLift,
  })
}

function makeDebugCorners(): HoverProbe[] {
  return [
    { ox: 0, oy: 0, oz: 0, hx: Number.NEGATIVE_INFINITY, hy: 0, hz: 0, active: false, aUp: 0 },
    { ox: 0, oy: 0, oz: 0, hx: Number.NEGATIVE_INFINITY, hy: 0, hz: 0, active: false, aUp: 0 },
    { ox: 0, oy: 0, oz: 0, hx: Number.NEGATIVE_INFINITY, hy: 0, hz: 0, active: false, aUp: 0 },
    { ox: 0, oy: 0, oz: 0, hx: Number.NEGATIVE_INFINITY, hy: 0, hz: 0, active: false, aUp: 0 },
  ]
}

// ============================================================================
// Main system — orchestrator
// ============================================================================

/**
 * Per-bike: probe ground/water, run the attitude PDs, then dispatch to
 * the air or ground branch. All coefficients are in acceleration units
 * (m/s² per unit). Impulses are computed as `accel * mass * dt` so
 * tuning stays decoupled from mass. Force order inside the dispatch is
 * load-bearing — see the inline comments in each helper.
 */
export function hoverSystem(sim: SimWorld, phys: PhysicsWorld, field: WaveFieldState | null): void {
  // Single source of truth for gravity magnitude. Read fresh each call
  // so anti-grav and slope-momentum stay in lockstep with the physics
  // world if it's ever retuned.
  const gravity = Math.abs(phys.world.gravity.y)
  const eids = query(sim, [BikeTag, RBHandle, BikeStats, ControlIntent, HoverState])

  for (const eid of eids) {
    const { handle } = RBHandleStore.must(eid)
    const stats = BikeStatsStore.must(eid)
    const intent = ControlIntentStore.must(eid)
    const rb = phys.world.getRigidBody(handle)
    if (!rb) continue
    // Kinematic bikes (remote players on non-host, AI bikes on non-host)
    // are pose-driven by network snapshots. The spring + alignment below
    // would fight `setNextKinematicTranslation`. Skip.
    if (!rb.isDynamic()) continue

    const frame = buildHoverFrame(eid, rb, stats, intent, phys.fixedDt, gravity)

    // Wave field is a horizontal phenomenon — disable inside anti-grav
    // so a zone over open water doesn't read phantom water under the
    // bike.
    const probeField = frame.agActive ? null : field

    // Center probe + grounded gate. `groundDistance` is the distance
    // from the bike center down to the ride surface along the up axis.
    const probe = probeSurface(
      phys,
      probeField,
      frame.t.x,
      frame.t.y,
      frame.t.z,
      frame.dnX,
      frame.dnY,
      frame.dnZ,
      frame.upX,
      frame.upY,
      frame.upZ,
      rb,
    )
    const bikeProj = frame.t.x * frame.upX + frame.t.y * frame.upY + frame.t.z * frame.upZ
    const groundDistance = probe.hasSurface ? bikeProj - probe.surfaceProj : MAX_HOVER_PROBE
    const isGrounded = probe.hasSurface && groundDistance < stats.hoverHeight * GROUNDED_DISTANCE_MUL

    // Prior tick's state — drives the slope filter seed, the takeoff/
    // landing transitions, the dive-kick taper, and the rendered
    // hover-target ring.
    const prevHover = HoverStateStore.get(eid)
    const prevGrounded = prevHover?.isGrounded ?? false
    const prevForwardSlope = prevHover?.forwardSlope ?? 0
    const prevDiveHoldS = prevHover?.diveHoldS ?? 0
    // Dive-hold timer: ticks up while the player holds nose-down input,
    // resets on release. Feeds the player-torque taper so the rider
    // gets one initial nose-dive transient per press, then the pitch
    // PD restores the chassis to surface tangent. Sustained nose-down
    // input then reads as altitude control (DIVE_HOVER_HEIGHT_MIN_MUL),
    // not chassis tilt. Gated on `intent.pitch <= -0.05` to match the
    // deadzone in applyPlayerPitchTorque.
    const diveHoldS = frame.intent.pitch <= -0.05 ? prevDiveHoldS + frame.dt : 0

    // Debug capture — only allocates when the global flag is on.
    const debugOn = isHoverDebugEnabled()
    const debugCorners = debugOn ? makeDebugCorners() : []

    // Center hit point (debug only). Reconstructed from the probe's
    // surface projection along −up; for water hits there is no physical
    // ray hit so this places the marker on the wave plane under the
    // bike's xz column.
    let centerHitX = 0
    let centerHitY = 0
    let centerHitZ = 0
    if (debugOn && probe.hasSurface) {
      const along = bikeProj - probe.surfaceProj
      centerHitX = frame.t.x + frame.dnX * along
      centerHitY = frame.t.y + frame.dnY * along
      centerHitZ = frame.t.z + frame.dnZ * along
    }

    // Multi-probe footprint sampling — only meaningful while grounded.
    // Airborne returns an inert placeholder; downstream phases that
    // consult the footprint are gated on `isGrounded`.
    const footprint = isGrounded
      ? sampleSurfaceFootprint(
          frame,
          phys,
          probe,
          probeField,
          debugOn,
          debugCorners,
          prevForwardSlope,
        )
      : emptyFootprint()

    // Bad-landing / bad-attitude velocity-kill (rider-crash trigger).
    applyBadLandingChecks(frame, probe, footprint.surfaceForwardSlopeRaw, prevGrounded, isGrounded)

    // Multi-point hover spring (or underwater buoyancy on water).
    if (probe.hasSurface && isGrounded) {
      applyMultiPointHoverSpring(frame, footprint, probe, groundDistance, debugOn, debugCorners)
    }

    // Grounded pitch PD — self-righting torque on land + water. Air
    // branch has no auto-leveling by design; flips and dives in air
    // run on pure player input + chassis inertia.
    const isOverWater = probe.hasSurface && probe.isWater
    if (isGrounded) applyGroundedPitchPD(frame, footprint.surfaceForwardSlope)

    // Persist state for next tick + render-side reads. (HoverState is
    // written *before* the player pitch torque so its `isGrounded`
    // reflects the surface read, not the post-impulse body.)
    writeHoverState(
      frame.eid,
      groundDistance,
      isGrounded,
      probe.hasSurface && probe.isWater,
      footprint.surfaceForwardSlope,
      diveHoldS,
    )
    if (debugOn) {
      writeHoverDebug(
        frame,
        probe,
        groundDistance,
        isGrounded,
        footprint.surfaceForwardSlope,
        debugCorners,
        centerHitX,
        centerHitY,
        centerHitZ,
      )
    } else if (HoverDebugStore.has(eid)) {
      HoverDebugStore.delete(eid)
    }

    // Player pitch torque — fires in BOTH air and ground branches with
    // different coefficients. `isOverWater` extends the dive clamp to
    // airborne flights over water (kills wave-pop forward flips).
    // `diveHoldS` drives the dive-kick taper — see applyPlayerPitchTorque.
    applyPlayerPitchTorque(
      frame,
      isGrounded,
      isOverWater,
      footprint.surfaceForwardSlope,
      diveHoldS,
    )

    if (!isGrounded) {
      applyAirControlBranch(frame)
      continue
    }

    applyGroundBranch(frame, footprint, probe, prevGrounded, groundDistance)
    if (frame.agActive) applyAntiGravCorrections(frame)
  }
}
