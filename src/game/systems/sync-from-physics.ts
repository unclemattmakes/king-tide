import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { RBHandle, RBHandleStore, Transform, TransformStore } from '@/game/components'

export function syncFromPhysics(sim: SimWorld, phys: PhysicsWorld): void {
  const eids = query(sim, [RBHandle, Transform])
  for (const eid of eids) {
    const { handle } = RBHandleStore.must(eid)
    const rb = phys.world.getRigidBody(handle)
    if (!rb) continue
    const t = rb.translation()
    const q = rb.rotation()
    TransformStore.set(eid, {
      x: t.x,
      y: t.y,
      z: t.z,
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
    })
  }
}
