import * as THREE from 'three'

/**
 * Spring-damped chase camera. Sits behind+above the target in the target's
 * local space, looks slightly ahead of it. Smooths to its goal each frame.
 */
export type ChaseCamera = {
  tick(targetPos: THREE.Vector3, targetQuat: THREE.Quaternion, dt: number): void
  /** Snap immediately to the goal — useful on respawn. */
  snap(targetPos: THREE.Vector3, targetQuat: THREE.Quaternion): void
}

export function createChaseCamera(camera: THREE.PerspectiveCamera): ChaseCamera {
  // Local-space offsets relative to the bike's orientation.
  const idealOffset = new THREE.Vector3(0, 3.0, -7.5)
  const idealLookAhead = new THREE.Vector3(0, 0.5, 6)
  const damping = 6 // higher = stiffer

  const goalPos = new THREE.Vector3()
  const goalLook = new THREE.Vector3()
  const currentLook = new THREE.Vector3()
  let initialized = false

  function compute(targetPos: THREE.Vector3, targetQuat: THREE.Quaternion) {
    goalPos.copy(idealOffset).applyQuaternion(targetQuat).add(targetPos)
    goalLook.copy(idealLookAhead).applyQuaternion(targetQuat).add(targetPos)
  }

  return {
    tick(targetPos, targetQuat, dt) {
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
