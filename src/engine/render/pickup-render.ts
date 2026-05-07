import { query } from 'bitecs'
import type * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import {
  PickupSpawnState,
  PickupSpawnStateStore,
  PickupSpawnTag,
  type PickupType,
} from '@/game/components/pickup'
import { createPickupBoxMesh } from './pickup-mesh'

type PickupBox = {
  mesh: THREE.Object3D
  type: PickupType
}

/**
 * Renders pickup spawn boxes — visible only while `active`. Each box rotates
 * for visibility. When a spawn refills with a different pickup type the
 * mesh is rebuilt so the color matches.
 */
export function createPickupRenderSystem(scene: THREE.Scene, sim: SimWorld) {
  const boxes = new Map<number, PickupBox>()
  let timeAccum = 0

  return function tick(dt: number): void {
    timeAccum += dt
    const eids = query(sim, [PickupSpawnTag, PickupSpawnState])
    const live = new Set<number>()
    for (const eid of eids) {
      live.add(eid)
      const s = PickupSpawnStateStore.must(eid)
      let box = boxes.get(eid)
      if (!box || box.type !== s.nextType) {
        if (box) scene.remove(box.mesh)
        const mesh = createPickupBoxMesh(s.nextType)
        mesh.position.set(s.position.x, s.position.y, s.position.z)
        scene.add(mesh)
        box = { mesh, type: s.nextType }
        boxes.set(eid, box)
      }
      box.mesh.visible = s.active
      box.mesh.rotation.y = timeAccum * 1.6
    }
    for (const [eid, box] of boxes) {
      if (!live.has(eid)) {
        scene.remove(box.mesh)
        boxes.delete(eid)
      }
    }
  }
}
