import { query } from 'bitecs'
import type * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { BikeTag, Transform, TransformStore } from '@/game/components'
import { createBikeMesh } from './bike-mesh'

export function createBikeRenderSystem(scene: THREE.Scene, sim: SimWorld) {
  const meshes = new Map<number, THREE.Object3D>()

  return function tick(): void {
    const eids = query(sim, [BikeTag, Transform])
    const live = new Set<number>()
    for (const eid of eids) {
      live.add(eid)
      let mesh = meshes.get(eid)
      if (!mesh) {
        mesh = createBikeMesh()
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
