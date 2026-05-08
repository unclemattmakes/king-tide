import * as THREE from 'three'
import { RAMP_CENTER, RAMP_HALF_EXTENTS, RAMP_PITCH_RADIANS } from '@/game/entities/ramp'

/**
 * Visual ramp mesh — a tilted slab matching the physics cuboid. Bright
 * accent color so it reads at distance against the water; chevron stripes
 * on top sell the "this is a jump, take it at speed" affordance.
 */
export function createRampMesh(): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'ramp'

  const sideMat = new THREE.MeshStandardMaterial({
    color: 0xff8844,
    roughness: 0.55,
    metalness: 0.1,
  })
  const topMat = new THREE.MeshStandardMaterial({
    color: 0xffcc44,
    roughness: 0.5,
    metalness: 0.1,
  })

  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(
      RAMP_HALF_EXTENTS.x * 2,
      RAMP_HALF_EXTENTS.y * 2,
      RAMP_HALF_EXTENTS.z * 2,
    ),
    [sideMat, sideMat, topMat, sideMat, sideMat, sideMat], // [+X, -X, +Y, -Y, +Z, -Z]
  )
  root.add(slab)

  // Chevron stripes painted on the top face: thin black bars across the
  // width, repeated along the length so direction-of-travel is obvious.
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.7 })
  const stripeCount = 5
  const stripeWidth = 0.35
  const stripeLength = RAMP_HALF_EXTENTS.x * 1.85
  const spacing = (RAMP_HALF_EXTENTS.z * 2) / (stripeCount + 1)
  for (let i = 0; i < stripeCount; i++) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(stripeLength, 0.06, stripeWidth), stripeMat)
    stripe.position.set(
      0,
      RAMP_HALF_EXTENTS.y, // sit on the top face
      -RAMP_HALF_EXTENTS.z + spacing * (i + 1),
    )
    root.add(stripe)
  }

  // Apply the same tilt + position as the physics body so the visual lines
  // up exactly with what the bike rides on.
  const halfA = RAMP_PITCH_RADIANS / 2
  root.quaternion.set(Math.sin(halfA), 0, 0, Math.cos(halfA))
  root.position.set(RAMP_CENTER.x, RAMP_CENTER.y, RAMP_CENTER.z)

  return root
}
