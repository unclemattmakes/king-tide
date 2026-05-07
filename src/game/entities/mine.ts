import { addComponent, addEntity } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { MineState, MineStateStore, MineTag } from '@/game/components/combat'

export function createMine(
  sim: SimWorld,
  position: { x: number; y: number; z: number },
  ownerEid: number,
): number {
  const eid = addEntity(sim)
  addComponent(sim, eid, MineTag)
  addComponent(sim, eid, MineState)
  MineStateStore.set(eid, {
    ownerEid,
    position: { x: position.x, y: position.y, z: position.z },
    ageSec: 0,
    detonated: false,
    detonatedAt: 0,
  })
  return eid
}
