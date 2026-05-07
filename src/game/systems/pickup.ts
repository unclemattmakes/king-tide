import { addComponent, query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import {
  BikeTag,
  ControlIntent,
  ControlIntentStore,
  RBHandle,
  RBHandleStore,
} from '@/game/components'
import {
  BoostEffect,
  BoostEffectStore,
  PickupSlot,
  PickupSlotStore,
  PickupSpawnState,
  PickupSpawnStateStore,
  PickupSpawnTag,
  type PickupType,
} from '@/game/components/pickup'
import { pickRandomPickupType } from '@/game/entities/pickup-spawn'

const PICKUP_RADIUS = 2.5 // bike center within this many meters of box → collect
const RESPAWN_DELAY = 4 // seconds
const BOOST_DURATION = 1.8
const BOOST_MULTIPLIER = 1.6

/**
 * Detect bikes overlapping active pickup boxes; fill the bike's slot if empty.
 * Tick respawn timers on inactive boxes.
 */
export function pickupSystem(sim: SimWorld, phys: PhysicsWorld, dt: number): void {
  const spawnEids = query(sim, [PickupSpawnTag, PickupSpawnState])
  const bikeEids = query(sim, [BikeTag, RBHandle, PickupSlot])

  for (const sEid of spawnEids) {
    const spawn = PickupSpawnStateStore.must(sEid)

    if (!spawn.active) {
      const remain = spawn.respawnIn - dt
      if (remain <= 0) {
        spawn.active = true
        spawn.respawnIn = 0
        spawn.nextType = pickRandomPickupType()
      } else {
        spawn.respawnIn = remain
      }
      PickupSpawnStateStore.set(sEid, spawn)
      continue
    }

    // Active — check for any bike in range with an empty slot.
    for (const bEid of bikeEids) {
      const slot = PickupSlotStore.must(bEid)
      if (slot.held) continue

      const { handle } = RBHandleStore.must(bEid)
      const rb = phys.world.getRigidBody(handle)
      if (!rb) continue
      const t = rb.translation()
      const dx = t.x - spawn.position.x
      const dy = t.y - spawn.position.y
      const dz = t.z - spawn.position.z
      if (dx * dx + dy * dy + dz * dz > PICKUP_RADIUS * PICKUP_RADIUS) continue

      // Collect.
      PickupSlotStore.set(bEid, { held: spawn.nextType })
      spawn.active = false
      spawn.respawnIn = RESPAWN_DELAY
      PickupSpawnStateStore.set(sEid, spawn)
      break
    }
  }
}

/**
 * Consume a held pickup when the bike's intent.fire goes from false → true.
 * For M5 we only have boost, which sets a BoostEffect on the bike.
 */
export function pickupUseSystem(sim: SimWorld, _phys: PhysicsWorld): void {
  const eids = query(sim, [BikeTag, ControlIntent, PickupSlot])
  for (const eid of eids) {
    const intent = ControlIntentStore.must(eid)
    const slot = PickupSlotStore.must(eid)
    if (!intent.fire || !slot.held) {
      // Track previous fire state via the slot itself? We don't have one yet.
      // For M5: treat as edge-triggered by clearing fire after consumption.
      // Caveat: relies on intent being mutated after use. Acceptable for now.
      continue
    }
    if (slot.held === 'boost') {
      // Apply boost effect.
      if (!BoostEffectStore.has(eid)) {
        addComponent(sim, eid, BoostEffect)
      }
      BoostEffectStore.set(eid, { remaining: BOOST_DURATION, multiplier: BOOST_MULTIPLIER })
    }
    // Future: missile/mine/shield branches.
    PickupSlotStore.set(eid, { held: null })
  }
}

/**
 * Tick boost timers. When expired, the BoostEffect data has remaining <= 0
 * but we keep the component attached (cheap) and let consumers gate on remaining.
 * The hover system reads BoostEffect via getCurrentBoostMultiplier().
 */
export function boostTickSystem(sim: SimWorld, dt: number): void {
  const eids = query(sim, [BoostEffect])
  for (const eid of eids) {
    const b = BoostEffectStore.must(eid)
    if (b.remaining > 0) {
      BoostEffectStore.set(eid, { remaining: b.remaining - dt, multiplier: b.multiplier })
    }
  }
}

export function getCurrentBoostMultiplier(eid: number): number {
  const b = BoostEffectStore.get(eid)
  if (!b || b.remaining <= 0) return 1
  return b.multiplier
}

export function getHeldPickup(eid: number): PickupType | null {
  return PickupSlotStore.get(eid)?.held ?? null
}
