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
   * Per-bike multiplier on the bow/stern (longitudinal) hover spring over
   * WATER. Low values plough through chop; high values follow every wave
   * crest. Ground unaffected. Tuning band: ~0.4 = heavy boat, "ploughs"
   * (Scout); 0.85 = attentive default (Racer); ~1.0+ = wave-conforming
   * jet ski (Stunt, Sparrow). The roll-axis (port/starboard) spring keeps
   * full stiffness so steering bank is unaffected by this stat.
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
  /** Low-pass-filtered bow→stern surface slope (dy/dx along bike-fwd).
   *  Drives slope-momentum, climb-assist, slope-aware hover-height boost,
   *  and the grounded pitch-PD target. Filtered with a short time constant
   *  so a single-tick spike from a lumpy trimesh doesn't translate to a
   *  one-frame thrust/torque kick. Reset to 0 while airborne. */
  forwardSlope: number
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
 * Per-bike airborne-gated trick state. Written by `trickHopSystem`
 * each fixed tick; render-side reads `spinPhase` + `spinAxis*` to
 * overlay the in-air rotation on the bike mesh, and reads
 * `trickFiredThisTick` to drive HUD/audio/FX on the firing frame.
 *
 *  - `cooldownSec` gates back-to-back small flatground hops only.
 *    Credible tricks dedup via `trickFiredThisAirborne` instead, so
 *    one airborne arc fires at most one boost regardless of presses.
 *  - `spinPhase` lerps 1 → 0 over `spinDurationSec`; render rotates
 *    around `(spinAxisX, spinAxisY, spinAxisZ)` by `(1 - spinPhase) * 2π`.
 *  - `prevLeftDown` / `prevRightDown` are the per-tick edge-detect
 *    bookkeeping for the trick buttons.
 *  - `trickWindowOpen` / `trickWindowTakeoffVy` are the headline new
 *    fields under the airborne-gated model: the window opens on a
 *    qualifying grounded→airborne transition and stays open the
 *    whole airtime. Press anytime in the window = trick.
 *  - `bufferedPressTimerSec` / `bufferedPressDir` implement the
 *    MK-style early-press forgiveness (200 ms grace before takeoff).
 *  - `trickFiredThisTick` is the one-shot edge consumed by the render
 *    hook the same frame it's set; cleared the next sim tick.
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
   *  than a surface climb. Set the moment a (small) hop fires; cleared
   *  when the bike completes the airborne arc and lands again (or a
   *  safety timeout expires). Also gates the airborne trick window so
   *  a self-induced hop never opens a "free trick" off flat ground. */
  hopLockoutActive: boolean
  /** Tracks whether the bike has been airborne since the last hop —
   *  used to detect the "airborne → grounded" landing transition
   *  that ends the lockout. */
  hopLockoutAirborneSeen: boolean
  /** Safety timeout (sim ticks). If the airborne→grounded transition
   *  never fires (weird kinematic state, anti-grav weirdness, etc.)
   *  the lockout ends after this many ticks regardless. */
  hopLockoutSafetyTicks: number

  // ── Airborne trick window (MK-style "in the air = trickable") ─────
  /** True for the duration of an airborne arc whose takeoff qualified
   *  (surface-driven, ≥ minVyPeak, ≥ minSpeedFrac, ≥ minThrottle).
   *  Opens on the qualifying grounded→airborne transition; closes
   *  silently on the next airborne→grounded transition. */
  trickWindowOpen: boolean
  /** World-Y velocity (m/s) sampled at the moment the trick window
   *  opened. Drives the boost-reward strength so a stronger takeoff
   *  pays a bigger reward — preserves the wave-mastery reward
   *  hierarchy under the simpler airborne-gated model. */
  trickWindowTakeoffVy: number
  /** Dedup flag — set when a trick fires inside the current window,
   *  cleared on the airborne→grounded landing. Prevents long aerials
   *  (anti-grav launches, big ramps) from banking multiple boosts off
   *  the same takeoff. */
  trickFiredThisAirborne: boolean
  /** Previous tick's grounded state — used to detect takeoff/landing
   *  transitions inside `trickHopSystem` without needing a shared
   *  observer. */
  wasGroundedLastTick: boolean

  // ── Pre-input buffer (Layer 1 "early press" forgiveness) ──────────
  /** Seconds remaining on a buffered press. A press while grounded
   *  with a qualifying-climb context is held for up to
   *  `PRE_PRESS_BUFFER_SEC`; if a qualifying takeoff lands inside
   *  the window, the buffered press fires the trick at takeoff. */
  bufferedPressTimerSec: number
  /** Direction the player pressed when the buffer was armed: -1 left,
   *  +1 right, 0 none. Captured at press time, not consumed time, so
   *  the spin direction reflects the player's actual intent. */
  bufferedPressDir: number

  // ── One-shot trick-fire flag (sim → render in same frame) ─────────
  /** Set by `trickHopSystem` on the tick a credible trick fires
   *  (either an in-air press or a buffered-press-at-takeoff). Consumed
   *  + cleared by the game-loop render hook the same frame; never
   *  spans multiple ticks. */
  trickFiredThisTick: boolean
  /** Strength of the fired trick (0..1), derived from takeoff vy.
   *  Only valid while `trickFiredThisTick` is true. */
  trickFiredStrength: number
  /** Direction of the fired trick: -1 left, +1 right. Used by the
   *  render-side spin code as the fallback when neither pitch nor
   *  steer is committed. */
  trickFiredDirection: number
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
