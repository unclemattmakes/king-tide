import { query } from 'bitecs'
import { DEFAULT_DEV_SETTINGS, devSettings } from '@/engine/dev-settings'
import type { Intent } from '@/engine/input/intent'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { advanceWaveField, type WaveFieldState } from '@/engine/sim/water/wave-field'
import type { Track } from '@/game/tracks/types'
import { BikeTag, RBHandle, RBHandleStore } from './components'
import { aiCombatSystem } from './systems/ai-combat'
import { aiControlSystem } from './systems/ai-control'
import { antiGravSystem } from './systems/anti-grav'
import { boostMeterSystem } from './systems/boost-meter'
import { boostPadSystem } from './systems/boost-pad'
import {
  explosionTickSystem,
  mineSystem,
  missileSystem,
  shieldTickSystem,
  stunOverrideSystem,
  stunTickSystem,
} from './systems/combat'
import { driftSystem } from './systems/drift'
import { hoverSystem } from './systems/hover'
import { applyPeerInputs, EMPTY_PEER_INPUTS } from './systems/input-apply'
import { launchGradeSystem } from './systems/launch-grade'
import { type OobConfig, outOfBoundsSystem } from './systems/out-of-bounds'
import { boostTickSystem, pickupSystem, pickupUseSystem } from './systems/pickup'
import { riderCrashSystem } from './systems/rider-crash'
import { riderPoseSystem } from './systems/rider-pose'
import { rubberBandSystem } from './systems/rubber-band'
import { syncFromPhysics } from './systems/sync-from-physics'
import { trickHopSystem } from './systems/trick-hop'
import { wakeUpdateSystem } from './systems/wake-update'
import type { WaveRiderSystem } from './systems/wave-rider'

export type RaceTick = (sim: SimWorld, phys: PhysicsWorld, dt: number) => void

/**
 * The sim-affecting dev-tunable knobs, snapshotted into world-step input so
 * they can't leak from the mutable `devSettings` singleton straight into the
 * deterministic sim path (docs/systems-review.md §1.2).
 *
 * `hover.ts` used to read `devSettings.hoverProbe*` every tick and
 * `input-apply.ts` read `devSettings.steerReleaseTightness` — a silent
 * multiplayer-desync source (one peer's localStorage tuning would diverge the
 * sim). These four probe knobs + the steer-release knob are the ONLY
 * `devSettings` fields the deterministic step consumed; they now flow in via
 * `StepInputs.tuning`.
 *
 * Single-player passes `simTuningFromDevSettings()` so the dev sliders still
 * tune feel live; multiplayer passes `defaultSimTuning()` (frozen) so peers
 * agree — mirroring how `waveTimeScale` / `runAI` already distinguish SP vs MP.
 */
export type SimTuning = {
  /** Bow/stern probe distance from the bike center along the up-plane
   *  forward axis (metres). The actual probe extends by speed anticipation
   *  (see `hoverProbeSpeedScale`). */
  hoverProbeHalfLength: number
  /** Port/starboard probe distance from the bike center (metres). */
  hoverProbeHalfWidth: number
  /** Origin lift along +up before each corner cast (metres). */
  hoverProbeLift: number
  /** Bow/stern probe speed anticipation, metres added per m/s of up-plane
   *  speed (capped at 1.4 m extension inside the probe). */
  hoverProbeSpeedScale: number
  /** Steer release tightness 0..1 — how quickly steer collapses to zero
   *  after the stick is released. Read by `input-apply.ts`. */
  steerReleaseTightness: number
}

/** The shipped defaults — used by multiplayer (frozen, peer-agreed) and as
 *  the fallback when a caller omits `StepInputs.tuning`. */
export function defaultSimTuning(): SimTuning {
  return {
    hoverProbeHalfLength: DEFAULT_DEV_SETTINGS.hoverProbeHalfLength,
    hoverProbeHalfWidth: DEFAULT_DEV_SETTINGS.hoverProbeHalfWidth,
    hoverProbeLift: DEFAULT_DEV_SETTINGS.hoverProbeLift,
    hoverProbeSpeedScale: DEFAULT_DEV_SETTINGS.hoverProbeSpeedScale,
    steerReleaseTightness: DEFAULT_DEV_SETTINGS.steerReleaseTightness,
  }
}

/** Snapshot the live `devSettings` singleton into a `SimTuning`. Single-player
 *  call sites use this so the dev palette / F4 hover-debug sliders still tune
 *  feel live without the sim reading the mutable singleton mid-tick. */
