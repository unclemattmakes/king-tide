import * as THREE from 'three'
import {
  CLIFF_FACE_CENTER,
  CLIFF_FACE_HALF_EXTENTS,
  CLIMB_RAMP_CENTER,
  CLIMB_RAMP_HALF_EXTENTS,
  CLIMB_RAMP_PITCH_RADIANS,
  MESA_CENTER,
  MESA_HALF_EXTENTS,
} from '@/game/entities/cliffside-terrain'

/**
 * Visual layer for Cliffside track terrain. Three meshes lined up with
 * the physics bodies in cliffside-terrain.ts:
 *   - mesa: flat tan cuboid, top surface = playable platform
 *   - climb ramp: stripe-painted ramp climbing the right straight
 *   - cliff face: pure-visual wall under the mesa's south edge so the
 *     drop reads dramatically (no physics counterpart)
 *
 * Returns a Group ready to add to the scene.
 */
export function createCliffsideMesh(): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'cliffside-terrain'

  // Mesa — earthy top with a darker cliff-side body.
  {
    const topMat = new THREE.MeshStandardMaterial({ color: 0xc8b07a, roughness: 0.95 })
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 0.9 })
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(
        MESA_HALF_EXTENTS.x * 2,
        MESA_HALF_EXTENTS.y * 2,
        MESA_HALF_EXTENTS.z * 2,
      ),
      [sideMat, sideMat, topMat, sideMat, sideMat, sideMat], // [+X, -X, +Y, -Y, +Z, -Z]
    )
    mesh.position.set(MESA_CENTER.x, MESA_CENTER.y, MESA_CENTER.z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    root.add(mesh)
  }

  // Climb ramp — same chevron treatment as the Lagoon Loop ramp so the
  // affordance reads consistently across tracks.
  {
    const sideMat = new THREE.MeshStandardMaterial({ color: 0xff8844, roughness: 0.55 })
    const topMat = new THREE.MeshStandardMaterial({ color: 0xffcc44, roughness: 0.5 })
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(
        CLIMB_RAMP_HALF_EXTENTS.x * 2,
        CLIMB_RAMP_HALF_EXTENTS.y * 2,
        CLIMB_RAMP_HALF_EXTENTS.z * 2,
      ),
      [sideMat, sideMat, topMat, sideMat, sideMat, sideMat],
    )
    slab.castShadow = true
    slab.receiveShadow = true
    const ramp = new THREE.Group()
    ramp.add(slab)

    // Chevron stripes across the top — every 5m or so along the length.
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.7 })
    const stripeCount = 9
    const stripeWidth = 0.4
    const stripeLength = CLIMB_RAMP_HALF_EXTENTS.x * 1.85
    const spacing = (CLIMB_RAMP_HALF_EXTENTS.z * 2) / (stripeCount + 1)
    for (let i = 0; i < stripeCount; i++) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(stripeLength, 0.06, stripeWidth),
        stripeMat,
      )
      stripe.position.set(
        0,
        CLIMB_RAMP_HALF_EXTENTS.y,
        -CLIMB_RAMP_HALF_EXTENTS.z + spacing * (i + 1),
      )
      stripe.receiveShadow = true
      ramp.add(stripe)
    }

    const halfA = CLIMB_RAMP_PITCH_RADIANS / 2
    ramp.quaternion.set(Math.sin(halfA), 0, 0, Math.cos(halfA))
    ramp.position.set(CLIMB_RAMP_CENTER.x, CLIMB_RAMP_CENTER.y, CLIMB_RAMP_CENTER.z)
    root.add(ramp)
  }

  // Cliff face — purely visual. Sits on the south side of the mesa to
  // sell the drop. No physics counterpart; the bike is meant to fly off
  // and land on water in front of it.
  {
    const cliffMat = new THREE.MeshStandardMaterial({ color: 0x5a4538, roughness: 0.95 })
    const cliff = new THREE.Mesh(
      new THREE.BoxGeometry(
        CLIFF_FACE_HALF_EXTENTS.x * 2,
        CLIFF_FACE_HALF_EXTENTS.y * 2,
        CLIFF_FACE_HALF_EXTENTS.z * 2,
      ),
      cliffMat,
    )
    cliff.position.set(CLIFF_FACE_CENTER.x, CLIFF_FACE_CENTER.y, CLIFF_FACE_CENTER.z)
    cliff.castShadow = true
    cliff.receiveShadow = true
    root.add(cliff)
  }

  return root
}
