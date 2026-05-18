// Components: bitECS tags for query membership, plus per-component Stores for data.
// Tags are unique object refs; data lives in the matching Store keyed by eid.

import type { Intent } from '@/engine/input/intent'
import { createStore } from '@/engine/sim/ecs/store'

// --- Tags (no data) ---
export const PlayerTag = { name: 'PlayerTag' as const }
export const BikeTag = { name: 'BikeTag' as const }

// --- PeerControlled: a bike whose ControlIntent comes from a network peer
// (or from the local input on slot 0). Distinct from PlayerTag so render /
// HUD / camera code can still ask "which bike is the LOCAL human's?" via
// PlayerTag while the sim layer dispatches inputs per peer slot. M10.5.
export const PeerControlled = { name: 'PeerControlled' as const }
export type PeerControlledData = {
  /** Network peer slot 0..MAX_PEERS_PER_ROOM-1. Slot 0 is the local peer
   *  in single-player; in multiplayer it's the room host. */
  peerId: number
}
export const PeerControlledStore = createStore<PeerControlledData>('PeerControlled')

// --- Data components: tag + store pair ---

export const Transform = { name: 'Transform' as const }
export type TransformData = {
  x: number
  y: number
  z: number
  qx: number
  qy: number
  qz: number
  qw: number
}
export const TransformStore = createStore<TransformData>('Transform')

export const RBHandle = { name: 'RBHandle' as const }
export type RBHandleData = { handle: number }
export const RBHandleStore = createStore<RBHandleData>('RBHandle')

export const BikeStats = { name: 'BikeStats' as const }
export type BikeStatsData = {
  hoverHeight: number
  hoverSpring: number
  hoverDamp: number
  accel: number
  topSpeed: number
  turnTorque: number
  lateralDrag: number
  reverseScale: number
  boostMul: number
  mass: number
  /**
   * How much the bike conforms to the wave/ground slope (0 = skates flat
   * regardless of surface, 1 = perfectly perpendicular). Tunable per bike
   * for feel: a heavy hover-cruiser plows through chop with low
   * surfaceFollow (~0.3); a light agile bike rides every ripple at ~0.7.
   */
  surfaceFollow: number
  /**
   * Render hint: the body color the bike mesh should use when no per-variant
   * GLB exists, or as a runtime tint of the GLB's livery material. Sim
   * layer ignores this field.
   */
  bodyColor?: number
  /**
   * Render hint: the variant id (matches `specs/bikes/<id>.json`). The bike
   * render system uses this to pick which loaded GLB to clone for this
   * entity. Sim layer ignores this field.
   */
  variantId?: string
}
export const BikeStatsStore = createStore<BikeStatsData>('BikeStats')

export const ControlIntent = { name: 'ControlIntent' as const }
export type ControlIntentData = Intent
export const ControlIntentStore = createStore<ControlIntentData>('ControlIntent')

export const HoverState = { name: 'HoverState' as const }
export type HoverStateData = {
  groundDistance: number
  isGrounded: boolean
  /** True if the surface under the bike is the wave field, false if it's a
   *  hard collider. Used by the render-side FX to route between foam-puff
   *  emission (water) and spark/dust emission (land). Defaults to `false`
   *  when there is no surface (airborne). */
  surfaceIsWater: boolean
  /** Smoothed player-input pitch bias (radians). Tracked separately from the
   *  surface-alignment pitch so the bike can follow the wave field at a fast
   *  rate (visible on all bikes, AI included) while the player's input bias
   *  decays slowly when the stick is released — preserves the "bike retains
   *  its attitude after a wave-jump" feel without damping wave tracking. */
  inputPitch: number
}
export const HoverStateStore = createStore<HoverStateData>('HoverState')

/**
 * Per-bike anti-gravity override. Written by `antiGravSystem` every tick
 * to record which way is "up" for this bike when an anti-grav source is
 * within reach — either a flagged AI spline (curve sampling, with
 * distance falloff) or a containing volume zone.
 *
 * The hover system reads `up*` to retarget its probes / lift / yaw axis,
 * and reads `weight` to scale the gravity blend. The smoothed up vector
 * lerps over a short half-life to absorb instantaneous jumps when a new
 * source takes over.
 */
export const AntiGravOverride = { name: 'AntiGravOverride' as const }
export type AntiGravOverrideData = {
  /** True while the bike is influenced by any anti-grav source (curve
   *  sample with non-zero weight OR contained in a zone OR mid-transition
   *  back to world-up). */
  active: boolean
  /** Blend weight ∈ [0,1]. 0 = fully world gravity, 1 = fully curve/zone
   *  gravity. Used by the hover system to set per-body Rapier gravity
   *  scale and to size the manual gravity impulse so the bike's effective
   *  gravity transitions smoothly across enter / exit / drift boundaries. */
  weight: number
  /** Current "up" unit vector (smoothed). Defaults to (0,1,0). */
  upX: number
  upY: number
  upZ: number
  /** Target up vector — set every tick from the active source. */
  targetUpX: number
  targetUpY: number
  targetUpZ: number
}
export const AntiGravOverrideStore = createStore<AntiGravOverrideData>('AntiGravOverride')
