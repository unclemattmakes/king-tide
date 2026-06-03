import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import {
  PrevTickTransformStore,
  RBHandle,
  RBHandleStore,
  TickTransformStore,
  Transform,
  TransformStore,
} from '@/game/components'

export function syncFromPhysics(sim: SimWorld, phys: PhysicsWorld): void {
  const eids = query(sim, [RBHandle, Transform])
  for (const eid of eids) {
    const { handle } = RBHandleStore.must(eid)
    const rb = phys.world.getRigidBody(handle)
    if (!rb) continue
    const t = rb.translation()
    const q = rb.rotation()
    // Maintain the two-deep tick history that render interpolation reads.
    // Shift the previous committed pose into PrevTick before stamping the
    // new one; on the first sync for a body there's no prior tick, so seed
    // prev = cur (no motion) rather than smear from an unrelated value.
    const priorTick = TickTransformStore.get(eid)
    PrevTickTransformStore.set(
      eid,
      priorTick ?? { x: t.x, y: t.y, z: t.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w },
    )
    TickTransformStore.set(eid, { x: t.x, y: t.y, z: t.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w })
    // Keep the render-read store at the committed pose too. On a rendered
    // frame `interpolateRenderTransforms` overwrites this with the smoothed
    // pose; on any path that doesn't run that pass (editor/turntable modes)
    // this stays the canonical pose, preserving pre-interpolation behaviour.
    TransformStore.set(eid, { x: t.x, y: t.y, z: t.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w })
  }
}
