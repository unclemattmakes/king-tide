import { addComponent, addEntity } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { Vec3 } from '@/engine/sim/physics/vec'
import {
  PickupSpawnState,
  PickupSpawnStateStore,
  PickupSpawnTag,
  type PickupType,
} from '@/game/components/pickup'

const POOL: PickupType[] = ['boost', 'boost', 'boost'] // M5: just boost. M5.5+ adds others.

export function pickRandomPickupType(): PickupType {
  return POOL[Math.floor(Math.random() * POOL.length)] ?? 'boost'
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
    nextType: pickRandomPickupType(),
  })
  return eid
}
