/**
 * Hover system — orchestrator + PUBLIC FACADE.
 *
 * The 2.3k-LOC god-file this used to be is now split along the seams its own
 * `HoverFrame` / `Footprint` bundles already implied (docs/systems-review.md
 * §4):
 *   - hover-types.ts      — `HoverFrame` / `Footprint` / `SurfaceProbe` shapes
 *   - hover-tuning.ts     — every feel constant (deduped; see §5)
 *   - hover-probe.ts      — ray / footprint sampling + the `scratchRay` reuse
 *   - hover-spring.ts     — multi-point spring + buoyancy + bad-landing checks
 *   - hover-attitude.ts   — grounded pitch PD + player pitch torque + air roll
 *   - hover-drive.ts      — the ground branch + slope/drift/drag + AG corrections
 *
 * This module keeps `hoverSystem` (the per-bike orchestration loop), the small
 * orchestration-local helpers (`advanceDiveTimers`, `resolveCornerGrounded`,
 * the HoverState / HoverDebug writes), and — crucially — RE-EXPORTS every
 * symbol that was previously imported from `@/game/systems/hover`, so NO
 * importer path changes (tests + render fx pull `slopeMomentumAccel`,
 * `driftYawFraction`, `tuckFactor` / `slopeAwareSweetSpot`,
 * `applyPlayerPitchTorque`, `resolveWaterLongitudinalSpringMul`, the feel
 * constants, the `HoverFrame` type, …).
 *
 * Three-free; probe geometry flows in via `SimTuning` (not the `devSettings`
 * singleton — §1.2).
 */

import { query } from 'bitecs'
import { isHoverDebugEnabled } from '@/engine/sim/debug-flags'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { SurfaceType, type SurfaceTypeValue } from '@/engine/sim/surface-types'
import { spawnSplashRing } from '@/engine/sim/water/splash-rings'
import { sampleSurface, type WaveFieldState } from '@/engine/sim/water/wave-field'
import {
  BikeStats,
  BikeStatsStore,
  BikeTag,
  ControlIntent,
  ControlIntentStore,
  HoverDebugStore,
  type HoverProbe,
  HoverState,
  HoverStateStore,
  RBHandle,
  RBHandleStore,
} from '@/game/components'
import type { SimTuning } from '@/game/sim-step'
import {
  applyAirControlBranch,
  applyGroundedPitchPD,
  applyPlayerPitchTorque,
} from './hover-attitude'
import { applyAntiGravCorrections, applyGroundBranch } from './hover-drive'
import {
  buildHoverFrame,
  makeDebugCorners,
  probeSurface,
  sampleSurfaceFootprint,
} from './hover-probe'
import { applyBadLandingChecks, applyMultiPointHoverSpring } from './hover-spring'
import {
  GROUNDED_DISTANCE_MUL,
  MAX_HOVER_PROBE,
  MIN_DIVE_FOR_RELEASE_S,
  NOSE_REGROUND_FRAC,
  RELEASE_KICK_DURATION_S,
  SLOPE_HOVER_BOOST,
} from './hover-tuning'
import { emptyFootprint, type Footprint, type HoverFrame, type SurfaceProbe } from './hover-types'

// ============================================================================
// Public facade — re-export every symbol other modules import from here so no
// importer path changes after the split (docs/systems-review.md §4).
// ============================================================================

export {
  applyAirControlBranch,
  applyGroundedPitchPD,
  applyPlayerPitchTorque,
} from './hover-attitude'
export {
  applyAntiGravCorrections,
  applyGroundBranch,
  driftYawFraction,
  slopeMomentumAccel,
} from './hover-drive'
export {
  buildHoverFrame,
  makeDebugCorners,
  probeSurface,
  sampleSurfaceFootprint,
} from './hover-probe'
export {
  applyBadLandingChecks,
  applyMultiPointHoverSpring,
  resolveWaterLongitudinalSpringMul,
} from './hover-spring'
// Feel constants + pure helpers (slope-momentum test, hover-debug overlay,
// render fx, bike-variants test, dive-clamp test, drift-yaw test, …).
export {
  DIVE_HOVER_HEIGHT_MIN_MUL,
  DIVE_KICK_DURATION_S,
  DIVE_KICK_TORQUE_MUL,
  DIVE_PITCH_FWD_LIMIT_DEG,
  DRIFT_LATERAL_DRAG_SCALE,
  DRIFT_STEER_FRAC,
  DRIFT_YAW_BIAS_FRAC,
  DRIFT_YAW_SPEED_REF,
  INWARD_INITIAL_BIAS_MUL,
  INWARD_INITIAL_WINDOW_S,
  INWARD_TAIL_BIAS_MUL,
  MAX_BOW_LIFT_ERROR,
  MIN_DIVE_FOR_RELEASE_S,
  RELEASE_KICK_DURATION_S,
  RELEASE_KICK_TORQUE_MUL,
  SLOPE_DAMP_RELIEF,
  SLOPE_DOWN_GAIN,
  SLOPE_HOVER_BOOST,
  SLOPE_UP_BRAKE,
  // Re-exported tuck-curve leaf (call sites import them from here).
  slopeAwareSweetSpot,
  TUCK_SCRAPE_FLOOR,
  TUCK_SWEET_SPOT,
  tuckFactor,
  WATER_SURFACE_FOLLOW,
} from './hover-tuning'
export { emptyFootprint } from './hover-types'
export type { Footprint, HoverFrame, SurfaceProbe }

