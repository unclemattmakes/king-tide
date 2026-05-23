import type { Intent } from '@/engine/input/intent'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { advanceWaveField, type WaveFieldState } from '@/engine/sim/water/wave-field'
import type { Track } from '@/game/tracks/types'
import { aiCombatSystem } from './systems/ai-combat'
import { aiControlSystem } from './systems/ai-control'
import { antiGravSystem } from './systems/anti-grav'
import { boostPadSystem } from './systems/boost-pad'
import {
  explosionTickSystem,
  mineSystem,
  missileSystem,
  shieldTickSystem,
  stunOverrideSystem,
  stunTickSystem,
} from './systems/combat'
import { boostMeterSystem } from './systems/boost-meter'
import { hoverSystem } from './systems/hover'
import { trickHopSystem } from './systems/trick-hop'
import { applyPeerInputs, EMPTY_PEER_INPUTS } from './systems/input-apply'
import { boostTickSystem, pickupSystem, pickupUseSystem } from './systems/pickup'
import { riderCrashSystem } from './systems/rider-crash'
import { riderPoseSystem } from './systems/rider-pose'
import { rubberBandSystem } from './systems/rubber-band'
import { syncFromPhysics } from './systems/sync-from-physics'
import { wakeUpdateSystem } from './systems/wake-update'
import type { WaveRiderSystem } from './systems/wave-rider'
import { query } from 'bitecs'
import { BikeTag, RBHandle, RBHandleStore } from './components'

export type RaceTick = (sim: SimWorld, phys: PhysicsWorld, dt: number) => void

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
  /** Optional wave-rider system. Tracks with no wave-rider props omit
   *  it; passing `undefined` is a no-op. Stepped right after the wave
   *  field advances so kinematic bodies track the new surface within
   *  the same tick. */
  waveRiders?: WaveRiderSystem
}

/**
 * One fixed-step tick of the simulation. Pure with respect to (sim, phys,
 * waveField, track, inputs) — no Math.random, no wall clock, no Three.js.
 * This is the entry point that multiplayer netcode (lockstep or rollback)
 * will drive on every peer.
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

  if (inputs.locked) {
    applyPeerInputs(sim, EMPTY_PEER_INPUTS, phys.fixedDt)
  } else if (!inputs.autoPlay) {
    applyPeerInputs(sim, inputs.peerInputs, phys.fixedDt)
  }
  const runAI = inputs.runAI ?? true
  if (!inputs.locked && runAI) aiControlSystem(sim, phys, track, waveField)
  if (runAI) aiCombatSystem(sim, phys)
  stunOverrideSystem(sim)

  // Anti-grav resolution runs immediately before hover so the hover system
  // sees this tick's fresh up-vector override + gravity-scale state.
  antiGravSystem(sim, phys, track, phys.fixedDt)
  hoverSystem(sim, phys, waveField)
  // Trick-hop runs immediately after hoverSystem so the fresh
  // `HoverState.isGrounded` from this tick gates the rising-edge press.
  // Applying the vertical impulse here (before `phys.step()` below)
  // means the bike's lift integrates this tick rather than next.
  trickHopSystem(sim, phys)
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
  pickupSystem(sim, phys, phys.fixedDt)
  pickupUseSystem(sim, phys)
  mineSystem(sim, phys, phys.fixedDt)
  missileSystem(sim, phys, phys.fixedDt)
  explosionTickSystem(sim, phys.fixedDt)
  boostPadSystem(sim, phys, track)
  boostTickSystem(sim, phys.fixedDt)
  shieldTickSystem(sim, phys.fixedDt)
  stunTickSystem(sim, phys.fixedDt)
  if (runAI) rubberBandSystem(sim, track)
}
