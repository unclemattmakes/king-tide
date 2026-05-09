import * as THREE from 'three'
import { ISLAND_HEIGHT, ISLAND_RADIUS, ISLAND_TOP_Y } from '@/game/entities/arena'

/**
 * Visual island matching the physics cylinder. Beach-coloured top, darker sides.
 */
export function createIslandMesh(): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'island'

  const beachMat = new THREE.MeshStandardMaterial({ color: 0xc8b07a, roughness: 0.95 })
  const sideMat = new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 0.9 })

  const cyl = new THREE.Mesh(
    new THREE.CylinderGeometry(ISLAND_RADIUS, ISLAND_RADIUS, ISLAND_HEIGHT, 48),
    [sideMat, beachMat, sideMat], // [side, top, bottom]
  )
  cyl.position.y = ISLAND_TOP_Y - ISLAND_HEIGHT / 2
  cyl.castShadow = true
  cyl.receiveShadow = true
  root.add(cyl)

  // Subtle radial grid on top so motion is readable
  const grid = new THREE.GridHelper(ISLAND_RADIUS * 2 - 4, 12, 0x88aacc, 0x556677)
  grid.position.y = ISLAND_TOP_Y + 0.01
  root.add(grid)

  return root
}
