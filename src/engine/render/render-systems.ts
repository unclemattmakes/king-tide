import { hasComponent, query } from 'bitecs'
import type * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { BikeTag, PlayerTag, Transform, TransformStore } from '@/game/components'
import { createBikeMesh } from './bike-mesh'

const AI_BODY_COLORS = [0x33aaff, 0x44dd66, 0xcc55ff, 0xffcc33, 0xff5577]

export function createBikeRenderSystem(scene: THREE.Scene, sim: SimWorld) {
  const meshes = new Map<number, THREE.Object3D>()
  let aiColorCursor = 0

  return function tick(): void {
    const eids = query(sim, [BikeTag, Transform])
    const live = new Set<number>()
    for (const eid of eids) {
      live.add(eid)
      let mesh = meshes.get(eid)
      if (!mesh) {
        const isPlayer = hasComponent(sim, eid, PlayerTag)
        const color = isPlayer
          ? 0xff7733
          : (AI_BODY_COLORS[aiColorCursor++ % AI_BODY_COLORS.length] ?? 0xaaaaaa)
        mesh = createBikeMesh({ bodyColor: color })
        scene.add(mesh)
        meshes.set(eid, mesh)
      }
      const t = TransformStore.must(eid)
      mesh.position.set(t.x, t.y, t.z)
      mesh.quaternion.set(t.qx, t.qy, t.qz, t.qw)
    }
    for (const [eid, mesh] of meshes) {
      if (!live.has(eid)) {
        scene.remove(mesh)
        meshes.delete(eid)
      }
    }
  }
}
