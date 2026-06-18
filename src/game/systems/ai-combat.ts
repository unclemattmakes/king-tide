import { type QueryResult, query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate } from '@/engine/sim/physics/vec'
import { BikeTag, ControlIntent, ControlIntentStore, RBHandle } from '@/game/components'
import { AITag } from '@/game/components/ai'
import { PickupSlot, PickupSlotStore, type PickupType } from '@/game/components/pickup'
import { bikeBody, forEachBikeInRange } from '@/game/systems/bike-spatial'
import { pickMissileTarget } from '@/game/systems/combat'
import { PICKUP_REGISTRY } from '@/game/systems/pickup-registry'

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
  return PICKUP_REGISTRY[held].aiShouldFire({ throttle, steerAbs, hasChaser, hasMissileTarget })
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

    // Only run the (relatively expensive) spatial scans the held type needs.
    const def = PICKUP_REGISTRY[slot.held]
    const hasChaser = def.needsChaser ? isChaserBehind(sim, phys, eid, bikeEids) : false
    const hasMissileTarget = def.needsMissileTarget
      ? pickMissileTarget(sim, phys, eid, bikeEids) >= 0
      : false

    if (
      def.aiShouldFire({
        throttle: intent.throttle,
        steerAbs: Math.abs(intent.steer),
        hasChaser,
        hasMissileTarget,
      })
    ) {
      ControlIntentStore.set(eid, { ...intent, fire: true })
    }
  }
}

function isChaserBehind(
  sim: SimWorld,
  phys: PhysicsWorld,
  selfEid: number,
  bikeEids: QueryResult,
): boolean {
  const rb = bikeBody(phys, selfEid)
  if (!rb) return false
  const t = rb.translation()
  const q = rb.rotation()
  const fwd = quatRotate(q, { x: 0, y: 0, z: 1 })

  let found = false
  forEachBikeInRange(
    sim,
    phys,
    t,
    MINE_CHASER_RANGE,
    ({ dx, dy, dz, dist }) => {
      if (dist < 0.001) return
      const dot = (fwd.x * dx + fwd.y * dy + fwd.z * dz) / dist
      if (dot < MINE_CHASER_DOT) {
        found = true
        return true
      }
    },
    { skipEid: selfEid, bikeEids },
  )
  return found
}
