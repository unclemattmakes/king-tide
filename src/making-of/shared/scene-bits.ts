import * as THREE from 'three'

/**
 * The stylized hoverbike used across the demos: a flat hull with a pointed
 * nose at +Z (forward) and a rider block. `halfLen` sets the hull's
 * fore/aft half-extent in meters so a demo can match it to whatever probe
 * footprint it's illustrating.
 */
export function buildBike(halfLen = 1.4): THREE.Group {
  const group = new THREE.Group()
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xff7a3a, roughness: 0.5 })
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x101826, roughness: 0.6 })

  const hull = new THREE.Mesh(new THREE.BoxGeometry(halfLen * 0.7, 0.34, halfLen * 2), bodyMat)
  hull.position.y = 0.17
  group.add(hull)

  const nose = new THREE.Mesh(new THREE.ConeGeometry(halfLen * 0.36, halfLen * 0.7, 4), bodyMat)
  nose.rotation.x = Math.PI / 2
  nose.rotation.z = Math.PI / 4
  nose.position.set(0, 0.17, halfLen + halfLen * 0.25)
  group.add(nose)

  const rider = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.6), trimMat)
  rider.position.set(0, 0.55, -0.1)
  group.add(rider)

  return group
}

/**
 * A flat `seg × seg` grid spanning `size` meters in the XZ plane, ready to
 * be displaced into a water surface each frame. The base (x, z) of every
 * vertex is cached on `geometry.userData.baseXZ` (a flat [x, z, x, z, …]
 * Float32Array) so the deform loop can resample without reading positions
 * back. Has `position`, `normal`, and `color` attributes.
 */
export function buildWaterGrid(seg: number, size: number): THREE.BufferGeometry {
  const verts = (seg + 1) * (seg + 1)
  const positions = new Float32Array(verts * 3)
  const normals = new Float32Array(verts * 3)
  const colors = new Float32Array(verts * 3)
  const baseXZ = new Float32Array(verts * 2)
  const half = size / 2
  let v = 0
  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++) {
      const x = -half + (i / seg) * size
      const z = -half + (j / seg) * size
      positions[v * 3] = x
      positions[v * 3 + 1] = 0
      positions[v * 3 + 2] = z
      normals[v * 3 + 1] = 1
      baseXZ[v * 2] = x
      baseXZ[v * 2 + 1] = z
      v++
    }
  }
  const indices = new Uint32Array(seg * seg * 6)
  let idx = 0
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i
      const b = a + 1
      const c = a + (seg + 1)
      const d = c + 1
      indices[idx++] = a
      indices[idx++] = c
      indices[idx++] = b
      indices[idx++] = b
      indices[idx++] = c
      indices[idx++] = d
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setIndex(new THREE.BufferAttribute(indices, 1))
  geo.userData.baseXZ = baseXZ
  return geo
}
