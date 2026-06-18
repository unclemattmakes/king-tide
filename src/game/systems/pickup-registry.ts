import { addComponent } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { ShieldEffect, ShieldEffectStore } from '@/game/components/combat'
import { BoostEffect, BoostEffectStore, type PickupType } from '@/game/components/pickup'
import { createMine } from '@/game/entities/mine'
import { createMissile } from '@/game/entities/missile'
import {
  getMineDropPosition,
  getMissileLaunchTransform,
  pickMissileTarget,
  SHIELD_DURATION,
} from '@/game/systems/combat'

/**
 * One table that co-locates everything that varies per pickup type: its
 * activation effect AND the AI's fire heuristic AND which spatial precompute
 * the AI needs. Adding a 5th pickup is now ONE entry here, instead of editing
 * three parallel switch statements (pickupUseSystem, shouldAIFire, and the
 * ai-combat precompute) plus the scattered effect constants.
 */

const BOOST_DURATION = 1.8 // seconds of throttle multiplier from a boost pickup
const BOOST_MULTIPLIER = 1.6 // throttle multiplier while a boost pickup is active

export type PickupUseCtx = { sim: SimWorld; phys: PhysicsWorld; eid: number }

/** This-tick race signals the AI fire heuristic reads. */
export type PickupAISignals = {
  throttle: number
  steerAbs: number
  /** A non-self bike is within mine range and behind us (only computed when
   *  `needsChaser`). */
  hasChaser: boolean
  /** A valid missile target sits in the forward cone (only computed when
   *  `needsMissileTarget`). */
  hasMissileTarget: boolean
}

export type PickupDef = {
  /** Apply the pickup's effect to the firing bike. */
  use(ctx: PickupUseCtx): void
  /** Whether an AI holding this should fire it right now. */
  aiShouldFire(signals: PickupAISignals): boolean
  /** AI needs the (relatively expensive) chaser scan for its heuristic. */
  needsChaser: boolean
  /** AI needs the missile-target acquisition scan for its heuristic. */
  needsMissileTarget: boolean
}

export const PICKUP_REGISTRY: Record<PickupType, PickupDef> = {
  boost: {
    use: ({ sim, eid }) => {
      if (!BoostEffectStore.has(eid)) addComponent(sim, eid, BoostEffect)
      BoostEffectStore.set(eid, { remaining: BOOST_DURATION, multiplier: BOOST_MULTIPLIER })
    },
    // Don't burn boost while ai-control has scaled throttle down for a turn.
    aiShouldFire: (s) => s.throttle > 0.85,
    needsChaser: false,
    needsMissileTarget: false,
  },
  shield: {
    use: ({ sim, eid }) => {
      if (!ShieldEffectStore.has(eid)) addComponent(sim, eid, ShieldEffect)
      ShieldEffectStore.set(eid, { remaining: SHIELD_DURATION })
    },
    // Purely defensive; sitting on it can't help. Fire whenever held.
    aiShouldFire: () => true,
    needsChaser: false,
    needsMissileTarget: false,
  },
  mine: {
    use: ({ sim, phys, eid }) => {
      const dropPos = getMineDropPosition(phys, eid)
      if (dropPos) createMine(sim, dropPos, eid)
    },
    // Drop on a chaser, or on a corner apex (catches trailing bikes that
    // follow the racing line).
    aiShouldFire: (s) => s.hasChaser || s.steerAbs > 0.4,
    needsChaser: true,
    needsMissileTarget: false,
  },
  missile: {
    use: ({ sim, phys, eid }) => {
      const launch = getMissileLaunchTransform(phys, eid)
      if (launch) {
        const target = pickMissileTarget(sim, phys, eid)
        createMissile(sim, launch.position, launch.velocity, eid, target)
      }
    },
    // Need a target inside the forward cone AND a launch heading pointing
    // roughly the right way (i.e. not mid-corner).
    aiShouldFire: (s) => s.throttle > 0.8 && s.hasMissileTarget,
    needsChaser: false,
    needsMissileTarget: true,
  },
}
