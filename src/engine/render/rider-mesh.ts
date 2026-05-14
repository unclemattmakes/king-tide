/**
 * Procedural mesh for a single rider bone.
 *
 * Physics is a capsule with axis along local Y, halfHeight + radius. We
 * render it as a thin capsule mesh oriented the same way, so visual ↔
 * physics shape match without a separate visual rig. Colour per-rider is
 * passed in by the render system so each rider reads as distinct.
 *
 * The `head` bone is the one exception: its physics is a stubby capsule
 * but we draw it as a SphereGeometry for the correct helmet silhouette.
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
 * Build a mesh for one bone. Default = capsule with axis on local +Y;
 * head = sphere sized to its capsule radius so it reads as a helmet.
 */
export function createRiderBoneMesh(
  name: RiderBoneName,
  halfHeight: number,
  radius: number,
  color: number,
): THREE.Object3D {
  let mesh: THREE.Mesh
  if (name === 'head') {
    // Sphere scaled slightly larger than the capsule radius — the
    // halfHeight on the physics capsule is small (0.05) so the body's
    // collider is effectively a thin capsule; the visual silhouette is
    // dominated by the sphere we draw here.
    mesh = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.05, 18, 14), getMaterial(color))
  } else {
    // Three.js CapsuleGeometry length is the cylindrical part length
    // (between the hemispheres) — same convention as Rapier's halfHeight
    // doubled. So length = halfHeight * 2.
    const length = halfHeight * 2
    const segments = 8
    const geom = new THREE.CapsuleGeometry(radius, length, 4, segments)
    mesh = new THREE.Mesh(geom, getMaterial(color))
  }
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.name = `rider_bone_${name}`
  return mesh
}
