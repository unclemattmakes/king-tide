import * as THREE from 'three'

/**
 * 3D arrow that floats above the player and yaws to point at the next
 * checkpoint — Crazy Taxi style. Always rendered on top of the world (no
 * depth test) so it stays visible even with the bike's body in the way.
 *
 * Returns { mesh, tick(playerPos, targetPos) }.
 */
export type DirectionArrow = {
  mesh: THREE.Object3D
  tick(playerPos: THREE.Vector3, targetPos: THREE.Vector3 | null, dt: number): void
}

export function createDirectionArrow(): DirectionArrow {
  const group = new THREE.Group()
  group.name = 'direction-arrow'

  const color = 0xffcc44
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    depthWrite: false,
  })

  // Arrowhead — cone, tip along +Z so the whole group can be yawed by Y.
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.8, 12), mat)
  cone.rotation.x = Math.PI / 2
  cone.position.set(0, 0, 1.0)
  group.add(cone)

  // Shaft — short box behind the cone.
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 1.2), mat)
  shaft.position.set(0, 0, -0.5)
  group.add(shaft)

  // Halo — faint disc behind the arrow so the silhouette pops against the sky.
  const haloMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  })
  const halo = new THREE.Mesh(new THREE.CircleGeometry(2.2, 24), haloMat)
  halo.position.set(0, 0, -0.7)
  group.add(halo)

  group.renderOrder = 999
  group.visible = false

  // Floating animation state.
  let tAccum = 0
  let smoothYaw = 0
  let initialised = false

  function tick(playerPos: THREE.Vector3, targetPos: THREE.Vector3 | null, dt: number) {
    if (!targetPos) {
      group.visible = false
      return
    }
    group.visible = true
    tAccum += dt

    // Position above the bike with a gentle bob.
    const bob = Math.sin(tAccum * 2) * 0.15
    group.position.set(playerPos.x, playerPos.y + 5.5 + bob, playerPos.z)

    // Compute target yaw. atan2(dx, dz) so dx=0,dz>0 → yaw 0 (points +Z).
    const dx = targetPos.x - playerPos.x
    const dz = targetPos.z - playerPos.z
    const targetYaw = Math.atan2(dx, dz)

    if (!initialised) {
      smoothYaw = targetYaw
      initialised = true
    } else {
      // Smooth on the shortest-arc, so swings of >180° take the short way around.
      let delta = targetYaw - smoothYaw
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2
      const k = 1 - Math.exp(-dt * 8)
      smoothYaw += delta * k
    }
    group.rotation.y = smoothYaw
  }

  return { mesh: group, tick }
}
