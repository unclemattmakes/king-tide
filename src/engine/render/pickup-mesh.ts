import * as THREE from 'three'

const COLOR_BY_TYPE: Record<string, number> = {
  boost: 0xffcc33,
  missile: 0xff5577,
  mine: 0x66ddff,
  shield: 0x66ff99,
}

/**
 * Visual pickup box: a glowing rotating cube hovering above the surface.
 * Color encodes pickup type for at-a-glance recognition.
 */
export function createPickupBoxMesh(type: string): THREE.Object3D {
  const root = new THREE.Group()
  root.name = `pickup:${type}`

  const color = COLOR_BY_TYPE[type] ?? 0xffffff
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.6,
    roughness: 0.4,
    metalness: 0.1,
  })
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), mat)
  box.position.y = 0.6
  root.add(box)

  // Glow ring at the base — helps locate from a distance.
  const ringGeom = new THREE.RingGeometry(1.0, 1.4, 24)
  const ringMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
  })
  const ring = new THREE.Mesh(ringGeom, ringMat)
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.05
  root.add(ring)

  return root
}
