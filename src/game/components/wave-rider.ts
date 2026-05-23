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
  archetype: WaveRiderArchetypeId
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
