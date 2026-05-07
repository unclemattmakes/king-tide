import { query } from 'bitecs'
import type * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { PickupSpawnState, PickupSpawnStateStore, PickupSpawnTag } from '@/game/components/pickup'
import { createPickupBoxMesh } from './pickup-mesh'

/**
 * Renders pickup spawn boxes — visible only while `active`. Each box rotates
 * for visibility. Despawns/respawns by toggling visible.
 */
export function createPickupRenderSystem(scene: THREE.Scene, sim: SimWorld) {
  const meshes = new Map<number, THREE.Object3D>()
  let timeAccum = 0

  return function tick(dt: number): void {
    timeAccum += dt
    const eids = query(sim, [PickupSpawnTag, PickupSpawnState])
    const live = new Set<number>()
    for (const eid of eids) {
      live.add(eid)
      const s = PickupSpawnStateStore.must(eid)
      let mesh = meshes.get(eid)
      if (!mesh) {
        mesh = createPickupBoxMesh(s.nextType)
        mesh.position.set(s.position.x, s.position.y, s.position.z)
        scene.add(mesh)
        meshes.set(eid, mesh)
      }
      mesh.visible = s.active
      // Spin the box for visual life.
      mesh.rotation.y = timeAccum * 1.6
    }
    for (const [eid, mesh] of meshes) {
      if (!live.has(eid)) {
        scene.remove(mesh)
        meshes.delete(eid)
      }
    }
  }
}
