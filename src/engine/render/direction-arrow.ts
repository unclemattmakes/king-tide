import * as THREE from 'three'

/**
 * 3D arrow that hovers in the camera's field of view and yaws to point at
 * the next checkpoint — Crazy Taxi style. Always rendered on top of the
 * world (no depth test) so the bike's body never occludes it.
 *
 * The arrow is anchored to the *camera*, not the bike: a fixed forward
 * distance ahead of the camera with a slight downward offset, so it sits
 * in roughly the same screen real-estate every frame regardless of the
 * bike's pitch/roll. Yaw still uses world-space direction from the player
 * to the target, so it points at where you need to go in the world.
 */
export type DirectionArrow = {
  mesh: THREE.Object3D
  tick(
    camera: THREE.PerspectiveCamera,
    playerPos: THREE.Vector3,
    targetPos: THREE.Vector3 | null,
    dt: number,
  ): void
}

export function createDirectionArrow(): DirectionArrow {
  const group = new THREE.Group()
  group.name = 'direction-arrow'

  const color = 0xffcc44
  // Shaded material so the cone has a clear lit side / shadowed side —
  // a fullbright arrow reads as flat from any angle and you can't tell
  // which way it's pointing. depthTest stays off so it floats over the
  // bike, and a touch of emissive keeps it glowing in the dark side
  // without losing the form.
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.25,
    roughness: 0.55,
    metalness: 0.1,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  })

  // Arrowhead — cone, tip along +Z so the whole group can be yawed by Y.
  // Sizes shrunk vs. the original (~65%) so the arrow occupies less of
  // the screen at the closer camera-relative anchor distance.
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.2, 12), mat)
  cone.rotation.x = Math.PI / 2
  cone.position.set(0, 0, 0.7)
  group.add(cone)

  // Shaft — short box behind the cone.
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.8), mat)
  shaft.position.set(0, 0, -0.3)
  group.add(shaft)

  group.renderOrder = 999
  group.visible = false

  // Floating animation state.
  let tAccum = 0
  let smoothYaw = 0
  let initialised = false

  // Scratch vectors to keep tick() allocation-free.
  const camForward = new THREE.Vector3()
  const anchor = new THREE.Vector3()

  // Camera-relative anchor: how far ahead of the camera along its
  // horizontal forward to place the arrow, and how far below its
  // optical centre (down in world space). Tuned so the arrow sits
  // around the lower-third of the frame at the default chase camera —
  // visible without covering the racing line.
  const ANCHOR_FORWARD = 7
  const ANCHOR_DOWN = 1.6

  function tick(
    camera: THREE.PerspectiveCamera,
    playerPos: THREE.Vector3,
    targetPos: THREE.Vector3 | null,
    dt: number,
  ) {
    if (!targetPos) {
      group.visible = false
      return
    }
    group.visible = true
    tAccum += dt

    // Anchor in front of and just below the camera. Forward is taken from
    // the camera's view direction with Y zeroed so a pitch tilt doesn't
    // walk the arrow up or down the screen between frames.
    camera.getWorldDirection(camForward)
    camForward.y = 0
    if (camForward.lengthSq() < 1e-6) camForward.set(0, 0, 1)
    else camForward.normalize()

    const bob = Math.sin(tAccum * 2) * 0.12
    anchor
      .copy(camera.position)
      .addScaledVector(camForward, ANCHOR_FORWARD)
    anchor.y -= ANCHOR_DOWN - bob
    group.position.copy(anchor)

    // Yaw uses world-space direction from the *player* to the target so
    // the arrow indicates the bike's heading correction, not the
    // camera's. atan2(dx, dz) so dx=0,dz>0 → yaw 0 (points +Z).
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
