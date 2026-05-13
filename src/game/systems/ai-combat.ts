import { type QueryResult, query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate } from '@/engine/sim/physics/vec'
import {
  BikeTag,
  ControlIntent,
  ControlIntentStore,
  RBHandle,
  RBHandleStore,
} from '@/game/components'
import { AITag } from '@/game/components/ai'
import { PickupSlot, PickupSlotStore, type PickupType } from '@/game/components/pickup'
import { pickMissileTarget } from '@/game/systems/combat'

/**
 * Decide whether an AI should fire its currently-held pickup, and if so,
 * set ControlIntent.fire = true so the existing pickupUseSystem consumes
 * it. Runs AFTER aiControlSystem (which writes a fresh intent each tick
 * with fire=false), and BEFORE pickupUseSystem.
 *
 * Heuristic per pickup type — kept intentionally simple, tuned for "AI
 * feels threatening" rather than optimal play:
 *
 * - boost: fire when we're on a relatively straight section (throttle
 *   stayed above 0.85, i.e. ai-control didn't scale us down for a sharp
 *   turn). Wasting boost mid-corner is a tell that the AI is dumb.
 * - shield: fire whenever held — it's purely defensive and lasts 6s, so
 *   sitting on it doesn't help. A smarter AI could time it to incoming
 *   missiles, but that's polish, not MVP.
 * - mine: fire when a non-self bike is within 12m AND behind us (dot of
 *   our forward and the direction-to-them is < -0.4), OR when we're
 *   working through a moderate-to-sharp turn (|steer| > 0.4) — dropping
 *   on a corner apex tends to catch trailing bikes that follow the
 *   racing line.
 * - missile: fire when pickMissileTarget returns a valid target (i.e.
 *   there's a bike inside our forward cone within 80m) AND we're going
 *   relatively straight (throttle > 0.8), so the launch direction
 *   actually heads toward the target.
 */
export const MINE_CHASER_RANGE = 12 // meters
export const MINE_CHASER_DOT = -0.4 // dot(fwd, dirToBike) less than this = "behind"

/**
 * Pure decision function — given the AI's situation, should they fire
 * the held pickup right now? Extracted from aiCombatSystem so it can be
 * unit-tested without spinning up a Rapier world. The thresholds are the
 * same exported constants the wrapper uses.
 */
export function shouldAIFire(
  held: PickupType,
  throttle: number,
  steerAbs: number,
  hasChaser: boolean,
  hasMissileTarget: boolean,
): boolean {
  switch (held) {
    case 'boost':
      // Don't burn boost while ai-control has scaled us down for a turn.
      return throttle > 0.85
    case 'shield':
      // Purely defensive; sitting on it can't help. Fire whenever held.
      return true
    case 'mine':
      // Drop on a chaser, or on a corner apex (catches trailing bikes
      // that follow the racing line).
      return hasChaser || steerAbs > 0.4
    case 'missile':
      // Need a target inside the forward cone, AND a launch heading
      // pointing roughly the right way (i.e. not mid-corner).
      return throttle > 0.8 && hasMissileTarget
  }
}

export function aiCombatSystem(sim: SimWorld, phys: PhysicsWorld): void {
  const eids = query(sim, [AITag, BikeTag, ControlIntent, PickupSlot, RBHandle])
  // Cache the bike list once per tick; isChaserBehind and pickMissileTarget
  // would otherwise re-run the same ECS query for every AI.
  const bikeEids = query(sim, [BikeTag, RBHandle])
  for (const eid of eids) {
    const slot = PickupSlotStore.must(eid)
    if (!slot.held) continue

    const intent = ControlIntentStore.must(eid)
    if (intent.fire) continue // someone (or something) already wants us to fire

    const hasChaser = slot.held === 'mine' ? isChaserBehind(phys, eid, bikeEids) : false
    const hasMissileTarget =
      slot.held === 'missile' ? pickMissileTarget(sim, phys, eid, bikeEids) >= 0 : false

    if (
      shouldAIFire(slot.held, intent.throttle, Math.abs(intent.steer), hasChaser, hasMissileTarget)
    ) {
      ControlIntentStore.set(eid, { ...intent, fire: true })
    }
  }
}

function isChaserBehind(phys: PhysicsWorld, selfEid: number, bikeEids: QueryResult): boolean {
  const handle = RBHandleStore.get(selfEid)
  if (!handle) return false
  const rb = phys.world.getRigidBody(handle.handle)
  if (!rb) return false
  const t = rb.translation()
  const q = rb.rotation()
  const fwd = quatRotate(q, { x: 0, y: 0, z: 1 })

  for (const otherEid of bikeEids) {
    if (otherEid === selfEid) continue
    const otherHandle = RBHandleStore.must(otherEid)
    const otherRb = phys.world.getRigidBody(otherHandle.handle)
    if (!otherRb) continue
    const ot = otherRb.translation()
    const dx = ot.x - t.x
    const dy = ot.y - t.y
    const dz = ot.z - t.z
    const dist = Math.hypot(dx, dy, dz)
    if (dist > MINE_CHASER_RANGE) continue
    if (dist < 0.001) continue
    const dot = (fwd.x * dx + fwd.y * dy + fwd.z * dz) / dist
    if (dot < MINE_CHASER_DOT) return true
  }
  return false
}
