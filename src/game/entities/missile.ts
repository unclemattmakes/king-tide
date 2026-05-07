import { addComponent, addEntity } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { MissileState, MissileStateStore, MissileTag } from '@/game/components/combat'

export function createMissile(
  sim: SimWorld,
  position: { x: number; y: number; z: number },
  velocity: { x: number; y: number; z: number },
  ownerEid: number,
  targetEid: number,
): number {
  const eid = addEntity(sim)
  addComponent(sim, eid, MissileTag)
  addComponent(sim, eid, MissileState)
  MissileStateStore.set(eid, {
    ownerEid,
    targetEid,
    position: { x: position.x, y: position.y, z: position.z },
    velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
    ageSec: 0,
    detonated: false,
  })
  return eid
}