// ============================================================================
// Orchestration-local helpers
// ============================================================================

/** Per-end grounded test with hysteresis (see `NOSE_REGROUND_FRAC`). A
 *  currently-grounded end stays grounded until its local distance exceeds
 *  the full cutoff; a currently-airborne end re-grounds only once it drops
 *  back below the lowered threshold. Pure + exported so the hysteresis can
 *  be unit-pinned without a Rapier world. */
export function resolveCornerGrounded(
  localDist: number,
  cutoff: number,
  prevGrounded: boolean,
): boolean {
  const threshold = prevGrounded ? cutoff : cutoff * NOSE_REGROUND_FRAC
  return localDist < threshold
}

/** Result of advancing the per-tick dive / release-kick state machine. */
export type DiveTimers = { diveHoldS: number; releaseKickS: number }

/**
 * Advance the dive-hold + release-kick timers for one tick. Pure (no ECS, no
 * physics) so the press → dive → release → kick sequence can be unit-pinned.
 *
 * `diveHoldS` ticks UP while the player holds nose-down input (`pitch <=
 * -0.05`, matching the deadzone in `applyPlayerPitchTorque`) and resets to 0
 * on release; it feeds the player-torque dive-kick taper so the rider gets one
 * initial nose-dive transient per press, after which the grounded pitch PD
 * restores the chassis and sustained input reads as altitude control.
 *
 * `releaseKickS` counts DOWN from `RELEASE_KICK_DURATION_S` when the player
 * releases a sustained dive (one that lasted at least `MIN_DIVE_FOR_RELEASE_S`),
 * driving a brief nose-up torque so the bow leads the altitude recovery. It is
 * skipped for releases from shorter-than-threshold taps and re-pressing
 * pitch-down cancels it mid-window.
 */
export function advanceDiveTimers(
  intentPitch: number,
  dt: number,
  prevDiveHoldS: number,
  prevReleaseKickS: number,
): DiveTimers {
  const isDiving = intentPitch <= -0.05
  const diveHoldS = isDiving ? prevDiveHoldS + dt : 0
  let releaseKickS: number
  if (isDiving) {
    releaseKickS = 0
  } else if (prevDiveHoldS >= MIN_DIVE_FOR_RELEASE_S && prevReleaseKickS === 0) {
    releaseKickS = RELEASE_KICK_DURATION_S
  } else if (prevReleaseKickS > 0) {
    releaseKickS = Math.max(0, prevReleaseKickS - dt)
  } else {
    releaseKickS = 0
  }
  return { diveHoldS, releaseKickS }
}

