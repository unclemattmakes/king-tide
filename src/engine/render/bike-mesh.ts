import * as THREE from 'three'

/**
 * Programmer-art hover bike: oriented stadium body with a forward fin
 * and a glowing underside puck (the visual "hover thrust").
 * +Z is forward to match the physics convention.
 */
export function createBikeMesh(opts?: { bodyColor?: number }): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'bike'

  const bodyMat = new THREE.MeshStandardMaterial({
    color: opts?.bodyColor ?? 0xff7733,
    roughness: 0.4,
    metalness: 0.2,
  })
  const fwdMat = new THREE.MeshStandardMaterial({ color: 0xffcc66, roughness: 0.5 })
  const hoverMat = new THREE.MeshStandardMaterial({
    color: 0x66ddff,
    emissive: 0x3399cc,
    emissiveIntensity: 0.8,
    roughness: 0.3,
  })

  // Body: capsule along Z (length 1.2, radius 0.45 — matches collider).
  const bodyGeom = new THREE.CapsuleGeometry(0.45, 1.2, 4, 12)
  const body = new THREE.Mesh(bodyGeom, bodyMat)
  body.rotation.x = Math.PI / 2 // CapsuleGeometry's axis is Y; rotate to Z
  root.add(body)

  // Cockpit: small box up top
  const cockpitGeom = new THREE.BoxGeometry(0.5, 0.35, 0.6)
  const cockpit = new THREE.Mesh(cockpitGeom, bodyMat)
  cockpit.position.set(0, 0.35, -0.05)
  root.add(cockpit)

  // Forward fin — clearly indicates which way the bike is pointing.
  const finGeom = new THREE.ConeGeometry(0.18, 0.6, 4)
  const fin = new THREE.Mesh(finGeom, fwdMat)
  fin.rotation.x = -Math.PI / 2
  fin.position.set(0, 0.1, 1.05)
  root.add(fin)

  // Hover puck — glowing disc on the underside, visually communicates the hover gap.
  const puckGeom = new THREE.CylinderGeometry(0.55, 0.55, 0.08, 16)
  const puck = new THREE.Mesh(puckGeom, hoverMat)
  puck.position.set(0, -0.45, 0)
  root.add(puck)

  return root
}
