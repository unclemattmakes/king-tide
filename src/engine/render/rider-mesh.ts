/**
 * Procedural mesh for a single rider bone.
 *
 * Physics is a capsule with axis along local Y, halfHeight + radius. We
 * render it as a thin capsule mesh oriented the same way, so visual ↔
 * physics shape match without a separate visual rig. Colour per-rider is
 * passed in by the render system so each rider reads as distinct.
 *
 * The `head` bone is special — physics is a stubby capsule but we render
 * it as a **cube** with a small forward "visor" wedge, so the head's
 * rotation (yaw/pitch) is clearly visible during calibration. A sphere
 * looks the same from every angle and made it impossible to tell which
 * way the head was pointing.
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

/** Lighter accent colour for the head's forward-facing visor — picks the
 *  XOR'd bytes of the base color so the visor reads against any rider hue. */
function getVisorMaterial(color: number): THREE.MeshStandardMaterial {
  const accent = (color ^ 0x808080) & 0xffffff
  let m = sharedMaterials.get(accent)
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: accent,
      roughness: 0.4,
      metalness: 0.15,
    })
    sharedMaterials.set(accent, m)
  }
  return m
}

/**
 * Build a mesh for one bone. Default = capsule with axis on local +Y;
 * head = cube + forward visor so rotation is legible.
 */
export function createRiderBoneMesh(
  name: RiderBoneName,
  halfHeight: number,
  radius: number,
  color: number,
): THREE.Object3D {
  if (name === 'head') {
    // Cube sized to the head capsule's bounding box. The capsule's
    // halfHeight (~0.05) is small relative to radius (~0.16) so a square-
    // ish cube around 2*radius reads well.
    const side = radius * 2
    const group = new THREE.Group()
    group.name = 'rider_bone_head'

    const cube = new THREE.Mesh(new THREE.BoxGeometry(side, side * 1.15, side), getMaterial(color))
    cube.castShadow = true
    cube.receiveShadow = true
    group.add(cube)

    // Forward "visor" — a thin slab on the +Z face. Bone-local +Z is
    // bike-forward at rest, so this clearly shows which way the head
    // is looking under yaw/pitch.
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(side * 0.7, side * 0.35, side * 0.08),
      getVisorMaterial(color),
    )
    visor.position.set(0, side * 0.15, side * 0.5)
    visor.castShadow = true
    visor.receiveShadow = true
    group.add(visor)

    // Small "nose" bump centred on the visor for an even more obvious
    // forward indicator from oblique angles.
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(side * 0.12, side * 0.12, side * 0.18),
      getVisorMaterial(color),
    )
    nose.position.set(0, side * 0.05, side * 0.58)
    nose.castShadow = true
    nose.receiveShadow = true
    group.add(nose)

    return group
  }

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
  return mesh
}
