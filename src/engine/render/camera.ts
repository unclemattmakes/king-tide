import * as THREE from 'three'

/**
 * Spring-damped chase camera with optional orbit. Sits behind+above the
 * target in target-local space; orbit yaw/pitch lets the player look around
 * by dragging the mouse or pushing the right stick.
 */
export type ChaseCamera = {
  tick(targetPos: THREE.Vector3, targetQuat: THREE.Quaternion, dt: number): void
  /** Snap immediately to the goal — useful on respawn. */
  snap(targetPos: THREE.Vector3, targetQuat: THREE.Quaternion): void
  /** Set orbit target (radians). Camera will smoothly converge there. */
  setOrbit(yaw: number, pitch: number): void
}

export function createChaseCamera(camera: THREE.PerspectiveCamera): ChaseCamera {
  // Closer + slightly lower than the pre-2× bike framing. The bike visual
  // is now 2× scale (see render-systems.ts); halving the chase distance
  // keeps the bike from shrinking on screen and tightens the framing.
  const idealOffset = new THREE.Vector3(0, 2.5, -5.5)
  const idealLookAhead = new THREE.Vector3(0, 1.0, 6)
  const damping = 6
  const orbitDamping = 10

  const goalPos = new THREE.Vector3()
  const goalLook = new THREE.Vector3()
  const currentLook = new THREE.Vector3()
  let initialized = false

  let orbitYawTarget = 0
  let orbitPitchTarget = 0
  let orbitYaw = 0
  let orbitPitch = 0

  const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ')
  const tmpOffset = new THREE.Vector3()
  const yawQuat = new THREE.Quaternion()

  function compute(targetPos: THREE.Vector3, targetQuat: THREE.Quaternion) {
    // Yaw-only frame for the chase camera. Player-driven pitch/roll on the
    // bike (and surface-alignment pitch from waves/ramps) shouldn't swing
    // the camera around — that reads as motion sickness and makes the
    // bike look jittery on chop. Camera still follows bike position
    // (which inherits surface-driven Y bobbing), so terrain follow reads
    // smoothly. Yaw is extracted as Math.atan2(2(xz+yw), 1−2(x²+y²)).
    const qx = targetQuat.x
    const qy = targetQuat.y
    const qz = targetQuat.z
    const qw = targetQuat.w
    const yaw = Math.atan2(2 * (qx * qz + qy * qw), 1 - 2 * (qx * qx + qy * qy))
    const halfYaw = yaw * 0.5
    yawQuat.set(0, Math.sin(halfYaw), 0, Math.cos(halfYaw))

    tmpEuler.set(orbitPitch, orbitYaw, 0, 'YXZ')
    tmpOffset.copy(idealOffset).applyEuler(tmpEuler).applyQuaternion(yawQuat)
    goalPos.copy(tmpOffset).add(targetPos)
    goalLook.copy(idealLookAhead).applyQuaternion(yawQuat).add(targetPos)
  }

  return {
    setOrbit(yaw, pitch) {
      orbitYawTarget = yaw
      // Clamp pitch to a sane range — slight downward / mild upward.
      orbitPitchTarget = Math.max(-Math.PI / 3, Math.min(Math.PI / 5, pitch))
    },
    tick(targetPos, targetQuat, dt) {
      // Lerp orbit toward target.
      const ot = 1 - Math.exp(-dt * orbitDamping)
      orbitYaw += (orbitYawTarget - orbitYaw) * ot
      orbitPitch += (orbitPitchTarget - orbitPitch) * ot

      compute(targetPos, targetQuat)
      if (!initialized) {
        camera.position.copy(goalPos)
        currentLook.copy(goalLook)
        initialized = true
      } else {
        const t = 1 - Math.exp(-dt * damping)
        camera.position.lerp(goalPos, t)
        currentLook.lerp(goalLook, t)
      }
      camera.lookAt(currentLook)
    },
    snap(targetPos, targetQuat) {
      compute(targetPos, targetQuat)
      camera.position.copy(goalPos)
      currentLook.copy(goalLook)
      camera.lookAt(currentLook)
      initialized = true
    },
  }
}
