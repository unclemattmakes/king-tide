/**
 * Rider render system — one capsule mesh per rider bone, positioned each
 * frame from the bone entity's Transform component (which `syncFromPhysics`
 * keeps in sync with the rider's Rapier bodies).
 *
 * No skinned mesh, no bones, no IK — phase 1 placeholder. Each rider's
 * bones get a single colour so the rider reads as a single character at
 * a glance.
 */

import { query } from 'bitecs'
import type * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { Transform, TransformStore } from '@/game/components'
import { Rider, RiderBone, RiderBoneStore, RiderBoneTag, RiderStore } from '@/game/components/rider'
import { createRiderBoneMesh } from './rider-mesh'

const RIDER_COLORS = [
  0x2233aa, // deep blue
  0xaa2233, // crimson
  0x22aa44, // forest
  0xaaaa22, // mustard
  0x884488, // plum
  0x227788, // teal
  0xcc6633, // burnt orange
  0x666666, // graphite
]

export function createRiderRenderSystem(scene: THREE.Scene, sim: SimWorld) {
  const meshes = new Map<number, THREE.Object3D>()
  /** rider eid → assigned colour (stable across frames). */
  const riderColors = new Map<number, number>()
  let colorCursor = 0

  function colorForRider(riderEid: number): number {
    let c = riderColors.get(riderEid)
    if (c === undefined) {
      c = RIDER_COLORS[colorCursor++ % RIDER_COLORS.length] ?? 0x444444
      riderColors.set(riderEid, c)
    }
    return c
  }

  return function tick(): void {
    const boneEids = query(sim, [RiderBoneTag, RiderBone, Transform])
    const live = new Set<number>()
    for (const eid of boneEids) {
      live.add(eid)
      const data = RiderBoneStore.get(eid)
      if (!data) continue
      let mesh = meshes.get(eid)
      if (!mesh) {
        const color = colorForRider(data.riderEid)
        mesh = createRiderBoneMesh(data.name, data.halfHeight, data.radius, color)
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

    // Drop colour assignments for riders that no longer exist, so the
    // cursor doesn't grow unboundedly across a long session.
    const liveRiders = new Set<number>()
    const riderEids = query(sim, [Rider])
    for (const eid of riderEids) {
      const r = RiderStore.get(eid)
      if (r) liveRiders.add(eid)
    }
    for (const eid of riderColors.keys()) {
      if (!liveRiders.has(eid)) riderColors.delete(eid)
    }
  }
}
