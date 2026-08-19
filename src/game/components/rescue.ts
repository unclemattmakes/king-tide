/**
 * Stuck-rescue state — the auto-respawn safety net's per-player state
 * (see systems/stuck-rescue.ts).
 *
 * Side-table only (no ECS tag): the system queries on existing player
 * components and lazily seeds this store, mirroring LaunchGradeStore.
 *
 * `requestedThisTick` is the established one-shot sim→loop edge
 * (out-of-bounds `lethalTriggeredThisTick` pattern): the sim decides a
 * rescue is due; the render frame consumes + clears the flag and runs
 * the actual (physics-teleporting) respawn.
 */

import { createStore } from '@/engine/sim/ecs/store'

export type RescueReason = 'wedge' | 'eject'

export type RescueStateData = {
  /** Seconds the bike has been "wedged": grounded, throttle held, and
   *  barely moving. Resets the moment any condition breaks. */
  stuckSec: number
  /** One-shot: the sim wants the loop to respawn this bike now. */
  requestedThisTick: boolean
  /** Why the rescue fired — wedged against terrain, or the rider has
   *  been ragdolled off for too long. Valid while requested. */
  reason: RescueReason
}

export const RescueStateStore = createStore<RescueStateData>('RescueState')
