/**
 * Procedural mesh for a single rider bone.
 *
 * Physics is a capsule with axis along local Y, halfHeight + radius. By
 * default we render it as a thin capsule mesh oriented the same way, so
 * visual ↔ physics shape match without a separate visual rig. Colour per-rider
 * is passed in by the render system so each rider reads as distinct.
 *
 * The bone's primitive is selectable (capsule / box / sphere / cylinder /
 * cone) — the **rider editor** drives this per bone. Every primitive is built
 * around the same capsule extent (cylindrical length `2 * halfHeight`, capped
 * radius `radius`) so swapping the shape keeps the rider roughly the same size.
 *
 * The `head` bone is special when drawn as a **box** — physics is a stubby
 * capsule but we render a cube with a small forward "visor" wedge, so the
 * head's rotation (yaw/pitch) is clearly visible. A sphere looks the same from
 * every angle and made it impossible to tell which way the head was pointing.
 * Picking any non-box primitive for the head drops the visor.
 */

import * as THREE from 'three'
import type { RiderBoneName } from '@/game/components/rider'
import { defaultBonePrimitive, type RiderPrimitive } from './rider-appearance'

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

/** Build the head cube + forward visor wedge + nose bump. Used when the head
 *  bone is drawn as a box (its default), so the rider's facing is legible. */
function createHeadBox(radius: number, color: number): THREE.Object3D {
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

/** Build the geometry for a primitive, sized from the bone's capsule extent.
 *  All primitives share the capsule convention: long axis is local +Y, the
 *  cylindrical length is `2 * halfHeight`, and the radius caps it. */
function createPrimitiveGeometry(
  primitive: RiderPrimitive,
  halfHeight: number,
  radius: number,
): THREE.BufferGeometry {
  const length = halfHeight * 2
  const fullLength = length + radius * 2
  const segments = 8
  switch (primitive) {
    case 'box':
      return new THREE.BoxGeometry(radius * 2, fullLength, radius * 2)
    case 'sphere': {
      // Ellipsoid spanning the bone so a long limb still reads as a limb
      // rather than a tiny bead.
      const geom = new THREE.SphereGeometry(1, 16, 12)
      geom.scale(radius, halfHeight + radius, radius)
      return geom
    }
    case 'cylinder':
      return new THREE.CylinderGeometry(radius, radius, length, 12)
    case 'cone':
      return new THREE.ConeGeometry(radius, fullLength, 12)
    default:
      // Three.js CapsuleGeometry length is the cylindrical part length
      // (between the hemispheres) — same convention as Rapier's halfHeight
      // doubled. So length = halfHeight * 2.
      return new THREE.CapsuleGeometry(radius, length, 4, segments)
  }
}

/**
 * Build a mesh for one bone. `primitive` defaults to the bone's canonical
 * shape (head = box with visor, everything else = capsule).
 */
export function createRiderBoneMesh(
  name: RiderBoneName,
  halfHeight: number,
  radius: number,
  color: number,
  primitive: RiderPrimitive = defaultBonePrimitive(name),
): THREE.Object3D {
  // Head-as-box keeps the visor + nose so the facing stays legible.
  if (name === 'head' && primitive === 'box') {
    return createHeadBox(radius, color)
  }

  const geom = createPrimitiveGeometry(primitive, halfHeight, radius)
  const mesh = new THREE.Mesh(geom, getMaterial(color))
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.name = `rider_bone_${name}`
  return mesh
}