export function simTuningFromDevSettings(): SimTuning {
  return {
    hoverProbeHalfLength: devSettings.hoverProbeHalfLength,
    hoverProbeHalfWidth: devSettings.hoverProbeHalfWidth,
    hoverProbeLift: devSettings.hoverProbeLift,
    hoverProbeSpeedScale: devSettings.hoverProbeSpeedScale,
    steerReleaseTightness: devSettings.steerReleaseTightness,
  }
}

/** While the race is locked (pre-countdown + countdown), keep bikes
 *  glued to their spawn pose. Input was already zeroed at the start
 *  of simulateStep, but bikes hovering on wave surfaces still drift
 *  laterally as the gerstner wave field flows beneath them, and any
 *  residual impulse from previous frames bleeds into x/z motion.
 *  Zeroing linvel.xz + angvel each tick keeps the lock visually honest
 *  while preserving the y component so hoverSystem's PID still holds
 *  the bike at altitude (no fall + bounce on unlock). */
function freezeLockedBikes(sim: SimWorld, phys: PhysicsWorld): void {
  const eids = query(sim, [BikeTag, RBHandle])
  for (const eid of eids) {
    const { handle } = RBHandleStore.must(eid)
    const rb = phys.world.getRigidBody(handle)
    if (!rb) continue
    const v = rb.linvel()
    rb.setLinvel({ x: 0, y: v.y, z: 0 }, true)
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
  }
}

export type StepInputs = {
  /** Per-peer control intents for this tick, keyed by peer slot. Bikes
   *  tagged `PeerControlled { peerId }` look themselves up in this map;
   *  any peer slot with no entry receives an empty intent (handles
   *  packet loss / late-joining peers gracefully). In single-player the
   *  caller passes `Map { 0 → localIntent }`. */
  peerInputs: ReadonlyMap<number, Intent>
  /** True during pre-race countdown — suppresses controls and the race timer. */
  locked: boolean
  /** True when the player bike is being driven by AI (test mode). */
  autoPlay: boolean
  /** Multiplier on fixed-step wave-field advancement. 1 in normal play;
   *  scrubbed by the water debug menu in single-player. Lockstep multiplayer
   *  pins this to 1 so peers agree on the surface. */
  waveTimeScale: number
  /** M10.11 — run AI control / combat / rubber-band this tick. Default
   *  true. Non-host multiplayer peers pass `false`: the host owns the AI
   *  sim and broadcasts AI bike transforms; on non-hosts the AI bikes are
   *  kinematic and pose-driven by `applySnapshot`, with no AITag, so the
   *  systems' tag-gated queries are already empty — this flag is belt-
   *  and-suspenders against future non-tag dependencies, and saves the
   *  no-op query traversal each tick. */
  runAI?: boolean
  /** Mario-Kart rubber-band assist toggle, snapshotted out of the mutable
   *  `playerSettings` singleton so it can't leak into the deterministic step
   *  (ADR 0002 / sim-purity guard). Single-player reads the live
   *  `playerSettings.rubberBandAssist` OUTSIDE the step; multiplayer/lockstep
   *  passes a frozen default so peers agree — mirroring how `runAI` /
   *  `tuning` already distinguish SP vs MP. Defaults to `true` (the shipped
   *  `DEFAULT_PLAYER_SETTINGS.rubberBandAssist`) when a caller omits it. */
  rubberBandAssist?: boolean
  /** Optional wave-rider system. Tracks with no wave-rider props omit
   *  it; passing `undefined` is a no-op. Stepped right after the wave
   *  field advances so kinematic bodies track the new surface within
   *  the same tick. */
  waveRiders?: WaveRiderSystem
  /** Out-of-bounds leash config for the local player. Omitted (or
   *  `enabled:false`) in modes that opt out — multiplayer, tutorial, attract.
   *  When present the boundary system runs after the race tick each step. */
  oob?: OobConfig
  /** Sim-affecting dev-tunable knobs (probe geometry + steer release),
   *  snapshotted out of the mutable `devSettings` singleton so they can't
   *  leak into the deterministic step (docs/systems-review.md §1.2). Single-
   *  player passes `simTuningFromDevSettings()` (live sliders); multiplayer
   *  passes `defaultSimTuning()` (frozen, peer-agreed). Omitting it falls
   *  back to `defaultSimTuning()`. */
  tuning?: SimTuning
}

/**
 * One fixed-step tick of the simulation. Pure with respect to (sim, phys,
 * waveField, track, inputs) — no Math.random, no wall clock, no Three.js,
 * and (since §1.2) no live `devSettings` read: the sim-affecting tuning
 * knobs arrive via `inputs.tuning` so two peers with different localStorage
 * tuning still step identically. This is the entry point that multiplayer
 * netcode (lockstep or rollback) will drive on every peer.
 *
 * Order is load-bearing — wake-update must run before hoverSystem reads
 * the wave field (so trailing bikes feel the leader's wake, M9.26), and
 * stunOverride must run after intent/AI so spun-out bikes can't drive
 * through their own hit reaction.
 */
