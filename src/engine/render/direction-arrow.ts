import * as THREE from 'three'

/**
 * 3D arrow that hovers in the camera's field of view and yaws to point at
 * the next checkpoint — Crazy Taxi style. Always rendered on top of the
 * world (no depth test) so the bike's body never occludes it.
 *
 * The arrow is anchored to the *camera*, not the bike: a fixed forward
 * distance ahead of the camera and an upward offset sized to the vertical
 * FOV so it projects to the upper band of the screen, clear of the bike's
 * silhouette. Yaw uses world-space direction from the player to the target.
 *
 * Readability: the arrow body is **raked nose-down** (pitched toward the
 * world) inside a child group, so even when the next gate is dead ahead —
 * and the world-yaw points the arrow directly away from the camera — the
 * chase cam sees the arrow's top + flank at a 3/4 angle instead of staring
 * down the flat base of a cone (which read as a faceted gold disc / "sun").
 * The yaw still happens on the outer group about world-up, so the rake
 * stays consistent as the arrow swings to point left / right / back.
 */
export type DirectionArrow = {
  mesh: THREE.Object3D
  /** Hide / show the arrow wholesale (Settings + the screenshot harness).
   *  When disabled, `tick` keeps it invisible regardless of target. */
  setEnabled(on: boolean): void
  isEnabled(): boolean
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

  // Raked child so the whole arrow tips nose-down toward the world. The
  // outer group only yaws (about world-up); this inner group owns the
  // constant downward pitch so the camera always sees a 3/4 read — never
  // the flat base of the cone (which read as a faceted "sun"). ~26° is
  // enough to break the head-on case without reading as "straight down".
  const tilt = new THREE.Group()
  tilt.rotation.x = THREE.MathUtils.degToRad(26)
  group.add(tilt)

  const color = 0xffd23f // warm amber — the Circuit way-marker
  // Shaded material so the cone has a clear lit side / shadowed side —
  // a fullbright arrow reads as flat from any angle and you can't tell
  // which way it's pointing. depthTest stays off so it floats over the
  // bike; a touch of emissive keeps it glowing on the shadowed flank
  // without losing the form.
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.22,
    roughness: 0.5,
    metalness: 0.1,
    transparent: true,
    opacity: 0.96,
    depthTest: false,
    depthWrite: false,
  })

  // Arrowhead — cone, tip along +Z so the group yaws by Y to point. 24
  // radial segments (was 12) so the base never reads as a chunky hexagon
  // even glimpsed head-on; leaner + longer than before so the silhouette
  // says "arrow", not "lozenge".
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.46, 1.3, 24), mat)
  cone.rotation.x = Math.PI / 2
  cone.position.set(0, 0, 0.7)
  tilt.add(cone)

  // Shaft — slim box behind the cone.
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.9), mat)
  shaft.position.set(0, 0, -0.35)
  tilt.add(shaft)

  group.renderOrder = 999
  group.visible = false

  // Floating animation state.
  let tAccum = 0
  let smoothYaw = 0
  let initialised = false
  let enabled = true

  // Scratch vectors to keep tick() allocation-free.
  const camForward = new THREE.Vector3()
  const camUp = new THREE.Vector3()
  const anchor = new THREE.Vector3()
  const LOCAL_UP = new THREE.Vector3(0, 1, 0)

  // Camera-relative anchor: distance ahead of the camera along its
  // forward axis, and a target screen-space vertical position expressed
  // in NDC (-1 bottom, +1 top). 0.6 sits the arrow in the upper third —
  // prominent, but BELOW the top-center lap-timer slab it used to hide
  // behind at 0.8.
  const ANCHOR_FORWARD = 7
  const ANCHOR_NDC_Y = 0.6

  function tick(
    camera: THREE.PerspectiveCamera,
    playerPos: THREE.Vector3,
    targetPos: THREE.Vector3 | null,
    dt: number,
  ) {
    if (!enabled || !targetPos) {
      group.visible = false
      return
    }
    group.visible = true
    tAccum += dt

    // Use the camera's full local forward + up so the arrow stays locked
    // to the same screen position regardless of camera pitch/roll. The
    // vertical offset is derived from the camera's vertical FOV so the
    // arrow projects to NDC y = ANCHOR_NDC_Y at any focal length.
    camera.getWorldDirection(camForward)
    camUp.copy(LOCAL_UP).applyQuaternion(camera.quaternion)

    const halfHeight = ANCHOR_FORWARD * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
    const upOffset = halfHeight * ANCHOR_NDC_Y
    const bob = Math.sin(tAccum * 2) * 0.12
    anchor
      .copy(camera.position)
      .addScaledVector(camForward, ANCHOR_FORWARD)
      .addScaledVector(camUp, upOffset + bob)
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

  return {
    mesh: group,
    setEnabled: (on: boolean) => {
      enabled = on
      if (!on) group.visible = false
    },
    isEnabled: () => enabled,
    tick,
  }
}