function writeHoverState(
  eid: number,
  groundDistance: number,
  isGrounded: boolean,
  noseGrounded: boolean,
  baseGrounded: boolean,
  isWater: boolean,
  surfaceType: SurfaceTypeValue,
  surfaceForwardSlope: number,
  diveHoldS: number,
  releaseKickS: number,
): void {
  HoverStateStore.set(eid, {
    groundDistance,
    isGrounded,
    noseGrounded,
    baseGrounded,
    surfaceIsWater: isWater,
    // Surface material under the bike — DEFAULT while airborne (no
    // surface contact), the probed type while grounded. Render + drift
    // both read it.
    surfaceType: isGrounded ? surfaceType : SurfaceType.DEFAULT,
    // Reset filtered slope to 0 while airborne so the next landing
    // seeds the filter from zero.
    forwardSlope: isGrounded ? surfaceForwardSlope : 0,
    diveHoldS,
    releaseKickS,
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
  probeLift: number,
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
    probeLift,
  })
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
 *
 * `tuning` carries the sim-affecting dev knobs (probe geometry) snapshotted
 * once per tick by `simulateStep` — never read the `devSettings` singleton
 * here (§1.2).
 */
export function hoverSystem(
  sim: SimWorld,
  phys: PhysicsWorld,
  field: WaveFieldState | null,
  tuning: SimTuning,
): void {
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
    const isGrounded =
      probe.hasSurface && groundDistance < stats.hoverHeight * GROUNDED_DISTANCE_MUL

    // Wave vertical velocity under the bike — fed into the hover damp so the
    // spring rides the wave's motion (up and over crests) instead of damping
    // against it and being overtaken. Zero off water / in anti-grav.
    frame.waterSurfaceVy =
      probe.isWater && probeField ? sampleSurface(probeField, frame.t.x, frame.t.z).vy : 0

    // Prior tick's state — drives the slope filter seed, the takeoff/
    // landing transitions, the dive-kick / release-kick taper, and
    // the rendered hover-target ring.
    const prevHover = HoverStateStore.get(eid)
    const prevGrounded = prevHover?.isGrounded ?? false

    // P4.1 splash rings: a hard water landing radiates a ring wave other
    // riders see AND feel (the pool lives on the field; the water mesh
    // mirrors it per tick). Impact speed is measured relative to the
    // surface's own vertical motion so riding down a swell face doesn't
    // read as an impact. Fixed-step sim event → deterministic.
    if (probeField && probe.isWater && isGrounded && !prevGrounded) {
      const impact = Math.max(0, -(frame.linvel.y - frame.waterSurfaceVy))
      spawnSplashRing(probeField, frame.t.x, frame.t.z, impact)
    }
    const prevForwardSlope = prevHover?.forwardSlope ?? 0
    const prevDiveHoldS = prevHover?.diveHoldS ?? 0
    const prevReleaseKickS = prevHover?.releaseKickS ?? 0
    // Dive-hold + release-kick timers (pure state machine).
    const { diveHoldS, releaseKickS } = advanceDiveTimers(
      frame.intent.pitch,
      frame.dt,
      prevDiveHoldS,
      prevReleaseKickS,
    )

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
    const footprint: Footprint = isGrounded
      ? sampleSurfaceFootprint(
          frame,
          phys,
          probe,
          probeField,
          debugOn,
          debugCorners,
          prevForwardSlope,
          tuning,
        )
      : emptyFootprint()

    // Per-end (nose / base) contact for the trick system. Reuse the
    // spring's force-arm geometry (physical bow/stern, not the speed-
    // anticipated sample reach) projected on up, minus the surface sample
    // at that end. Only meaningful while the center is grounded; airborne
    // reads both ends as off the surface. Hysteresis (resolveCornerGrounded)
    // debounces chattery trimesh edges so the nose-up pop arms cleanly.
    let noseGrounded = false
    let baseGrounded = false
    if (isGrounded) {
      const fhl = tuning.hoverProbeHalfLength
      const ax = footprint.forceFwdX * fhl
      const ay = footprint.forceFwdY * fhl
      const az = footprint.forceFwdZ * fhl
      const { upX, upY, upZ, t } = frame
      const bowProbeProj = (t.x + ax) * upX + (t.y + ay) * upY + (t.z + az) * upZ
      const sternProbeProj = (t.x - ax) * upX + (t.y - ay) * upY + (t.z - az) * upZ
      const cutoff = stats.hoverHeight * GROUNDED_DISTANCE_MUL
      noseGrounded = resolveCornerGrounded(
        bowProbeProj - footprint.bowProj,
        cutoff,
        prevHover?.noseGrounded ?? true,
      )
      baseGrounded = resolveCornerGrounded(
        sternProbeProj - footprint.sternProj,
        cutoff,
        prevHover?.baseGrounded ?? true,
      )
    }

    // Bad-landing / bad-attitude velocity-kill (rider-crash trigger).
    applyBadLandingChecks(frame, probe, footprint.surfaceForwardSlopeRaw, prevGrounded, isGrounded)

    // Multi-point hover spring (or underwater buoyancy on water).
    if (probe.hasSurface && isGrounded) {
      applyMultiPointHoverSpring(
        frame,
        footprint,
        probe,
        groundDistance,
        debugOn,
        debugCorners,
        tuning,
      )
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
      noseGrounded,
      baseGrounded,
      probe.hasSurface && probe.isWater,
      probe.surfaceType,
      footprint.surfaceForwardSlope,
      diveHoldS,
      releaseKickS,
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
        tuning.hoverProbeLift,
      )
    } else if (HoverDebugStore.has(eid)) {
      HoverDebugStore.delete(eid)
    }

    // Player pitch torque — fires in BOTH air and ground branches with
    // different coefficients. `isOverWater` extends the dive clamp to
    // airborne flights over water (kills wave-pop forward flips).
    // `diveHoldS` / `releaseKickS` drive the dive-kick and release-kick
    // tapers — see applyPlayerPitchTorque.
    applyPlayerPitchTorque(
      frame,
      isGrounded,
      isOverWater,
      footprint.surfaceForwardSlope,
      diveHoldS,
      releaseKickS,
    )

    if (!isGrounded) {
      applyAirControlBranch(frame)
      continue
    }

    applyGroundBranch(frame, footprint, probe, prevGrounded, groundDistance, probeField)
    if (frame.agActive) applyAntiGravCorrections(frame)
  }
}
