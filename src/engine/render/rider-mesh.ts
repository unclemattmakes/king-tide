/**
 * Procedural box mesh for a single rider bone.
 *
 * Physics is a capsule with axis along local Y, halfHeight + radius. We
 * render it as a thin capsule mesh oriented the same way, so visual ↔
 * physics shape match without a separate visual rig. Colour per-rider is
 * passed in by the render system so each rider reads as distinct.
 *
 * (Phase 1: placeholder. Phase 2 swaps these out for a skinned humanoid
 *  GLB loaded from `public/assets/riders/<id>.glb`.)
 */

import * as THREE from 'three'
import type { RiderBoneName } from '@/game/components/rider'

const sharedMaterials = new Map<number, THREE.MeshStandardMaterial>()

function getMaterial(color: number): THREE.MeshStandardMaterial {
  let m = sharedMaterials.get(color)
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.7,
      metalness: 0.05,
    })
    sharedMaterials.set(color, m)
  }
  return m
}

/**
 * Build a capsule mesh for one bone. Capsule axis = local +Y (matches
 * Rapier's default capsule orientation), so the mesh can be placed at the
 * bone's RB transform with no extra rotation.
 *
 * The "head" bone gets a distinct sphere on top so it reads as a head; we
 * approximate this by making the chest's mesh taller and adding a sphere
 * child for the head visually. For the procedural cut we just render each
 * bone as its own capsule — head approximation lives on the chest.
 */
export function createRiderBoneMesh(
  name: RiderBoneName,
  halfHeight: number,
  radius: number,
  color: number,
): THREE.Object3D {
  // Three.js CapsuleGeometry length is the cylindrical part length
  // (between the hemispheres) — same convention as Rapier's halfHeight
  // doubled. So length = halfHeight * 2.
  const length = halfHeight * 2
  const segments = 8
  const geom = new THREE.CapsuleGeometry(radius, length, 4, segments)
  const mesh = new THREE.Mesh(geom, getMaterial(color))
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.name = `rider_bone_${name}`

  if (name === 'chest') {
    // Visual head on top of chest. Sized roughly to a real head.
    const head = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.85, 16, 12), getMaterial(color))
    head.position.set(0, halfHeight + radius * 0.9, 0)
    head.castShadow = true
    head.receiveShadow = true
    head.name = 'rider_head'
    mesh.add(head)
  }
  return mesh
}
