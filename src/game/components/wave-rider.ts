/**
 * WaveRider — props that sit on the wave surface and react to impacts.
 *
 * Strategy: kinematic-position Rapier body whose pose is driven each
 * fixed step by sampling the analytic wave field at the body's XZ, then
 * layering a spring-damped perturbation that gets kicked on contact.
 * Rapier never solves buoyancy for us — we already have a closed-form
 * wave function, so the kinematic body just tracks it.
 *
 * Generalises to any wave-riding prop: buoys, debris, mines, light
 * markers. Differences live entirely in `WaveRiderTuning` constants.
 */

import { createStore } from '@/engine/sim/ecs/store'
import type { WaveRiderDof } from '@/game/tracks/types'

export const WaveRiderTag = { name: 'WaveRiderTag' as const }

/** Authored archetypes — picks a tuning preset + a render archetype.
 *  Add new entries here when adding new wave-riding prop kinds. */
export type WaveRiderArchetypeId = 'buoy' | 'log'

/** Live tuning for one wave-rider. Springs are linear, integrated by
 *  symplectic Euler at the fixed sim dt. */
export type WaveRiderTuning = {
  /** Meters above the local water surface where the body's centre sits
   *  at rest. Tune so the visual half-submerges as authored. */
  floatOffsetY: number
  /** 0..1 — how much of the wave-surface normal tilt the body inherits.
   *  Small buoys ≈ 1 (lock to surface), wide rafts < 1 (resist tilting). */
  normalFollow: number
  /** Vertical spring stiffness (1/s²) and damping (1/s). */
  springK: number
  springDamping: number
  /** Tilt spring (axis-angle small-angle linearisation). */
  tiltK: number
  tiltDamping: number
  /** Constant yaw drift, rad/s. Sells "this isn't a static prop" without
   *  reading as spin. */
  yawDriftRate: number
}

export type WaveRiderState = {
  /** Archetype preset this rider was spawned from (`buoy`/`log`). Absent
   *  for per-instance floats, which carry an auto-derived `tuning` and
   *  render from their own GLB instead of the primitive fallback. */
  archetype?: WaveRiderArchetypeId
  tuning: WaveRiderTuning
  /** Spring-damped vertical offset on top of restY. */
  perturbY: number
  perturbYVel: number
  /** Tilt perturbation stored as the horizontal direction the prop's
   *  local +Y axis is currently leaning toward. Length = tilt angle in
   *  radians (small-angle). */
  tiltDirX: number
  tiltDirZ: number
  tiltVelX: number
  tiltVelZ: number
  /** Accumulated drift yaw (radians). */
  yawDrift: number
  /** XZ anchor — wave-riders bob in place; horizontal pos is fixed at
   *  spawn. Stored so the system doesn't have to read the body each
   *  tick before computing the desired pose. */
  anchorX: number
  anchorZ: number
}

export const WaveRiderStore = createStore<WaveRiderState>('WaveRider')

export const WAVE_RIDER_TUNING: Record<WaveRiderArchetypeId, WaveRiderTuning> = {
  buoy: {
    floatOffsetY: 0.35,
    normalFollow: 0.6,
    springK: 36,
    springDamping: 3.8,
    tiltK: 20,
    tiltDamping: 2.4,
    yawDriftRate: 0.06,
  },
  log: {
    floatOffsetY: 0.12,
    normalFollow: 0.9,
    springK: 22,
    springDamping: 4.6,
    tiltK: 11,
    tiltDamping: 2.0,
    yawDriftRate: -0.18,
  },
}

/** Characteristic size (m) the auto-tuning is normalised against — a
 *  small marker buoy. At this size {@link deriveWaveRiderTuning}
 *  reproduces the hand-tuned `buoy` preset; larger props scale toward a
 *  slower, heavier bob that resists tilting. */
const REF_SIZE = 0.45

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Derive a wave-rider tuning preset from a prop's own collider extents,
 * so ANY asset can float without a hand-authored archetype (the
 * per-instance "float on waves" path). Bigger props bob slower (lower
 * spring frequency) and follow the wave normal less — a wide hull
 * shouldn't tip like a cork. `restOffsetY` is the rest height above the
 * mean surface (authored `position.y` − wave-field `baseY`), so a floated
 * prop sits where it was placed. `dof` gates yaw: `'locked'` holds the
 * authored heading; `'yaw'` adds a gentle drift.
 *
 * Damping targets a lightly-underdamped ratio so a knock reads as a few
 * visible bobs before settling. These are starting points — tune by eye
 * in the `?waveriders=1` scene / on a real water track.
 */
export function deriveWaveRiderTuning(opts: {
  halfHeight: number
  footprint: number
  restOffsetY: number
  dof: WaveRiderDof
}): WaveRiderTuning {
  const charSize = Math.max(REF_SIZE * 0.5, opts.halfHeight, opts.footprint)
  const sizeScale = REF_SIZE / charSize // 1 at buoy size, < 1 for big props
  const springK = clamp(36 * sizeScale, 4, 40)
  const tiltK = clamp(20 * sizeScale, 3, 24)
  const normalFollow = clamp(0.6 * (REF_SIZE / Math.max(REF_SIZE, opts.footprint)), 0.15, 0.95)
  return {
    floatOffsetY: opts.restOffsetY,
    normalFollow,
    springK,
    springDamping: 2 * 0.32 * Math.sqrt(springK),
    tiltK,
    tiltDamping: 2 * 0.27 * Math.sqrt(tiltK),
    yawDriftRate: opts.dof === 'yaw' ? 0.05 : 0,
  }
}
