// Components: bitECS tags for query membership, plus per-component Stores for data.
// Tags are unique object refs; data lives in the matching Store keyed by eid.

import type { Intent } from '@/engine/input/intent'
import { createStore } from '@/engine/sim/ecs/store'

// --- Tags (no data) ---
export const PlayerTag = { name: 'PlayerTag' as const }
export const BikeTag = { name: 'BikeTag' as const }
// Ghost bike — render-only entity driven by a replay player each frame.
// Has BikeTag + Transform + BikeStats (for variant lookup) but no
// RigidBody, ControlIntent, HoverState, PickupSlot, AITag, Racer, or
// PeerControlled. Sim systems gate on those so a ghost participates in
// nothing. Render system reads GhostTag to swap in a transparent
// material.
export const GhostTag = { name: 'GhostTag' as const }

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
 * Per-bike hover-debug snapshot — written by `hoverSystem` only when the
 * global debug flag is on (see `setHoverDebugEnabled` in
 * `engine/sim/debug-flags.ts`). Skipped in normal play so the hot loop
 * stays allocation-free.
 *
 * Each corner probe captures the ray origin, the hit point (hx = NEG_INF
 * when no surface), whether the locally-grounded gate accepted the
 * corner, and the up-axis spring acceleration applied at the point.
 * Order is fixed: 0=bow, 1=stern, 2=starboard, 3=port.
 */
export type HoverProbe = {
  ox: number
  oy: number
  oz: number
  hx: number
  hy: number
  hz: number
  active: boolean
  aUp: number
}
export const HoverDebug = { name: 'HoverDebug' as const }
export type HoverDebugData = {
  upX: number
  upY: number
  upZ: number
  dnX: number
  dnY: number
  dnZ: number
  cx: number
  cy: number
  cz: number
  centerHitX: number
  centerHitY: number
  centerHitZ: number
  hasSurface: boolean
  isWater: boolean
  groundDistance: number
  effHoverHeight: number
  isGrounded: boolean
  corners: HoverProbe[]
  surfaceForwardSlope: number
  /** Snapshot of the probe-lift distance used this tick (read live
   *  from devSettings). The renderer needs this to place force arrows
   *  at the bike's footprint when the user drags the slider. */
  probeLift: number
}
export const HoverDebugStore = createStore<HoverDebugData>('HoverDebug')

/**
 * Per-bike MK8-style hop-trick state. Written by `trickHopSystem` on
 * rising-edge of intent.trickLeft / intent.trickRight; render-side reads
 * `spinPhase` + `spinDirection` to overlay a Y-axis visual rotation on
 * the bike mesh while the trick plays out.
 *
 *  - `cooldownSec` is decremented each tick; new hops are gated on it
 *    reaching 0. Prevents button-mash spam from chaining ghost-hops
 *    every frame while the bike is still in the air from the last one.
 *  - `spinPhase` lerps 1 → 0 over `spinDurationSec`; render multiplies
 *    `spinDirection * (1 - spinPhase) * 2π` onto the bike's quaternion
 *    for the in-air twist, then resets to 0 at end.
 *  - `armedForBoost` is set when the hop fired during a valid apex
 *    approach (vy rising / just-crested). Consumed on landing by the
 *    trick observer, which emits the boost reward then.
 *  - `wasGrounded` is the previous-tick grounded state for landing
 *    detection. Replaces the per-fx-system lastGrounded map for the
 *    boost path; the FX system keeps its own (for splash bursts).
 *  - `prevLeftDown` / `prevRightDown` are the per-tick edge-detect
 *    bookkeeping. Set by trickHopSystem from intent each tick.
 */
export const TrickState = { name: 'TrickState' as const }
export type TrickStateData = {
  cooldownSec: number
  spinPhase: number
  /** Rotation axis as a signed unit vector. Only one component is
   *  ever non-zero per spin (Y = yaw, X = flip, Z = roll). The sign
   *  encodes direction so render multiplies a single quaternion
   *  without a separate magnitude field. */
  spinAxisX: number
  spinAxisY: number
  spinAxisZ: number
  spinDurationSec: number
  prevLeftDown: boolean
  prevRightDown: boolean
  /** Recent vy peak (m/s) — mirrors the observer's tracker so the
   *  sim can decide hop magnitude (big on credible apex, small on
   *  flatground) without a cross-thread query. */
  vyPeak: number
  /** Sim-ticks since `vyPeak` was last refreshed. Resets the peak
   *  once it goes stale so an old climb can't keep arming the big
   *  hop a second later. */
  vyPeakTicksAgo: number
  /** When true, vy-peak updates are suppressed because the bike's
   *  vertical velocity is being driven by its own hop impulse rather
   *  than a surface climb. Set the moment a hop fires; cleared when
   *  the bike completes the airborne arc and lands again (or a
   *  safety timeout expires). Mirrored to the observer via the
   *  WavePumpSample so both peak trackers stay in lockstep. */
  hopLockoutActive: boolean
  /** Tracks whether the bike has been airborne since the last hop —
   *  used to detect the "airborne → grounded" landing transition
   *  that ends the lockout. */
  hopLockoutAirborneSeen: boolean
  /** Safety timeout (sim ticks). If the airborne→grounded transition
   *  never fires (weird kinematic state, anti-grav weirdness, etc.)
   *  the lockout ends after this many ticks regardless. */
  hopLockoutSafetyTicks: number
}
export const TrickStateStore = createStore<TrickStateData>('TrickState')

/**
 * Per-bike Burnout-3-style boost meter. Filled by successful tricks
 * (see `wave-pump-observer` + the trick-event handler in `game-loop`),
 * consumed by holding the boost button. While `active`, the hover
 * system applies `stats.boostMul` to forward thrust and the render
 * side runs sustained camera shake plus the trick-FX activation
 * one-shot. Drains at `BOOST_DRAIN_PER_SEC` per second; auto-ends
 * when charge runs out or the button releases.
 */
export const BoostMeter = { name: 'BoostMeter' as const }
export type BoostMeterData = {
  charge: number
  active: boolean
  /** Previous-tick `intent.boost` for rising-edge detection. Held-
   *  down does not auto-re-engage after a drain-empty — the player
   *  has to release and re-press once the meter has charged enough. */
  prevBoostDown: boolean
}
export const BoostMeterStore = createStore<BoostMeterData>('BoostMeter')

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