export function simulateStep(
  sim: SimWorld,
  phys: PhysicsWorld,
  waveField: WaveFieldState,
  track: Track,
  raceTick: RaceTick,
  inputs: StepInputs,
): void {
  advanceWaveField(waveField, phys.fixedDt * inputs.waveTimeScale)
  // Wave-rider props ride this tick's freshly-advanced surface. Step
  // before any bike system reads from physics — the next phys.step()
  // commits the kinematic pose, so bikes that collide with a buoy
  // this tick feel the post-step location, not the previous one.
  inputs.waveRiders?.step(phys.fixedDt)
  wakeUpdateSystem(sim, phys, waveField)

  // Snapshot tuning out of the mutable singleton ONCE per tick. Default-frozen
  // when a (non-owned) caller omits it.
  const tuning = inputs.tuning ?? defaultSimTuning()

  if (inputs.locked) {
    applyPeerInputs(sim, EMPTY_PEER_INPUTS, phys.fixedDt, tuning)
  } else if (!inputs.autoPlay) {
    applyPeerInputs(sim, inputs.peerInputs, phys.fixedDt, tuning)
  }
  const runAI = inputs.runAI ?? true
  if (!inputs.locked && runAI) aiControlSystem(sim, phys, track, waveField)
  if (runAI) aiCombatSystem(sim, phys)
  stunOverrideSystem(sim)

  // Anti-grav resolution runs immediately before hover so the hover system
  // sees this tick's fresh up-vector override + gravity-scale state.
  antiGravSystem(sim, phys, track, phys.fixedDt)
  hoverSystem(sim, phys, waveField, tuning)
  // Trick-hop runs immediately after hoverSystem so the fresh
  // `HoverState.isGrounded` from this tick gates the rising-edge press.
  // Applying the vertical impulse here (before `phys.step()` below)
  // means the bike's lift integrates this tick rather than next.
  trickHopSystem(sim, phys)
  // Launch/landing grade — right after trick-hop so it reads the same
  // fresh HoverState edges, and before boostMeterSystem so a landing
  // reward integrates into the meter this same tick.
  launchGradeSystem(sim, phys)
  // Drift state machine — runs after trick-hop so the small-hop
  // (drift initiator's visible tell) has already fired its impulse,
  // and reads the same fresh `HoverState.isGrounded`. Doesn't apply
  // its own torques; `hoverSystem` next tick reads `DriftState` for
  // ground-branch yaw + lateral-drag modulation.
  driftSystem(sim, phys)
  // Boost meter — manages activate/drain/release. Must run before
  // hover reads `BoostMeter.active`, hence before any next-frame
  // hover pass; placement here also lets the same-tick rising-edge
  // press take effect on this tick's hover thrust.
  boostMeterSystem(sim, phys)
  // Rider pose runs just before the physics step — applies PD torque
  // impulses to drive the active ragdoll toward its target stance. Must
  // run after hoverSystem (which writes bike pose) so the pelvis-to-bike
  // pose driver sees the bike's final orientation for this tick.
  riderPoseSystem(sim, phys, phys.fixedDt)
  phys.step()
  if (inputs.locked) freezeLockedBikes(sim, phys)
  syncFromPhysics(sim, phys)

  // Rider crash detection runs after syncFromPhysics so it can compare
  // the post-step bike velocity against the previous tick's velocity.
  // Triggering on Δv catches wall hits, mine blasts, and bike-on-bike
  // sideswipes without needing collision-event subscription.
  riderCrashSystem(sim, phys, phys.fixedDt)

  if (!inputs.locked) raceTick(sim, phys, phys.fixedDt)
  // Out-of-bounds leash — after the race tick so it sees this tick's finished
  // state and never yanks a just-finished player. Player-only, deterministic.
  if (inputs.oob) outOfBoundsSystem(sim, phys, track, phys.fixedDt, inputs.oob)
  pickupSystem(sim, phys, phys.fixedDt)
  pickupUseSystem(sim, phys)
  mineSystem(sim, phys, phys.fixedDt)
  missileSystem(sim, phys, phys.fixedDt)
  explosionTickSystem(sim, phys.fixedDt)
  boostPadSystem(sim, phys, track)
  boostTickSystem(sim, phys.fixedDt)
  shieldTickSystem(sim, phys.fixedDt)
  stunTickSystem(sim, phys.fixedDt)
  if (runAI) rubberBandSystem(sim, track, inputs.rubberBandAssist ?? true)
}
