import * as THREE from 'three'
import { DRIFT_TEST_PLATE_HALF_SIZE } from '@/game/entities/drift-test-arena'

/**
 * Visual plate for the `drift-test` map. Flat asphalt-coloured plane
 * with a grid for motion readability, plus four corner pylons so the
 * player can orient on a featureless arena. The mesh sits at y = 0 to
 * match the physics collider's top surface.
 *
 * Sized slightly inside the physics plate so a bike sliding off the
 * edge of the visual still has collider under it for a beat —
 * smooths the "fell off the world" transition rather than vanishing
 * into open air mid-drift.
 */
export function createDriftTestArenaMesh(): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'drift-test-arena'

  const visualHalf = DRIFT_TEST_PLATE_HALF_SIZE - 5

  // Tarmac slab. PlaneGeometry rotated to face +Y so the grid + bike
  // shadow read correctly.
  const tarmacMat = new THREE.MeshStandardMaterial({
    color: 0x32363a,
    roughness: 0.95,
    metalness: 0.05,
  })
  const tarmac = new THREE.Mesh(new THREE.PlaneGeometry(visualHalf * 2, visualHalf * 2), tarmacMat)
  tarmac.rotation.x = -Math.PI / 2
  tarmac.position.y = 0.01 // a hair above the collider top so z-fighting doesn't strobe
  tarmac.receiveShadow = true
  root.add(tarmac)

  // Reference grid — large cell size so the squares read at chase-cam
  // distance. Two colors so primary lines stand out from secondary.
  const grid = new THREE.GridHelper(visualHalf * 2, 44, 0xfff0a0, 0x4a5258)
  grid.position.y = 0.02
  root.add(grid)

  // Inner racing-line oval marker — a thin glowing strip the drift-
  // test e2e + the player can use as a visible "follow this arc to
  // drift" hint. Drawn as THREE.LineSegments (pairs of endpoints)
  // because the WebGPU renderer doesn't support LineLoop. Each
  // segment connects consecutive points along the oval; doubling up
  // the points lets us reuse a single LineBasicMaterial.
  const innerR = 60
  const segments = 96
  const ovalPts: number[] = []
  for (let i = 0; i < segments; i++) {
    const t0 = (i / segments) * Math.PI * 2
    const t1 = ((i + 1) / segments) * Math.PI * 2
    // Slight oval — longer in x so a hop fires comfortably on the
    // straights and a wide drift fits the corners.
    ovalPts.push(Math.cos(t0) * innerR * 1.4, 0.05, Math.sin(t0) * innerR)
    ovalPts.push(Math.cos(t1) * innerR * 1.4, 0.05, Math.sin(t1) * innerR)
  }
  const ovalGeom = new THREE.BufferGeometry()
  ovalGeom.setAttribute('position', new THREE.Float32BufferAttribute(ovalPts, 3))
  const ovalMat = new THREE.LineBasicMaterial({ color: 0xffcc55 })
  const oval = new THREE.LineSegments(ovalGeom, ovalMat)
  root.add(oval)

  // Four corner pylons so the otherwise featureless plate has cardinal
  // landmarks — helps the player tell "I'm on the north straight"
  // from chase cam.
  const pylonMat = new THREE.MeshStandardMaterial({
    color: 0xff6644,
    roughness: 0.5,
    emissive: 0x331100,
    emissiveIntensity: 0.6,
  })
  const corners: [number, number][] = [
    [visualHalf - 8, visualHalf - 8],
    [-(visualHalf - 8), visualHalf - 8],
    [-(visualHalf - 8), -(visualHalf - 8)],
    [visualHalf - 8, -(visualHalf - 8)],
  ]
  for (const [cx, cz] of corners) {
    const pylon = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 12, 16), pylonMat)
    pylon.position.set(cx, 6, cz)
    pylon.castShadow = true
    pylon.receiveShadow = true
    root.add(pylon)
  }

  return root
}
