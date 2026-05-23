/**
 * Wave-rider render system — builds a primitive mesh per archetype on
 * first sight of each WaveRider entity, then syncs its Three.js
 * Object3D transform from the ECS TransformStore each frame.
 *
 * Visuals are intentionally simple primitives (cylinder + emissive cap
 * for buoys, horizontal cylinder for logs). The eventual production
 * pipeline will swap these out for GLB props loaded from the props
 * library; the system's only contract is "produce a visible thing per
 * entity that follows its Transform."
 */

import { query } from 'bitecs'
import * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { TransformStore } from '@/game/components'
import {
  type WaveRiderArchetypeId,
  WaveRiderStore,
  WaveRiderTag,
} from '@/game/components/wave-rider'

export type WaveRiderRenderSystem = {
  /** Walk WaveRider entities, lazily mint a mesh, sync transforms. */
  render(): void
  /** Tear down all created meshes + materials. */
  dispose(): void
}

export function createWaveRiderRenderSystem(
  scene: THREE.Scene,
  sim: SimWorld,
): WaveRiderRenderSystem {
  const meshes = new Map<number, THREE.Object3D>()
  const ownedMaterials = new Set<THREE.Material>()
  const ownedGeometries = new Set<THREE.BufferGeometry>()

  function buildArchetypeMesh(archetype: WaveRiderArchetypeId): THREE.Object3D {
    const group = new THREE.Group()
    if (archetype === 'buoy') {
      const bodyGeom = new THREE.CylinderGeometry(0.38, 0.42, 0.9, 18, 1, false)
      const bodyMat = new THREE.MeshStandardMaterial({
        color: 0xd83d2a,
        roughness: 0.55,
        metalness: 0.05,
      })
      const stripeGeom = new THREE.CylinderGeometry(0.385, 0.385, 0.18, 18, 1, true)
      const stripeMat = new THREE.MeshStandardMaterial({
        color: 0xf6f0e8,
        roughness: 0.7,
        metalness: 0,
      })
      const capGeom = new THREE.SphereGeometry(0.18, 16, 12)
      const capMat = new THREE.MeshStandardMaterial({
        color: 0xfff0a0,
        emissive: 0xffaa00,
        emissiveIntensity: 1.4,
        roughness: 0.4,
      })
      const body = new THREE.Mesh(bodyGeom, bodyMat)
      const stripe = new THREE.Mesh(stripeGeom, stripeMat)
      stripe.position.y = 0.1
      const cap = new THREE.Mesh(capGeom, capMat)
      cap.position.y = 0.6
      body.castShadow = true
      body.receiveShadow = true
      cap.castShadow = true
      group.add(body)
      group.add(stripe)
      group.add(cap)
      ownedGeometries.add(bodyGeom)
      ownedGeometries.add(stripeGeom)
      ownedGeometries.add(capGeom)
      ownedMaterials.add(bodyMat)
      ownedMaterials.add(stripeMat)
      ownedMaterials.add(capMat)
    } else {
      const logGeom = new THREE.CylinderGeometry(0.3, 0.3, 2.4, 14, 1, false)
      const logMat = new THREE.MeshStandardMaterial({
        color: 0x6b4a2a,
        roughness: 0.88,
        metalness: 0,
      })
      const log = new THREE.Mesh(logGeom, logMat)
      // Rotate so the cylinder runs along world-Z when yaw=0. The collider
      // is a vertical cylinder for simplicity — only the visual rotates.
      log.rotation.z = Math.PI / 2
      log.castShadow = true
      log.receiveShadow = true
      group.add(log)
      ownedGeometries.add(logGeom)
      ownedMaterials.add(logMat)
    }
    return group
  }

  function render(): void {
    const entities = query(sim, [WaveRiderTag])
    for (const eid of entities) {
      let mesh = meshes.get(eid)
      if (!mesh) {
        const wr = WaveRiderStore.get(eid)
        if (!wr) continue
        mesh = buildArchetypeMesh(wr.archetype)
        scene.add(mesh)
        meshes.set(eid, mesh)
      }
      const t = TransformStore.get(eid)
      if (!t) continue
      mesh.position.set(t.x, t.y, t.z)
      mesh.quaternion.set(t.qx, t.qy, t.qz, t.qw)
    }
  }

  function dispose(): void {
    for (const mesh of meshes.values()) scene.remove(mesh)
    meshes.clear()
    for (const g of ownedGeometries) g.dispose()
    for (const m of ownedMaterials) m.dispose()
    ownedGeometries.clear()
    ownedMaterials.clear()
  }

  return { render, dispose }
}
