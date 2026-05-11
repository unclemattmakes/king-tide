import { emptyIntent } from '@/engine/input'
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
import { applyPlayerIntent } from './systems/input-apply'
import { boostTickSystem, pickupSystem, pickupUseSystem } from './systems/pickup'
import { rubberBandSystem } from './systems/rubber-band'
import { syncFromPhysics } from './systems/sync-from-physics'
import { wakeUpdateSystem } from './systems/wake-update'

export type RaceTick = (sim: SimWorld, phys: PhysicsWorld, dt: number) => void

export type StepInputs = {
  /** Player 0 control intent for this tick. */
  playerIntent: Intent
  /** True during pre-race countdown — suppresses controls and the race timer. */
  locked: boolean
  /** True when the player bike is being driven by AI (test mode). */
  autoPlay: boolean
  /** Multiplier on fixed-step wave-field advancement. 1 in normal play;
   *  scrubbed by the water debug menu in single-player. Lockstep multiplayer
   *  pins this to 1 so peers agree on the surface. */
  waveTimeScale: number
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
    applyPlayerIntent(sim, emptyIntent())
  } else if (!inputs.autoPlay) {
    applyPlayerIntent(sim, inputs.playerIntent)
  }
  if (!inputs.locked) aiControlSystem(sim, phys, track)
  aiCombatSystem(sim, phys)
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
  rubberBandSystem(sim, track)
}
