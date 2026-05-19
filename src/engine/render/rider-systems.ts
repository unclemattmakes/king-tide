/**
 * Rider render system — one capsule mesh per rider bone, positioned each
 * frame from the bone entity's Transform component (which `syncFromPhysics`
 * keeps in sync with the rider's Rapier bodies).
 *
 * No skinned mesh, no bones, no IK — phase 1 placeholder. Each rider's
 * bones get a single colour so the rider reads as a single character at
 * a glance.
 *
 * Trick-spin handling: the bike's visual trick rotation is *not* applied
 * to the rigid body, so the rider's bone Transforms (which come from
 * physics) don't include it either. To keep the rider visually attached
 * during a barrel roll / flip / yaw, we look up the bike's `TrickState`
 * and pivot each bone's render pose around the bike's world position
 * by the same axis-angle the bike mesh uses. Render-only — never
 * touches sim state.
 */

import { hasComponent, query } from 'bitecs'
import * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { Transform, TransformStore, TrickState, TrickStateStore } from '@/game/components'
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

  // Per-tick trick-rotation cache, keyed by bikeEid. Built once at the
  // top of each tick so bones for the same bike don't recompute the
  // pivot quaternion. Cleared on every tick (so a finished trick stops
  // pivoting its bones).
  type TrickXform = {
    pivotX: number
    pivotY: number
    pivotZ: number
    quat: THREE.Quaternion
  }
  const trickByBike = new Map<number, TrickXform>()

  // Reusable scratch math — avoid per-bone allocation.
  const tmpRel = new THREE.Vector3()
  const tmpBoneQuat = new THREE.Quaternion()
  const tmpAxis = new THREE.Vector3()

  return function tick(): void {
    // Build the per-bike trick-rotation cache. One pass over Rider
    // entities so the per-bone loop below stays cheap. A bike with
    // no active trick (spinPhase=0 or zero axis vector) is omitted —
    // bones fall through to the unchanged physics-driven pose.
    trickByBike.clear()
    const riderEids = query(sim, [Rider])
    for (const riderEid of riderEids) {
      const r = RiderStore.get(riderEid)
      if (!r) continue
      const bikeEid = r.bikeEid
      if (!hasComponent(sim, bikeEid, TrickState)) continue
      const trick = TrickStateStore.get(bikeEid)
      if (!trick || trick.spinPhase <= 0) continue
      const ax = trick.spinAxisX
      const ay = trick.spinAxisY
      const az = trick.spinAxisZ
      const len2 = ax * ax + ay * ay + az * az
      if (len2 < 1e-6) continue
      const bikeT = TransformStore.get(bikeEid)
      if (!bikeT) continue
      const progress = 1 - trick.spinPhase
      const eased = 1 - (1 - progress) * (1 - progress)
      const angle = eased * Math.PI * 2
      const invLen = 1 / Math.sqrt(len2)
      tmpAxis.set(ax * invLen, ay * invLen, az * invLen)
      const quat = new THREE.Quaternion().setFromAxisAngle(tmpAxis, angle)
      trickByBike.set(bikeEid, {
        pivotX: bikeT.x,
        pivotY: bikeT.y,
        pivotZ: bikeT.z,
        quat,
      })
    }

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
      // Look up this bone's owning bike via Rider → bikeEid.
      const rider = RiderStore.get(data.riderEid)
      const trickXform = rider ? trickByBike.get(rider.bikeEid) : undefined
      if (trickXform) {
        // Pivot the bone around the bike's world position by the
        // trick quaternion. Bone's own orientation also rotates by
        // the same quaternion so capsules don't twist out of plane.
        tmpRel.set(t.x - trickXform.pivotX, t.y - trickXform.pivotY, t.z - trickXform.pivotZ)
        tmpRel.applyQuaternion(trickXform.quat)
        mesh.position.set(
          trickXform.pivotX + tmpRel.x,
          trickXform.pivotY + tmpRel.y,
          trickXform.pivotZ + tmpRel.z,
        )
        tmpBoneQuat.set(t.qx, t.qy, t.qz, t.qw)
        mesh.quaternion.copy(trickXform.quat).multiply(tmpBoneQuat)
      } else {
        mesh.position.set(t.x, t.y, t.z)
        mesh.quaternion.set(t.qx, t.qy, t.qz, t.qw)
      }
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
    const colorRiderEids = query(sim, [Rider])
    for (const eid of colorRiderEids) {
      const r = RiderStore.get(eid)
      if (r) liveRiders.add(eid)
    }
    for (const eid of riderColors.keys()) {
      if (!liveRiders.has(eid)) riderColors.delete(eid)
    }
  }
}
