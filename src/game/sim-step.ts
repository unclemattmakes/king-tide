import type { Intent } from '@/engine/input/intent'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { advanceWaveField, type WaveFieldState } from '@/engine/sim/water/wave-field'
import type { Track } from '@/game/tracks/types'
import { aiCombatSystem } from './systems/ai-combat'
import { aiControlSystem } from './systems/ai-control'
import {
  explosionTickSystem,
  mineSystem,
  missileSystem,
  shieldTickSystem,
  stunOverrideSystem,
  stunTickSystem,
} from './systems/combat'
import { hoverSystem } from './systems/hover'
import { applyPeerInputs, EMPTY_PEER_INPUTS } from './systems/input-apply'
import { boostTickSystem, pickupSystem, pickupUseSystem } from './systems/pickup'
import { rubberBandSystem } from './systems/rubber-band'
import { syncFromPhysics } from './systems/sync-from-physics'
import { wakeUpdateSystem } from './systems/wake-update'

export type RaceTick = (sim: SimWorld, phys: PhysicsWorld, dt: number) => void

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
  wakeUpdateSystem(sim, phys, waveField)

  if (inputs.locked) {
    applyPeerInputs(sim, EMPTY_PEER_INPUTS)
  } else if (!inputs.autoPlay) {
    applyPeerInputs(sim, inputs.peerInputs)
  }
  const runAI = inputs.runAI ?? true
  if (!inputs.locked && runAI) aiControlSystem(sim, phys, track)
  if (runAI) aiCombatSystem(sim, phys)
  stunOverrideSystem(sim)

  hoverSystem(sim, phys, waveField)
  phys.step()
  syncFromPhysics(sim, phys)

  if (!inputs.locked) raceTick(sim, phys, phys.fixedDt)
  pickupSystem(sim, phys, phys.fixedDt)
  pickupUseSystem(sim, phys)
  mineSystem(sim, phys, phys.fixedDt)
  missileSystem(sim, phys, phys.fixedDt)
  explosionTickSystem(sim, phys.fixedDt)
  boostTickSystem(sim, phys.fixedDt)
  shieldTickSystem(sim, phys.fixedDt)
  stunTickSystem(sim, phys.fixedDt)
  if (runAI) rubberBandSystem(sim, track)
}
