/**
 * Wave-rider render system — builds a mesh per WaveRider entity on
 * first sight, then syncs its Three.js Object3D transform from the
 * ECS TransformStore each frame.
 *
 * Two visual sources, in order:
 *
 *   1. **Asset GLB clone** — when the entity was spawned from an
 *      editor-authored `assetId` prop, the caller passes an
 *      `assetResolver` that maps entity ids to a loaded
 *      `LoadedProp`. The system clones the prop GLB once per
 *      entity and uses that as the visual. This is the production
 *      path: a buoy authored in Blender ships its real geometry +
 *      materials, not a placeholder.
 *
 *   2. **Primitive fallback** — when no asset is bound (the
 *      `?waveriders=1` validation scene spawns raw WaveRiders with
 *      no prop GLB), the system falls back to a cylinder-and-cap
 *      primitive sized for the archetype. Keeps the test scene
 *      independent of the asset pipeline.
 */

import { query } from 'bitecs'
import * as THREE from 'three'
import type { SimWorld } from '@/engine/sim/ecs/world'
import { cloneLoadedProp, type LoadedProp } from '@/game/assets/prop-loader'
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

/** Resolves a wave-rider entity id to the prop GLB it was instanced
 *  from, when applicable. Returns undefined for entities spawned
 *  outside the asset-prop pipeline (the `?waveriders=1` test scene). */
export type WaveRiderAssetResolver = (eid: number) => LoadedProp | undefined

export type WaveRiderRenderOpts = {
  /** Optional per-entity GLB resolver. When provided + the entity has
   *  a matching `LoadedProp`, the system clones the prop's root for
   *  the visual. Otherwise it builds the primitive archetype mesh. */
  assetResolver?: WaveRiderAssetResolver
}

export function createWaveRiderRenderSystem(
  scene: THREE.Scene,
  sim: SimWorld,
  opts: WaveRiderRenderOpts = {},
): WaveRiderRenderSystem {
  const meshes = new Map<number, THREE.Object3D>()
  const ownedMaterials = new Set<THREE.Material>()
  const ownedGeometries = new Set<THREE.BufferGeometry>()

  function buildArchetypeMesh(archetype: WaveRiderArchetypeId | undefined): THREE.Object3D {
    // Only reached when an entity has no bound asset GLB (the
    // `?waveriders=1` test scene). Per-instance floats always resolve to
    // their real GLB above, so `undefined` here just falls to the neutral
    // log-style primitive.
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
        // Prefer the loaded asset GLB; fall back to the primitive
        // archetype mesh when none is registered for this entity.
        const loaded = opts.assetResolver?.(eid)
        if (loaded) {
          mesh = cloneLoadedProp(loaded)
          // cloneLoadedProp doesn't own its materials/geometries —
          // they're shared with the source GLB cache. We deliberately
          // don't register them in ownedMaterials / ownedGeometries
          // so disposal here doesn't yank them out from under the
          // prop-loader cache; the cache disposes them at app
          // teardown via its own path.
          mesh.traverse((obj) => {
            const m = obj as THREE.Mesh
            if (m.isMesh) {
              m.castShadow = true
              m.receiveShadow = true
            }
          })
        } else {
          mesh = buildArchetypeMesh(wr.archetype)
        }
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
