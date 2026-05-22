import type RAPIER from '@dimforge/rapier3d-compat'
import { query } from 'bitecs'
import { devSettings } from '@/engine/dev-settings'
import { isHoverDebugEnabled } from '@/engine/sim/debug-flags'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate, vecHorizontalLength } from '@/engine/sim/physics/vec'
import { sampleHeight, type WaveFieldState } from '@/engine/sim/water/wave-field'
import {
  AntiGravOverrideStore,
  BikeStats,
  BikeStatsStore,
  BikeTag,
  BoostMeterStore,
  ControlIntent,
  ControlIntentStore,
  HoverDebugStore,
  HoverState,
  HoverStateStore,
  type HoverProbe,
  RBHandle,
  RBHandleStore,
} from '@/game/components'
import { getCurrentBoostMultiplier } from '@/game/systems/pickup'

const MAX_HOVER_PROBE = 6
const GRAVITY = 25 // must match PhysicsWorld gravity magnitude

// Reused per-probe Ray. Each bike fires 5 probes per fixed tick (1 center +
// 4 footprint); at 5 bikes × 60 Hz that's ~1500 allocations/sec if we new
// the Ray every call. Lazy-init on first use because the Ray constructor is
// only valid after Rapier WASM has loaded — `phys.rapier` carries it in.
// `castRay` reads origin/dir synchronously and doesn't retain a reference,
// so reuse across sequential calls in the same tick is safe.
//
// The direction is mutable so anti-grav can cast along the zone's local
// −Y instead of world down. World-down (0,−1,0) is still the dominant
// case: callers in non-anti-grav land pass that directly.
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

// Slope-momentum tuning — exported for tests / debug overlays. Strongly
// asymmetric gain: a hard 1.0× push DOWN a wave face for the motocross
// slingshot, but only a feather-light 0.15× drag going UP. The hoverbike is
// supposed to glide up steep terrain (SF / Seattle grades, ramp faces) the
// way a real hover platform would — the engine fights gravity, it doesn't
// drag the chassis. Keep the asymmetry > 1 so the down/up ratio guard in
// slope-momentum.test still holds and the downhill payoff stays distinct.
export const SLOPE_DOWN_GAIN = 1.0
export const SLOPE_UP_BRAKE = 0.15

// Slope-aware hover-height boost. On a climb (or descent) the bike rides
// proportionally higher than the nominal `hoverHeight`, so the chassis
// stays well clear of the rising trimesh. Without it the velocity-
// redirect kept the capsule from clipping the slope, but the visual gap
// shrank to <0.5m — players read that as "dragging" because the chassis
// sits low and close to the road. Lifting an extra `|tan slope|` metres
// scales naturally; flat ground stays at nominal hoverHeight (lobby /
// HUD feel unchanged). 0.5 reads as "the bike floats over the hill" in
// playtest without over-tuning launch behaviour on lumpy terrain.
export const SLOPE_HOVER_BOOST = 0.4

// Fraction of slope-tangent velocity the hover damp is allowed to ignore.
// At 1.0, damp fires zero when the bike is climbing at exactly the
// slope-tangent rate — but then any spring spike (lumpy terrain mid-
// climb) goes unchecked and the bike launches. At 0.0, damp fires full
// (legacy behaviour: ~70 m/s² downward force on a 25° hill at 18 m/s,
// which overwhelms the spring and pins the chassis below hoverHeight).
// 0.7 lets the bike climb without dragging while still anchoring the
// chassis enough to suppress bump-driven launches.
export const SLOPE_DAMP_RELIEF = 0.5

// Upper clamp on the per-corner heightError fed into the hover spring.
// When the bow probe looks ahead at a steep climb, localDist goes deeply
// negative ("surface is high above my probe point"), and `heightError =
// hoverHeight - localDist` grows unboundedly positive. At raw values
// (say +5m) the spring would fire at >200 m/s² of upward force on a
// single corner — an 8 G bow-kick that whip-pitches the chassis sky-
// ward on slope approaches. Clamping to one hoverHeight worth of
// authority caps that to ~40 m/s² (~1.6 G's per corner), which still
// pre-pitches the chassis to climb but never launches the bike. The
// slope-momentum path (which uses bow/stern projection differential)
// is unaffected, so the climb signal still reaches the engine.
export const MAX_BOW_LIFT_ERROR = 1.2 // metres, ~= one hoverHeight

/**
 * Marble-on-incline acceleration along the bike's horizontal forward axis.
 *
 * Driven by `surfacePitchTarget` — the *terrain-tracking* pitch (positive =
 * nose-down on a downslope, zero on flat ground, negative on an upslope).
 * Crucially this is the surface signal, not the chassis's current pitch:
 * the chassis pitch also folds in the player's Q/E input, and feeding that
 * in would let the rider farm free downhill thrust by tipping the nose on
 * flat ground.
 */
export function slopeMomentumAccel(
  surfacePitchTarget: number,
  gravity: number = GRAVITY,
  downGain: number = SLOPE_DOWN_GAIN,
  upBrake: number = SLOPE_UP_BRAKE,
): number {
  const gain = surfacePitchTarget > 0 ? downGain : upBrake
  return Math.sin(surfacePitchTarget) * gravity * gain
}

/**
 * Surface probe: looks below an XZ point for the closest "ride surface".
 * Either a hard physical collider (raycast) or the wave field water surface,
 * whichever is *higher* (closer to the bike) wins. This unifies driving on
 * land and driving on water — same controller, different surface y.
 *
 * Used both as the *center probe* (one per bike, drives hover spring +
 * grounded gating + dive logic) and as the *footprint probes* (four per
 * bike at bow / stern / port / starboard, drive surface alignment). The
 * footprint version (`probeSurfaceY`) only needs the height — it doesn't
 * care about isWater/hasSurface gating.
 */
type SurfaceProbe = {
  /** Surface hit point projected onto the up axis (i.e. `hitPoint · up`).
   *  When `up = (0,1,0)` this is the hit's world-Y, matching the historic
   *  semantics. Inside an anti-grav zone, `up` becomes the zone's local +Y
   *  and this is the projected distance along that axis. */
  surfaceProj: number
  isWater: boolean
  hasSurface: boolean
}

/**
 * Center probe. Casts from (fromX,fromY,fromZ) along (dx,dy,dz) and also
 * samples the wave field for water. Returns the higher surface (projected
 * on up) as the ride surface. Water sampling is XZ-only — only call with
 * a non-null `field` when up ≈ world-Y (anti-grav callers pass null).
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
    // Hit point = origin + dir × timeOfImpact. Project onto up.
    const hx = fromX + dx * hit.timeOfImpact
    const hy = fromY + dy * hit.timeOfImpact
    const hz = fromZ + dz * hit.timeOfImpact
    groundProj = hx * upX + hy * upY + hz * upZ
  }
  const waterY = field ? sampleHeight(field, fromX, fromZ) : Number.NEGATIVE_INFINITY

  // Higher surface wins — that's what the bike rides on.
  if (groundProj === Number.NEGATIVE_INFINITY && waterY === Number.NEGATIVE_INFINITY) {
    return { surfaceProj: 0, isWater: false, hasSurface: false }
  }
  if (groundProj > waterY) {
    return { surfaceProj: groundProj, isWater: false, hasSurface: true }
  }
  // Water can be sampled anywhere, so water is "always reachable" — but only
  // counts as a ride surface if the bike is within probe range of it.
  // (When `field` is non-null we're in world-up land, so fromY is the bike's
  // proj on up and waterY is the surface proj.)
  const reachable = fromY - waterY < MAX_HOVER_PROBE
  return { surfaceProj: waterY, isWater: true, hasSurface: reachable }
}

/**
 * Footprint probe: returns the surface projection on up at the probe's XYZ.
 * Returns NEGATIVE_INFINITY if neither ground nor water is found (caller
 * falls back to the center probe — see surface alignment block).
 *
 * `lift` raises the ray origin `lift` metres along +up so the cast can see
 * surface rising ABOVE the probe — critical for ramp / wall anticipation.
 * A bow probe at the bike's level casting along the bike's "down" will
 * MISS an upcoming ramp face. Lifting along up lets the same ray hit that
 * face from above. Cast distance grows to compensate so the same set of
 * surface beyond remains reachable.
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
  // Lift the origin along +up by `lift` metres (and project that origin's
  // up-coordinate accordingly below).
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

/**
 * Per-bike: probe ground/water, apply hover/thrust/steer/lateral-drag.
 * All coefficients are in acceleration units (m/s^2 per unit). Impulses are
 * computed as accel * mass * dt so tuning stays decoupled from mass.
 */
