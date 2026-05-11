import { addComponent, addEntity } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { Vec3 } from '@/engine/sim/physics/vec'
import type { Rng } from '@/engine/sim/rng'
import {
  PickupSpawnState,
  PickupSpawnStateStore,
  PickupSpawnTag,
  type PickupType,
} from '@/game/components/pickup'

// Boost is over-represented because it's the safe baseline — the offensive
// pickups are higher-stakes, so they should feel more like a treat than a
// default. Tune the ratio if combat starts dominating racing.
const POOL: PickupType[] = ['boost', 'boost', 'missile', 'mine', 'shield']

export function pickRandomPickupType(rng: Rng): PickupType {
  return POOL[rng.nextInt(POOL.length)] ?? 'boost'
}

export function createPickupSpawn(sim: SimWorld, position: Vec3, spawnIndex: number): number {
  const eid = addEntity(sim)
  addComponent(sim, eid, PickupSpawnTag)
  addComponent(sim, eid, PickupSpawnState)
  PickupSpawnStateStore.set(eid, {
    spawnIndex,
    position,
    active: true,
    respawnIn: 0,
    nextType: pickRandomPickupType(sim.rng),
  })
  return eid
}
