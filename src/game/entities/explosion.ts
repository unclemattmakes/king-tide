import { addComponent, addEntity } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { ExplosionState, ExplosionStateStore, ExplosionTag } from '@/game/components/combat'

export function createExplosion(
  sim: SimWorld,
  position: { x: number; y: number; z: number },
  color: number,
  lifetime = 0.6,
): number {
  const eid = addEntity(sim)
  addComponent(sim, eid, ExplosionTag)
  addComponent(sim, eid, ExplosionState)
  ExplosionStateStore.set(eid, {
    position: { x: position.x, y: position.y, z: position.z },
    ageSec: 0,
    lifetime,
    color,
  })
  return eid
}