export function hoverSystem(sim: SimWorld, phys: PhysicsWorld, field: WaveFieldState | null): void {
  const eids = query(sim, [BikeTag, RBHandle, BikeStats, ControlIntent, HoverState])
  for (const eid of eids) {
    const { handle } = RBHandleStore.must(eid)
    const stats = BikeStatsStore.must(eid)
    const intent = ControlIntentStore.must(eid)
    const rb = phys.world.getRigidBody(handle)
    if (!rb) continue
    // M10.11 — kinematic bikes (remote players on non-host, AI bikes on
    // non-host) are pose-driven by network snapshots. The hover spring,
    // surface alignment, and angular damping below all mutate the rigid
    // body, which would fight `setNextKinematicTranslation`. Skip.
    if (!rb.isDynamic()) continue

    const t = rb.translation()
    const linvel = rb.linvel()
    const dt = phys.fixedDt
    const m = stats.mass

    // Anti-grav override — written by `antiGravSystem` earlier this tick.
    // When `agActive` is true the bike is influenced by an anti-grav
    // source (curve sample with non-zero weight OR contained in a zone):
    // Rapier world gravity is disabled for this body and we apply gravity
    // along `−up · G` ourselves at the end of the loop. Probes cast along
    // that same direction and the hover spring lifts along +up.
    //
    // The "up" we use is the WEIGHTED BLEND of the source up vector with
    // world up: at weight=1 it's purely the source's up (full wall ride);
    // at weight=0.3 (bike drifting out of the falloff) it tilts back
    // toward world up smoothly. Stored upX/Y/Z is the source's smoothed
    // up; we blend per-tick rather than in the resolver so the gradient
    // tracks distance changes between the bike and the curve in real time.
    //
    // When NOT active, `(upX,upY,upZ) = (0,1,0)`, agActive=false, and the
    // whole machine below reduces to world-down behaviour.
    let agActive = false
    let upX = 0
    let upY = 1
    let upZ = 0
    let agWeight = 0
    const agOverride = AntiGravOverrideStore.get(eid)
    if (agOverride && agOverride.active) {
      agActive = true
      agWeight = agOverride.weight
      // Effective up = blend(worldUp, sourceUp, weight). Normalize so the
      // probe / spring math stays unit-length-correct. Degenerate only
      // when source up ≈ −worldUp at exactly weight=0.5 (a half-blend
      // between right-side-up and upside-down) — authoring should keep
      // banking changes incremental enough that the bike never sits
      // exactly there for long. Fallback to source up if degenerate.
      const blendX = (1 - agWeight) * 0 + agWeight * agOverride.upX
      const blendY = (1 - agWeight) * 1 + agWeight * agOverride.upY
      const blendZ = (1 - agWeight) * 0 + agWeight * agOverride.upZ
      const bLen = Math.hypot(blendX, blendY, blendZ)
      if (bLen > 1e-3) {
        upX = blendX / bLen
        upY = blendY / bLen
        upZ = blendZ / bLen
      } else {
        upX = agOverride.upX
        upY = agOverride.upY
        upZ = agOverride.upZ
      }
    }
    const dnX = -upX
    const dnY = -upY
    const dnZ = -upZ
    // Wave field is a horizontal phenomenon — disable inside anti-grav so a
    // zone over open water doesn't read phantom water under the bike.
    const probeField = agActive ? null : field
    // Bike-center projection on the up axis. Replaces every prior use of
    // `t.y` in distance-along-up calculations.
    const bikeProj = t.x * upX + t.y * upY + t.z * upZ

    // Cache the bike's rotation up-front — the probe-geometry block and the
    // ground-control block both need it (was lazily read mid-function before
    // the up-plane refactor pulled the spring's quat needs into the probe
    // block).
    const q = rb.rotation()

    const probe = probeSurface(phys, probeField, t.x, t.y, t.z, dnX, dnY, dnZ, upX, upY, upZ, rb)
    const groundDistance = probe.hasSurface ? bikeProj - probe.surfaceProj : MAX_HOVER_PROBE
    const isGrounded = probe.hasSurface && groundDistance < stats.hoverHeight * 1.6

    // Per-bike debug capture — only allocates when the global flag is on.
    // The renderer (`engine/render/hover-debug.ts`) reads this each frame
    // to draw probe rays, hit markers, and spring force arrows. Skipped
    // entirely otherwise so normal play pays nothing.
    const debugOn = isHoverDebugEnabled()
    const debugCorners: HoverProbe[] = debugOn
      ? [
          { ox: 0, oy: 0, oz: 0, hx: Number.NEGATIVE_INFINITY, hy: 0, hz: 0, active: false, aUp: 0 },
          { ox: 0, oy: 0, oz: 0, hx: Number.NEGATIVE_INFINITY, hy: 0, hz: 0, active: false, aUp: 0 },
          { ox: 0, oy: 0, oz: 0, hx: Number.NEGATIVE_INFINITY, hy: 0, hz: 0, active: false, aUp: 0 },
          { ox: 0, oy: 0, oz: 0, hx: Number.NEGATIVE_INFINITY, hy: 0, hz: 0, active: false, aUp: 0 },
        ]
      : []
    // Center probe hit point — projected back to world from the
    // `surfaceProj` value (which is the hit's up-axis projection).
    // When the surface is water the hit point isn't physically a ray
    // hit; reconstruct it on the wave plane under the bike (xz column).
    let centerHitX = 0
    let centerHitY = 0
    let centerHitZ = 0
    if (debugOn && probe.hasSurface) {
      const along = bikeProj - probe.surfaceProj
      centerHitX = t.x + dnX * along
      centerHitY = t.y + dnY * along
      centerHitZ = t.z + dnZ * along
    }

    // Surface alignment: figure out how the chassis should sit relative to
    // the surface it's riding. When airborne we don't know what surface the
    // bike is heading toward, so the targets stay 0 and the bike just holds
    // its current attitude.
    //
    // Multi-probe sampling (SoT/Atlas-style), unified across water + ground.
    // Read the surface height at four points around the bike — bow, stern,
    // port, starboard — and let pitch/roll fall out of differential heights:
    //
    //     pitch ≈ atan2(y_bow − y_stern, 2·halfLength)
    //     roll  ≈ atan2(y_starboard − y_port, 2·halfWidth)
    //
    // Each probe takes max(ground raycast, wave field height), so a bike
    // straddling the shoreline correctly reads the high terrain on one side
    // and the wave on the other. This is *more correct* than reading the
    // local wave normal under the bike's center, because the bike has a
    // real footprint in world space:
    //   1. Long swells naturally tilt the bike across the wave.
    //   2. Short chops + sub-footprint terrain bumps average between probes
    //      so the bike doesn't whip-snap to every ripple or trimesh edge.
    //   3. Mixed water/terrain transitions (water lapping a ledge, bow over
    //      a ramp with stern still on water) read continuously instead of
    //      flickering between water-only and ground-only branches.
    //
    // `surfaceForwardSlope` is the bow→stern height differential as a
    // dy/dx ratio along the bike's forward direction (negative ⇒ downslope
    // ahead). Captured outside the grounded gate so the landing-redirect
    // block below can read it without re-sampling.
    // Surface alignment + multi-probe sampling. Read the surface height
    // at four points around the bike — bow, stern, port, starboard — so
    // the multi-point hover spring below can apply differential vertical
    // forces at each probe position. Differential forces produce
    // physically correct alignment torques: bow lower than nominal hover
    // height → bigger upward force at bow → bike pitches nose-up to match
    // the surface. Same trick rolls the bike into a wave normal across
    // port/starboard. No kinematic re-imposition anywhere — the rider
    // asked for full physics, this is how a hover-bike self-aligns
    // physically (Trials feel).
    //
    // `surfaceForwardSlope` is the bow→stern height differential as a
    // dy/dx ratio along the bike's forward direction (negative ⇒ downslope
    // ahead). Captured at outer scope so the landing-redirect block below
    // can read it without re-sampling.
    // `surfaceForwardSlope` is the bow→stern surface-projection differential
    // divided by 2·halfLength along the bike's forward direction — the
    // standard "rise / run" slope along the bike's heading. Captured at
    // outer scope so the landing-redirect block below can read it without
    // re-sampling. Same semantics regardless of up vector: it's the slope
    // of the surface along the bike's forward, projected onto the up axis.
    let surfaceForwardSlope = 0
    let bowProj = Number.NEGATIVE_INFINITY
    let sternProj = Number.NEGATIVE_INFINITY
    let starboardProj = Number.NEGATIVE_INFINITY
    let portProj = Number.NEGATIVE_INFINITY
    let probeHalfLength = 0.8
    let probeHalfWidth = 0.4
    // Sample-position fwd/right: bike-fwd projected onto the up-plane (so a
    // pitched bike still samples surface "ahead along the road", not "ahead
    // and above" which would miss the ramp it's approaching). When up = Y
    // and the bike is yawed only, this reduces to (sin yaw, 0, cos yaw) —
    // the historic XZ-only probe direction.
    let sampleFwdX = 0
    let sampleFwdY = 0
    let sampleFwdZ = 1
    let sampleRightX = 1
    let sampleRightY = 0
    let sampleRightZ = 0
    // Force-position fwd/right: full 3D bike-fwd/right (NOT projected). The
    // spring applies impulses at the bow's *actual* world position, which
    // for a pitched bike has a Y component. That y-offset is what gives
    // flat-ground attitude restoration — a nose-up bike's bow is higher,
    // so its heightError reads larger → spring pushes bow down → levels.
    let forceFwdX = 0
    let forceFwdY = 0
    let forceFwdZ = 1
    let forceRightX = 1
    let forceRightY = 0
    let forceRightZ = 0
    if (isGrounded) {
      // Probe footprint matches the bike's visual scale (~1.6m × 0.8m) at
      // rest, then extends fore/aft with bike speed (anticipation: at 25 m/s
      // the bow probe is ~2m out in front, so the bike pitches to match the
      // slope it's about to hit). Speed is measured in the up-plane so the
      // anticipation works on tilted anti-grav roads too.
      const linvelUp = linvel.x * upX + linvel.y * upY + linvel.z * upZ
      const planeVx = linvel.x - upX * linvelUp
      const planeVy = linvel.y - upY * linvelUp
      const planeVz = linvel.z - upZ * linvelUp
      const speedPlane = Math.hypot(planeVx, planeVy, planeVz)
      // Probe geometry is read live from devSettings so the F4 hover-
      // debug overlay can preview tuning changes immediately. Defaults
      // are 0.8 / 0.4 / 0.05 — historical values, baked into
      // DEFAULT_DEV_SETTINGS. The anticipation cap (1.4 m) stays
      // hardcoded; it's a guard against speed-driven overshoot, not a
      // tuning knob.
      probeHalfLength =
        devSettings.hoverProbeHalfLength +
        Math.min(speedPlane * devSettings.hoverProbeSpeedScale, 1.4)
      probeHalfWidth = devSettings.hoverProbeHalfWidth

      // Full 3D bike-fwd / bike-right (used for the spring's force position).
      const fwd3D = quatRotate(q, { x: 0, y: 0, z: 1 })
      const right3D = quatRotate(q, { x: 1, y: 0, z: 0 })
      forceFwdX = fwd3D.x
      forceFwdY = fwd3D.y
      forceFwdZ = fwd3D.z
      forceRightX = right3D.x
      forceRightY = right3D.y
      forceRightZ = right3D.z

      // Project bike-fwd onto the up-plane, then normalize → the "horizontal"
      // forward in zone-local frame. Used to position the probe samples.
      // Fall back to forceFwd when degenerate (bike-fwd colinear with up —
      // i.e. nose pointing straight along the up axis, vanishingly rare).
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
      sampleFwdX = pfX
      sampleFwdY = pfY
      sampleFwdZ = pfZ
      // Right = up × fwdInUpPlane (unit, since both are unit and orthogonal).
      sampleRightX = upY * pfZ - upZ * pfY
      sampleRightY = upZ * pfX - upX * pfZ
      sampleRightZ = upX * pfY - upY * pfX

      // Each probe casts from PROBE_LIFT *along +up* of the bike center so a
      // rising surface in front of the bike (a ramp face, a wall on
      // approach) is correctly intersected from above. Live-tunable
      // via devSettings.hoverProbeLift.
      const PROBE_LIFT = devSettings.hoverProbeLift
      // probeSurfaceY returns max(ground, water) per location (projected on
      // up); falls back to the center probe's surface projection if neither
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
            // Walk back from the lifted origin along −up to where the
            // surface projection sits. The probe's XZ position is fixed
            // by the lifted origin column, so this reconstructs the hit
            // point as (origin_xz, surfaceY_along_up).
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
      bowProj = sampleAt(
        t.x + sampleFwdX * probeHalfLength,
        t.y + sampleFwdY * probeHalfLength,
        t.z + sampleFwdZ * probeHalfLength,
        0,
      )
      sternProj = sampleAt(
        t.x - sampleFwdX * probeHalfLength,
        t.y - sampleFwdY * probeHalfLength,
        t.z - sampleFwdZ * probeHalfLength,
        1,
      )
      starboardProj = sampleAt(
        t.x + sampleRightX * probeHalfWidth,
        t.y + sampleRightY * probeHalfWidth,
        t.z + sampleRightZ * probeHalfWidth,
        2,
      )
      portProj = sampleAt(
        t.x - sampleRightX * probeHalfWidth,
        t.y - sampleRightY * probeHalfWidth,
        t.z - sampleRightZ * probeHalfWidth,
        3,
      )
      surfaceForwardSlope = (bowProj - sternProj) / (2 * probeHalfLength)
    }

    // Attitude is FULLY PHYSICS-DRIVEN in this build — no kinematic
    // re-imposition of pitch or roll, no angvel stripping. The bike
    // tilts in response to:
    //   - Multi-point hover spring (below): differential vertical forces
    //     at bow/stern/port/starboard align the chassis to the local
    //     surface contour automatically.
    //   - Steer → roll torque around bike-fwd axis (lean into corners).
    //   - Player pitch input → torque around bike-right axis (commit
    //     to a nose-up or nose-down attitude that *persists*: holding
    //     the stick in the air integrates to a full backflip / dive;
    //     releasing lets Rapier angular damping bleed the spin but
    //     leaves the ANGLE wherever physics left it).
    //   - Yaw torque around world Y (unchanged) + lateral fishtail bias.
    //
    // Trials-style: input commands forces, not orientations. Sim "takes
    // over" the moment you let go.
    const prevHover = HoverStateStore.get(eid)
    const prevGrounded = prevHover?.isGrounded ?? false

    // Bad-landing crash. On the airborne→grounded transition over LAND,
    // if the chassis is wildly off the surface contour while moving
    // forward, kill horizontal velocity — the rider-crash Δv detector
    // picks up the dump next tick and ragdolls. Gated by speed so slow
    // tumbles just bounce. Water is exempt: nose-diving into water is
    // supposed to plough under, not ragdoll the rider. Anti-grav is also
    // exempt — the world-Y pitch this measures isn't meaningful when the
    // bike has just aligned to a tilted road plane.
    if (!prevGrounded && isGrounded && !probe.isWater && !agActive) {
      const qLand = rb.rotation()
      const r12Land = 2 * (qLand.y * qLand.z - qLand.x * qLand.w)
      const pitchLand = Math.asin(Math.max(-1, Math.min(1, -r12Land)))
      const surfacePitchAtLanding = -Math.atan(surfaceForwardSlope)
      const pitchOffSurface = Math.abs(pitchLand - surfacePitchAtLanding)
      const horizSpeedLand = Math.hypot(linvel.x, linvel.z)
      const BAD_LAND_PITCH = Math.PI / 3 // 60° off the surface contour
      const BAD_LAND_MIN_SPEED = 8 // m/s — slow tumbles just snap, no crash
      if (pitchOffSurface > BAD_LAND_PITCH && horizSpeedLand > BAD_LAND_MIN_SPEED) {
        rb.setLinvel({ x: 0, y: linvel.y, z: 0 }, true)
      }
    }

    // Continuous bad-attitude crash on land. Multi-point hover's
    // alignment torque is `r × F` from per-corner lift forces, and at
    // extreme pitch (nose down past 75° or so) the corner-to-CoM
    // displacement becomes parallel to the upward force vector — the
    // cross product collapses to zero, no restoring torque at all.
    // Without this check the bike would sit happily at vertical nose-
    // down on flat ground, hovered up by the bow's pure-linear lift
    // with nothing to right it. Crash instead: kill horizontal velocity,
    // rider-crash picks up the Δv next tick. Water + anti-grav exempt.
    if (isGrounded && !probe.isWater && !agActive) {
      const qBad = rb.rotation()
      const r12Bad = 2 * (qBad.y * qBad.z - qBad.x * qBad.w)
      const pitchBad = Math.asin(Math.max(-1, Math.min(1, -r12Bad)))
      const BAD_GROUND_PITCH = (75 * Math.PI) / 180
      if (Math.abs(pitchBad) > BAD_GROUND_PITCH) {
        rb.setLinvel({ x: 0, y: linvel.y, z: 0 }, true)
      }
    }

    // Multi-point hover spring. Fires only while grounded. Instead of a
    // single force at CoM, apply 1/4-mass vertical impulses at each of
    // the bow, stern, port, starboard probe positions. Each point's
    // upward force is sized by its LOCAL height error vs the surface
    // below it; differential forces naturally torque the chassis to
    // align with the surface contour — bow dips on flat ground →
    // strong upward kick at bow → pitch nose-up to neutral; starboard
    // sinks into a wave trough → strong kick on starboard → roll left.
    //
    // Sum of per-point forces equals the old single-point force when all
    // four heights agree, so vertical tuning (hoverSpring, hoverDamp)
    // transfers directly. The alignment torque is a free byproduct of
    // the multi-point geometry — no PD reading orientation, no kinematic
    // re-imposition.
    //
    // Underwater branch (M9.23 — Wave Race feel) stays single-point: when
    // the bike has dived below the water surface (groundDistance < 0 on
    // water), depth-proportional buoyancy + quadratic drag take over.
    // Symmetric spring would slam the bike back up the instant it dipped
    // below; instead we let dive momentum carry it under, drag bleeds the
    // momentum off, capped buoyancy walks it back up. Tuning targets a
    // peak depth around 1–2m on a hard dive.
    if (probe.hasSurface && isGrounded) {
      if (probe.isWater && groundDistance < 0) {
        const submersion = -groundDistance
        const BUOYANCY_PER_M = 14
        const BUOYANCY_CAP = 20
        // Asymmetric Y-axis drag: full strength when SINKING (kills dive
        // momentum so the bike actually slows as it reaches max depth),
        // much weaker when RISING so the accumulated buoyancy isn't
        // fought by drag on the way up.
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
            y: (GRAVITY + aBuoy + linvel.y * yDragCoef) * m * dt,
            z: linvel.z * horizDragCoef * m * dt,
          },
          true,
        )
      } else {
        const angv = rb.angvel()
        const POINT_MASS_FRAC = 0.25
        // Full 3D probe offsets at each corner. The force is applied at
        // (t + forceFwd|forceRight) — the bike's actual bow/stern/port/
        // starboard world position, including pitch contribution. That's
        // what gives flat-ground attitude restoration: a nose-up bike's
        // bow is higher than the surface beneath it, so heightError reads
        // negative there → spring pushes bow DOWN → levels the chassis.
        //
        // `longitudinal` tags the bow/stern probes vs port/starboard.
        // On water, the longitudinal spring is softened so the bike
        // pushes THROUGH chop instead of pitching to match every wave
        // crest. Lateral (roll-axis) spring keeps full stiffness.
        const points: {
          ox: number
          oy: number
          oz: number
          surfProj: number
          longitudinal: boolean
        }[] = [
          {
            ox: forceFwdX * probeHalfLength,
            oy: forceFwdY * probeHalfLength,
            oz: forceFwdZ * probeHalfLength,
            surfProj: bowProj,
            longitudinal: true,
          },
          {
            ox: -forceFwdX * probeHalfLength,
            oy: -forceFwdY * probeHalfLength,
            oz: -forceFwdZ * probeHalfLength,
            surfProj: sternProj,
            longitudinal: true,
          },
          {
            ox: forceRightX * probeHalfWidth,
            oy: forceRightY * probeHalfWidth,
            oz: forceRightZ * probeHalfWidth,
            surfProj: starboardProj,
            longitudinal: false,
          },
          {
            ox: -forceRightX * probeHalfWidth,
            oy: -forceRightY * probeHalfWidth,
            oz: -forceRightZ * probeHalfWidth,
            surfProj: portProj,
            longitudinal: false,
          },
        ]
        // Tuned by playtest: 0.4× reads as "the bow plows through chop
        // without losing all wave-following on long swells." Drop further
        // to make it feel like a boat slamming through, raise toward 1
        // to bring back the strict wave-conforming feel.
        const WATER_LONGITUDINAL_SPRING_MUL = 0.4
        // Per-corner buoyancy constants for submerged corners on water.
        const BUOYANCY_PER_M = 14
        const BUOYANCY_CAP = 20
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
          if (localDist > stats.hoverHeight * 1.6) continue
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
          // Damp only the EXCESS upward velocity beyond what a steady
          // climb of this slope requires. On flat ground tangentUpVel=0
          // and we get the legacy `Math.max(vAtPointUp, 0)` behaviour
          // (damps any lift-off). On a climb at v m/s along a tan(θ)
          // slope, vy must be v·tan(θ) just to stay on the surface;
          // treating that as "lifting off" makes the damp force
          // (~70 m/s² on a 25° hill at 18 m/s) overwhelm the spring's
          // lift and pins gd well below hoverHeight — the bike's
          // chassis ends up dragging on the trimesh.
          //
          // `sampleFwd*` is the bike's horizontal forward direction
          // (already computed for the surface probes); dotting linvel
          // into it gives the bike's signed horizontal forward speed,
          // and multiplying by `surfaceForwardSlope` (= tan θ) gives
          // the per-second up-rate needed to track the surface.
          const horizFwdSpeed =
            linvel.x * sampleFwdX + linvel.y * sampleFwdY + linvel.z * sampleFwdZ
          const tangentUpVel = probe.isWater
            ? 0
            : horizFwdSpeed * surfaceForwardSlope * SLOPE_DAMP_RELIEF
          const dampV = Math.max(vAtPointUp - tangentUpVel, 0)
          let aUp: number
          if (probe.isWater && localDist < 0) {
            // Submerged on water — capped buoyancy instead of the stiff
            // spring so a nose-dive actually goes under. Anti-grav can't
            // reach here (probe.isWater is false when probeField is null).
            const submersion = -localDist
            const aBuoy = Math.min(submersion * BUOYANCY_PER_M, BUOYANCY_CAP)
            aUp = GRAVITY + aBuoy - dampV * stats.hoverDamp
          } else {
            // heightError is unbounded on the positive side: a bow probe
            // looking ahead at a steep slope can read +5m or more, which
            // makes the spring fire at ~6-8 G's of corner lift and whip-
            // pitches the chassis into the sky on slope approaches. Clamp
            // it to one hoverHeight worth of authority. Past the cap we
            // still register "surface is above me" via the slope-momentum
            // path (which uses bow/stern projection differential, NOT this
            // height-error), so the bike still pitches up to climb — it
            // just doesn't get launched. Lower clamp stays loose; the
            // local-grounded gate above already culls corners with
            // localDist > hoverHeight*1.6, so the spring never needs to
            // push DOWN by more than ~0.7m of error.
            // Slope-aware ride height: when grounded over a sloped
            // surface (water exempt — wave dynamics handle their own
            // contour-following), target a higher hover so the chassis
            // stays well above the rising trimesh. Without it the
            // velocity-redirect prevented penetration but the visual
            // gap was tiny and read as "dragging".
            const slopeBoost = probe.isWater
              ? 0
              : Math.abs(surfaceForwardSlope) * SLOPE_HOVER_BOOST
            const effHover = stats.hoverHeight + slopeBoost
            const rawHeightError = effHover - localDist
            const heightError = Math.min(rawHeightError, MAX_BOW_LIFT_ERROR + slopeBoost)
            const springMul = probe.isWater && p.longitudinal ? WATER_LONGITUDINAL_SPRING_MUL : 1.0
            aUp = GRAVITY + heightError * stats.hoverSpring * springMul - dampV * stats.hoverDamp
          }
          if (debugOn) {
            const dc = debugCorners[pi]!
            dc.aUp = aUp
            dc.active = true
          }
          // Lift along +up at the probe point's world position. Replaces
          // the old `{x:0, y:F, z:0}` world-down lift.
          const impMag = aUp * POINT_MASS_FRAC * m * dt
          rb.applyImpulseAtPoint(
            { x: upX * impMag, y: upY * impMag, z: upZ * impMag },
            { x: t.x + p.ox, y: t.y + p.oy, z: t.z + p.oz },
            true,
          )
        }
      }
    }

    // Water pitch PD — self-righting torque while grounded on water.
    //
    // Stronger restoring force than the original linear damp so a held-
    // forward stick can't cartwheel the bike. P targets the surface's
    // pitch attitude (= −atan(surfaceForwardSlope)) so flat water reads
    // as "sit flat" and a big swell still lets the chassis tilt onto
    // the wave face. Band is narrowed to ±45° (was ±60°) so the rider
    // can pump waves but can't ride at extreme angles for free — past
    // 45° the player has to actively hold input to maintain the pose.
    if (isGrounded && probe.isWater) {
      const rightWater = quatRotate(rb.rotation(), { x: 1, y: 0, z: 0 })
      const angvWater = rb.angvel()
      const pitchVelWater =
        angvWater.x * rightWater.x + angvWater.y * rightWater.y + angvWater.z * rightWater.z
      const qW = rb.rotation()
      const r12W = 2 * (qW.y * qW.z - qW.x * qW.w)
      const pitchAngleWater = Math.asin(Math.max(-1, Math.min(1, -r12W)))
      const surfacePitchTarget = -Math.atan(surfaceForwardSlope)
      const pitchErrWater = pitchAngleWater - surfacePitchTarget
      const WATER_PITCH_P = 9 // rad/s² per rad of error (was 6)
      const WATER_PITCH_D = 3 // rad/s² per rad/s
      const inLevelBand = Math.abs(pitchErrWater) < (45 * Math.PI) / 180
      const aPitchP = inLevelBand ? -pitchErrWater * WATER_PITCH_P : 0
      const aPitchD = -pitchVelWater * WATER_PITCH_D
      const aPitchWater = aPitchP + aPitchD
      rb.applyTorqueImpulse(
        {
          x: rightWater.x * aPitchWater * m * dt,
          y: rightWater.y * aPitchWater * m * dt,
          z: rightWater.z * aPitchWater * m * dt,
        },
        true,
      )
    }

    HoverStateStore.set(eid, {
      groundDistance,
      isGrounded,
      surfaceIsWater: probe.hasSurface && probe.isWater,
      // inputPitch is deprecated since pitch is now physics-driven
      // (torque, not a stored bias). Kept at 0 for backwards compat.
      inputPitch: 0,
    })

    if (debugOn) {
      // Effective hover-height target — matches the slope-aware boost
      // applied per-corner inside the spring loop so the renderer's
      // target ring sits at the same height the spring is aiming for.
      const slopeBoostDbg = probe.isWater
        ? 0
        : Math.abs(surfaceForwardSlope) * SLOPE_HOVER_BOOST
      HoverDebugStore.set(eid, {
        upX,
        upY,
        upZ,
        dnX,
        dnY,
        dnZ,
        cx: t.x,
        cy: t.y,
        cz: t.z,
        centerHitX,
        centerHitY,
        centerHitZ,
        hasSurface: probe.hasSurface,
        isWater: probe.isWater,
        groundDistance,
        effHoverHeight: stats.hoverHeight + slopeBoostDbg,
        isGrounded,
        corners: debugCorners,
        surfaceForwardSlope,
        probeLift: devSettings.hoverProbeLift,
      })
    } else if (HoverDebugStore.has(eid)) {
      HoverDebugStore.delete(eid)
    }

    // Player pitch torque — applied around the bike's right axis.
    //
    // Sign: intent.pitch=+1 ("nose up") → torque around -rightAxis,
    // which rotates fwd toward +y. intent.pitch=-1 ("nose down / dive").
    //
    // Magnitude is a *torque coefficient*, not the angular acceleration
    // inline comments once claimed: it multiplies `mass * dt` to form
    // the torque impulse, so the effective angular acceleration is
    // `coef * mass / I_pitch`. For the capsule (I_pitch ≈ m·0.34)
    // that's roughly `coef × 2.94` rad/s² at full input.
    //
    // Per-surface + per-direction tuning:
    //
    //   - Land + forward stick (dive): disabled. Players intuit
    //     "push forward = drive forward"; the dive used to settle the
    //     chassis 15–30° nose-down which read as "scraping." On land
    //     the player has no reason to dive (no waves to crash through)
    //     so pitch-down input is just ignored. Wheelie-only on land.
    //   - Land + back stick (wheelie): 13. Up from 9 — players asked
    //     for noticeably-easier wheelies. The 75° BAD_GROUND_PITCH
    //     guard (above) still kills horizontal velocity if the chassis
    //     pitches past vertical, so committed wheelies have a hard
    //     ceiling.
    //   - Water (7): both directions. Riders need to crest waves and
    //     dive into troughs to pump speed, so neither direction is
    //     locked out. The water PD (above) restores within ±45° of the
    //     surface attitude with a stronger 9× P term, so holding fwd
    //     can't cartwheel the bike like it did at the 14× ground-torque
    //     baseline. Bumped from 5 to 7 so each push of the stick reads
    //     as a meaningful pitch nudge.
    //   - Air (1.8): 60% of the prior 3.0 (Δ requested in review). The
    //     prior value rotated through a full backflip in ~1.75s, which
    //     read as "spinny / loose" — air pitch felt twitchier than the
    //     rest of the bike. 1.8 stretches a full backflip to ~3s while
    //     still keeping fwd.y monotonic over the 1s m9-air-control
    //     sample window.
    if (Math.abs(intent.pitch) > 0.05) {
      const rightP = quatRotate(q, { x: 1, y: 0, z: 0 })
      let coef: number
      if (!isGrounded) {
        coef = 1.8
      } else if (probe.isWater) {
        coef = 7
      } else {
        // Land: disable forward dive entirely; allow nose-up wheelie.
        coef = intent.pitch > 0 ? 13 : 0
      }
      if (coef > 0) {
        const aPitch = -intent.pitch * coef
        rb.applyTorqueImpulse(
          {
            x: rightP.x * aPitch * m * dt,
            y: rightP.y * aPitch * m * dt,
            z: rightP.z * aPitch * m * dt,
          },
          true,
        )
      }
    }

    if (!isGrounded) {
      // --- Air control ---
      // Hang-time: counter ~60% of gravity so the bike floats through
      // arcs JetMoto-style instead of dropping like a brick. Effective
      // gravity in air ≈ 10 m/s² vs 25 on the ground — close to
      // real-world Earth pull, well below arcade ground gravity. In
      // anti-grav, lift is along the zone's up (matching the manual
      // gravity applied at end-of-loop, which is along −up).
      const AIR_LIFT_FRAC = 0.6
      const airLiftMag = GRAVITY * AIR_LIFT_FRAC * m * dt
      rb.applyImpulse(
        { x: upX * airLiftMag, y: upY * airLiftMag, z: upZ * airLiftMag },
        true,
      )

      // Pitch-vectored thrust: airborne thrust pushes along the bike's
      // true forward direction. The bike's visual nose orientation
      // matches its body +Z axis, so:
      //   Q (intent.pitch=-1) → fwd.y < 0 (nose visibly down) → thrust
      //     along fwd pushes the bike DOWN = dives.
      //   E (intent.pitch=+1) → fwd.y > 0 (nose visibly up) → thrust
      //     pushes the bike UP = extends air time.
      // The keyboard.ts comments ("Q = pitch up / jump off a wave")
      // describe the rider's body action ("lean back"), not the bike's
      // pitch — playtest is the source of truth here. Slightly weaker
      // than ground thrust so the player can't infinite-hover by aiming
      // up + boost; speedFalloff in 3D also caps any sustained climb at
      // topSpeed.
      const fwdAir = quatRotate(q, { x: 0, y: 0, z: 1 })
      if (Math.abs(intent.throttle) > 0) {
        const speed3d = Math.hypot(linvel.x, linvel.y, linvel.z)
        const dirAir = intent.throttle >= 0 ? 1 : -1
        const scaleAir = intent.throttle >= 0 ? 1 : stats.reverseScale
        const speedFalloff3d = Math.max(0, 1 - speed3d / stats.topSpeed)
        // Held-boost no longer reads `intent.boost` directly — the
        // boost-meter system gates the multiplier through `active`,
        // so the player only gets the bonus thrust while the meter
        // is engaged and draining.
        const meterActive = BoostMeterStore.get(eid)?.active === true
        const boostAir = (meterActive ? stats.boostMul : 1) * getCurrentBoostMultiplier(eid)
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
          {
            x: fwdAir.x * aAir * m * dt,
            y: fwdAir.y * aAir * m * dt,
            z: fwdAir.z * aAir * m * dt,
          },
          true,
        )
      }

      // Yaw around the "pure heading" axis: up with the bike-fwd
      // projection removed (then normalised). Perpendicular to bike-fwd
      // by construction, so steering in the air can't leak into roll
      // even when the bike is pitched up after a ramp. Plain world-Y
      // here would project onto bike-fwd whenever fwd.y ≠ 0 and roll
      // the bike sideways — the angvel strip at the top of the next
      // tick zeroes the roll velocity, but the rotation has already
      // integrated during phys.step. Pure-heading axis avoids the leak
      // entirely. In anti-grav we use the zone's up so yaw rotates around
      // the road normal, not world-Y.
      //
      // Reduced authority (×0.3) preserved for landing alignment.
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
      // branch's "free physics" approach, which left the bike stuck on
      // its side mid-jump. Low gain so steer-driven aerial banking still
      // works as a transient, but neutral is the attractor over ~2s.
      // Skipped past 60° of pitch so backflips/dives aren't fought.
      const r10A = 2 * (q.x * q.y + q.z * q.w)
      const r11A = 1 - 2 * (q.x * q.x + q.z * q.z)
      const r12A = 2 * (q.y * q.z - q.x * q.w)
      const pitchA = Math.asin(Math.max(-1, Math.min(1, -r12A)))
      if (Math.abs(pitchA) < Math.PI / 3) {
        const currentRollA = Math.atan2(r10A, r11A)
        const angvA = rb.angvel()
        const rollVelA = angvA.x * fwdAir.x + angvA.y * fwdAir.y + angvA.z * fwdAir.z
        const AIR_ROLL_P = 3
        const AIR_ROLL_D = 2
        const aRollAir = -currentRollA * AIR_ROLL_P - rollVelA * AIR_ROLL_D
        rb.applyTorqueImpulse(
          {
            x: fwdAir.x * aRollAir * m * dt,
            y: fwdAir.y * aRollAir * m * dt,
            z: fwdAir.z * aRollAir * m * dt,
          },
          true,
        )
      }

      continue
    }

    const fwd = quatRotate(q, { x: 0, y: 0, z: 1 })

    // Bike-fwd projected into the up-plane — the "horizontal" forward in
    // the bike's local frame. When up = Y this is just (fwd.x, 0, fwd.z),
    // matching the historic XZ horizontal forward used for thrust / brake
    // / drag. In anti-grav this stays in the road plane so thrust pushes
    // the bike along the road surface, not into / off it.
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

    // Velocity projected onto the up-plane (the "horizontal" velocity in
    // the bike's local frame). Used to compute the effective ground speed
    // for thrust / brake / drag / slope-momentum.
    const linvelUpG = linvel.x * upX + linvel.y * upY + linvel.z * upZ
    const vPlaneX = linvel.x - upX * linvelUpG
    const vPlaneY = linvel.y - upY * linvelUpG
    const vPlaneZ = linvel.z - upZ * linvelUpG
    const speed = Math.hypot(vPlaneX, vPlaneY, vPlaneZ)

    // Brake — opposes current up-plane velocity. Lets the AI (and the
    // player) actually slow down before a corner instead of relying solely
    // on letting off the throttle.
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

    // Forward thrust (water adds extra drag — slightly less responsive).
    // Applied along the up-plane forward so the bike accelerates along
    // the road plane, not world-horizontal.
    const throttle = intent.throttle
    const direction = throttle >= 0 ? 1 : -1
    const scale = throttle >= 0 ? 1 : stats.reverseScale
    const speedFalloff = Math.max(0, 1 - speed / stats.topSpeed)
    // Held-boost is gated by the boost-meter `active` flag — see the
    // air-thrust branch above for the same rule.
    const meterActive = BoostMeterStore.get(eid)?.active === true
    const heldBoost = meterActive ? stats.boostMul : 1
    const pickupBoost = getCurrentBoostMultiplier(eid)
    const boost = heldBoost * pickupBoost
    const surfaceMul = probe.isWater ? 0.85 : 1.0
    const aThrust =
      Math.abs(throttle) * stats.accel * scale * speedFalloff * boost * direction * surfaceMul
    rb.applyImpulse(
      {
        x: planeFwdX * aThrust * m * dt,
        y: planeFwdY * aThrust * m * dt,
        z: planeFwdZ * aThrust * m * dt,
      },
      true,
    )

    // Slope momentum — going down a wave is faster than climbing one.
    // The chassis tilts to track the surface (multi-probe alignment above);
    // we project gravity along the horizontal forward axis to get the
    // marble-on-incline behaviour: down-slope → accelerate; up-slope →
    // decelerate. The hover spring cancels gravity vertically, so without
    // this the chassis would pitch but coast at the same horizontal speed
    // regardless of wave face.
    //
    // Driven by `surfacePitchTarget` (the terrain-tracking pitch), NOT by
    // the chassis's current `fwd.y`. The chassis pitch also folds in the
    // player's Q/E input bias, so using `fwd.y` here would let the rider
    // pitch the nose down on flat ground and harvest free downhill thrust.
    // `surfacePitchTarget` is 0 when airborne and `followNow * -atan(slope)`
    // when grounded — exactly the contour signal the gravity projection
    // wants.
    //
    // Asymmetric coupling — motocross feel: a strong downhill push (1.0×
    // gravity) makes hitting a downslope read as the slingshot it is; the
    // uphill brake is just a whisper (0.15×) so the bike glides up SF-grade
    // streets and ramp faces instead of grinding to a crawl. On a 16°
    // downramp that's +6.9 m/s² of forward push (enough to easily exceed
    // topSpeed with momentum), while climbing the same slope costs only
    // -1.03 m/s² of drag — a featherweight tax the 19 m/s² thrust eats
    // through without slowing the bike below ~26 m/s at equilibrium.
    if (planeFwdLen > 0.01) {
      // Slope momentum reads the *surface* contour, not chassis pitch —
      // so the rider can't farm free downhill thrust by pitching the
      // nose forward. `-atan(surfaceForwardSlope)` matches the previous
      // `surfacePitchTarget` sign (negative on upslope, positive on down).
      // Applied along the up-plane forward so the marble-on-incline force
      // is in the road plane (not world horizontal).
      const aSlope = slopeMomentumAccel(-Math.atan(surfaceForwardSlope))
      rb.applyImpulse(
        {
          x: planeFwdX * aSlope * m * dt,
          y: planeFwdY * aSlope * m * dt,
          z: planeFwdZ * aSlope * m * dt,
        },
        true,
      )

      // Climb assist — arcade compensator for the gravity-along-slope
      // tax. Without help, a marble (or a physically honest hoverbike)
      // climbing a θ slope must produce m·g·tan(θ) of net forward thrust
      // just to maintain speed; on a 25° hill that's 11.7 m/s², which
      // saturates the bike's 19 m/s² accel curve at a steady-state
      // speed of only ~12 m/s. JetMoto / Wave-Race-style feel wants
      // climbs to read closer to flat-ground speed. Compensate
      // CLIMB_ASSIST_FRAC of the gravity tax as extra forward thrust;
      // the player still feels the climb (slower than flat, faster than
      // a marble), and the rest of the speed-falloff curve still
      // governs top-speed at any grade.
      //
      // Fires only on positive slopes (uphills). Downhill keeps its
      // full motocross slingshot via SLOPE_DOWN_GAIN, unchanged.
      // Skipped on water — wave-pump already handles wave-crest dynamics
      // and stacking climb-assist on top double-counts the rider's pump.
      if (surfaceForwardSlope > 0.05 && !probe.isWater) {
        const CLIMB_ASSIST_FRAC = 0.7
        const aClimb = surfaceForwardSlope * GRAVITY * CLIMB_ASSIST_FRAC
        rb.applyImpulse(
          {
            x: planeFwdX * aClimb * m * dt,
            y: planeFwdY * aClimb * m * dt,
            z: planeFwdZ * aClimb * m * dt,
          },
          true,
        )
      }

      // Slope velocity-redirect — the marble-on-slope effect that the
      // hover spring CAN'T deliver on a fast steep climb. When the bike
      // enters a 25° ramp at 23 m/s, the surface beneath rises at
      // 10.7 m/s vertical, but the spring can only generate ~24 m/s² of
      // net lift; the chassis falls behind, the capsule clips the ramp
      // trimesh, and the contact resolver reflects velocity off the
      // slope normal — costing ~50% of forward speed in 150 ms (measured
      // on the slope-test track). Below the hover band on a positive
      // surfaceForwardSlope, nudge the bike's velocity toward the slope
      // tangent so the chassis "rides" the slope instead of plowing
      // into it. Applied as an IMPULSE (not setLinvel) so the brake /
      // thrust / slope-brake forces applied earlier this tick aren't
      // overwritten.
      //
      // Anti-grav exempt — the up axis varies, slope semantics differ.
      // Water exempt — Wave-Race chop already has its own redirect path
      // (landing-momentum block below + spring softening on water).
      if (
        !agActive &&
        !probe.isWater &&
        surfaceForwardSlope > 0.05 &&
        groundDistance < stats.hoverHeight * 0.85 &&
        planeFwdLen > 0.01
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
          // Soft pull toward the tangent. RATE=10/s means a ~half-life
          // of ~70 ms — quick enough to clear a slope transition before
          // the capsule clips the trimesh, slow enough not to fight
          // intentional player inputs (Q/E pitch).
          const REDIRECT_RATE = 10
          const blend = Math.min(1, REDIRECT_RATE * dt)
          const dvx = (tangentVx - cur.x) * blend
          const dvy = (tangentVy - cur.y) * blend
          const dvz = (tangentVz - cur.z) * blend
          rb.applyImpulse({ x: dvx * m, y: dvy * m, z: dvz * m }, true)
        }
      }
    }

    // Landing momentum redirect — the motocross "hit the lip right" reward.
    // On the airborne→grounded transition, if the bike is descending onto a
    // downward-sloping surface, convert part of the vertical descent into
    // forward velocity along the slope direction. The hover spring would
    // otherwise eat the descent (its damp term kills upward velocity, but
    // the descending kinetic energy gets traded out for height-error work
    // — wasted as wobble). Redirecting before the spring does its thing
    // means a clean ramp landing reads as a slingshot exit, not a slap.
    //
    // Gated by all three of:
    //   - prev tick was airborne (one impulse per landing, not every tick)
    //   - descent rate is meaningful (|vy| > 2; trivial dips don't qualify)
    //   - surface ahead of the bike is sloping DOWN (slope < -0.1, i.e.
    //     >5.7° of downslope)
    // Plus an alignment factor that scales redirect strength with how
    // steep the down-slope actually is, so a 6° dip is a hint and a 30°
    // drop is a payoff.
    if (!prevGrounded && linvel.y < -2 && surfaceForwardSlope < -0.1 && planeFwdLen > 0.01) {
      const descend = -linvel.y // positive m/s
      const slopeAngle = Math.atan(-surfaceForwardSlope) // positive radians
      const REDIRECT_MAX = 0.7 // fraction of descent converted at full alignment
      const REDIRECT_SLOPE_FULL = Math.PI / 4 // 45° of downslope = full payoff
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

    // Yaw torque around the "pure heading" axis: up with the bike-fwd
    // projection removed (then normalised). Perpendicular to bike-fwd by
    // construction, so steering can't leak into roll regardless of pitch.
    // In anti-grav we substitute the zone's up so yaw rotates around the
    // road normal — turning on a wall pivots around the wall's outward
    // normal, exactly as MK8 anti-grav looks.
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

    // Fishtail bias — shifts the perceived yaw pivot forward of CoM so the
    // front "bites" and the rear sweeps out, Jet-Moto-style. Implementation:
    // add a lateral CoM acceleration timed with the yaw torque, magnitude
    // `α × pivotOffset`. Geometrically this makes the point YAW_PIVOT_FWD
    // metres ahead of CoM the instantaneous rotation centre instead of CoM
    // itself; the rear swings outward by `2 × YAW_PIVOT_FWD × ω`. Faded in
    // with speed so parking-lot wiggles don't slide the bike sideways —
    // fishtail is a high-speed feel.
    const YAW_PIVOT_FWD = 0.7 // metres forward of CoM
    const fishtailFade = Math.min(speed / 8, 1)
    if (fishtailFade > 0) {
      // Lateral push along the up-plane right axis so the rear sweeps out
      // *across* the road surface, not across world XZ. Reduces to the
      // historic behaviour when up = Y.
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

    // Roll PD controller — GROUND ONLY. The bike is corralled toward
    // `targetRoll = surfaceRoll + steer × leanLimit × speed-scale`, the
    // same target the prior kinematic block used. P pulls roll toward
    // target, D damps the rate. Unlike the kinematic snap, this is a
    // *physical* spring — the bike can be pushed off-target by jumps,
    // collisions, ramps; it just gets pulled back. Critical for keeping
    // racers from spinning out of control after a fishtail or a wave
    // strike (free roll without a restoring force runs away inside a
    // few hundred ms).
    //
    // The M9.x roll PD bug was caused by reading `bikeRight.y` as a
    // proxy for roll, which mis-fires under yaw-while-pitched. Here we
    // pull a true YXZ Euler roll out of the quaternion, so the signal
    // is clean across any yaw/pitch combination.
    //
    // In AIR: skipped. Pitch, roll, yaw are all free physics — backflips,
    // barrel rolls, whatever the player commits to with their inputs.
    //
    // In ANTI-GRAV: skipped. The roll target + currentRoll below are both
    // computed in world-Y frame; in anti-grav they fight the zone-up
    // alignment. The multi-point spring's port/starboard differential plus
    // the AG alignment torque (end of loop) handle roll there. Steer-lean
    // is sacrificed in anti-grav for the MVP — can revisit by retargeting
    // the PD around the up axis if it ends up feeling stiff in practice.
    if (agActive) {
      // No roll PD in anti-grav — drop through to lateral drag.
    } else {
    const ROLL_LEAN_LIMIT = (40 * Math.PI) / 180 // 40° at "normal" speed
    const LEAN_SPEED_FULL = 6 // m/s — base lean curve hits 1.0 here
    const LEAN_SPEED_HIGH = 24 // m/s — high-speed boost saturates here
    const LEAN_HIGH_SPEED_BOOST = 0.5 // up to 50% more lean at top speed → ~60°
    const LEAN_BASE = 0.4 // stationary lean = 40% of base limit (~16°)
    const speedFracR = Math.min(speed / LEAN_SPEED_FULL, 1)
    const baseLeanScale = LEAN_BASE + (1 - LEAN_BASE) * speedFracR
    const highSpeedFrac = Math.min(
      Math.max(speed - LEAN_SPEED_FULL, 0) / (LEAN_SPEED_HIGH - LEAN_SPEED_FULL),
      1,
    )
    const leanScale = baseLeanScale + highSpeedFrac * LEAN_HIGH_SPEED_BOOST
    // Surface roll component — multi-probe height differential across the
    // bike's width. Mirrors the prior kinematic `surfaceRollTarget` so the
    // bike banks into a wave normal when riding diagonally across chop.
    const surfaceRollTarget = Math.atan2(starboardProj - portProj, 2 * probeHalfWidth)
    const targetRoll = surfaceRollTarget + intent.steer * ROLL_LEAN_LIMIT * leanScale
    // Extract true YXZ roll from current rotation.
    const r10R = 2 * (q.x * q.y + q.z * q.w)
    const r11R = 1 - 2 * (q.x * q.x + q.z * q.z)
    const currentRoll = Math.atan2(r10R, r11R)
    const fwdR = quatRotate(q, { x: 0, y: 0, z: 1 })
    // Roll angular velocity = angvel · bikeFwd.
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

    // (Pitch on the ground stays pure physics: player input torque +
    // multi-point hover handles surface alignment + flat-ground restoration.
    // Roll is corralled by the PD above to keep racers from spinning out.
    // Yaw torque + fishtail bias does the steering. Attitude in air is
    // fully free physics.)

    // Lateral drag — water has *more* lateral resistance (skis don't slide
    // sideways easily). In anti-grav we measure "lateral" along the
    // up-plane right axis so the drag opposes sideways drift *across the
    // road*, not across world XZ. Reduces to the historic behaviour when
    // up = Y.
    const dragMul = probe.isWater ? 1.4 : 1.0
    const lateralVel =
      linvel.x * planeRightX + linvel.y * planeRightY + linvel.z * planeRightZ
    const aDrag = -lateralVel * stats.lateralDrag * dragMul
    rb.applyImpulse(
      {
        x: planeRightX * aDrag * m * dt,
        y: planeRightY * aDrag * m * dt,
        z: planeRightZ * aDrag * m * dt,
      },
      true,
    )

    // ── Anti-grav corrections ────────────────────────────────────────────
    //
    // While `agActive`, this bike's Rapier per-body gravity scale is 0
    // (set by `antiGravSystem`). Replace that with a manual gravity along
    // −up so the bike falls toward the zone's road plane. All other forces
    // (probe rays, spring lift, yaw, drag, thrust) are already retargeted
    // onto the up axis above, so on a vertical wall the spring lifts away
    // from the wall while gravity pulls into it — the bike sticks.
    //
    // The spring's port/starboard differential (now in up-plane coords)
    // produces the bulk of the alignment torque automatically. The extra
    // PD here is just a transition aid — it speeds up rotation toward the
    // new up during zone enter/exit (when bike +Y is far from zone up).
    // Low gain so it doesn't overshoot the spring's equilibrium.
    if (agActive) {
      rb.applyImpulse(
        {
          x: -upX * GRAVITY * m * dt,
          y: -upY * GRAVITY * m * dt,
          z: -upZ * GRAVITY * m * dt,
        },
        true,
      )

      // PD alignment: bring the bike's local +Y onto up.
      // cross(bikeUp, up) is the rotation-axis × sin(angle) — the
      // standard restoring torque direction for "align A to B". Damped by
      // angular velocity. Reduced gain (20 vs 60) now that the spring
      // also aligns; this just smooths the transition.
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
  }
}
