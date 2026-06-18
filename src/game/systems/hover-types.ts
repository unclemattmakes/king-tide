/**
 * Per-tick state bundles passed between the hover phases.
 *
 * Split out of `hover.ts` (docs/systems-review.md §4) so the probe / spring /
 * attitude / drive modules can share the `HoverFrame`, `Footprint`, and
 * `SurfaceProbe` shapes without a circular dependency on the orchestrator.
 * Three-free, physics-free types only.
 */

import type RAPIER from '@dimforge/rapier3d-compat'
import type { SurfaceTypeValue } from '@/engine/sim/surface-types'
import type { BikeStatsData, ControlIntentData } from '@/game/components'

/**
 * Surface probe result. `surfaceProj` is the hit's projection onto the up
 * axis — equals world-Y when up=(0,1,0), the natural distance-along-up in
 * anti-grav zones. `hasSurface=false` means no ground hit and no reachable
 * water (e.g. bike floating in the void).
 *
 * `surfaceType` is the material tag of whatever the center probe is riding:
 * WATER when the wave field wins, otherwise the hit collider's registered
 * type (DEFAULT when untagged). Drives the lateral-grip multiplier in the
 * ground branch + the `HoverState.surfaceType` render read.
 */
export type SurfaceProbe = {
  surfaceProj: number
  isWater: boolean
  hasSurface: boolean
  surfaceType: SurfaceTypeValue
}

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
export type HoverFrame = {
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
  /** Wave vertical velocity (∂y/∂t) at the bike centre. Fed into the hover
   *  damp so the spring tracks the wave's motion instead of fighting it (the
   *  bike rides up and over crests). 0 off water / in anti-grav. Set in
   *  `hoverSystem` right after the centre probe. */
  waterSurfaceVy: number
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
export type Footprint = {
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
export function emptyFootprint(): Footprint {
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
