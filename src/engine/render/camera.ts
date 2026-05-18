import * as THREE from 'three'

/**
 * Spring-damped chase camera with optional orbit. Sits behind+above the
 * target in target-local space; orbit yaw/pitch lets the player look around
 * by dragging the mouse or pushing the right stick.
 *
 * Default frame is yaw-only — bike pitch/roll from waves and ramps shouldn't
 * swing the camera around (motion sickness, jittery feel). Anti-grav
 * sections opt in to a fuller follow via `setAntiGravFollow(weight)`:
 * weight 0 = pure yaw-only (default), weight 1 = full bike-frame
 * follow (camera rolls + pitches with the bike, so a loop reads as a
 * loop). The caller (game-loop) computes `weight = override.weight *
 * intensityScalar` where intensityScalar comes from the player's
 * Settings → Gameplay → "Anti-grav camera intensity" choice.
 */
export type ChaseCamera = {
  tick(targetPos: THREE.Vector3, targetQuat: THREE.Quaternion, dt: number): void
  /** Snap immediately to the goal — useful on respawn. */
  snap(targetPos: THREE.Vector3, targetQuat: THREE.Quaternion): void
  /** Set orbit target (radians). Camera will smoothly converge there. */
  setOrbit(yaw: number, pitch: number): void
  /** Set the anti-grav follow weight ∈ [0,1]. 0 = yaw-only (default),
   *  1 = full bike-frame follow. The internal value lerps toward this
   *  on the same time-constant as the rest of the camera so flipping
   *  the player setting mid-anti-grav doesn't snap. */
  setAntiGravFollow(weight: number): void
}

/** Time constant for the follow-weight smoothing. Matches the
 *  AntiGravOverride's own up-vector smoothing so the camera frame
 *  doesn't lead or lag the bike's gravity blend. */
const FOLLOW_SMOOTH_TAU = 0.15

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

  let followTarget = 0
  let follow = 0

  const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ')
  const tmpOffset = new THREE.Vector3()
  const tmpOffsetFull = new THREE.Vector3()
  const tmpLookFull = new THREE.Vector3()
  const yawQuat = new THREE.Quaternion()

  function compute(targetPos: THREE.Vector3, targetQuat: THREE.Quaternion) {
    // Yaw-only frame for the chase camera — the steady-state default.
    // Yaw is extracted as Math.atan2(2(xz+yw), 1−2(x²+y²)).
    const qx = targetQuat.x
    const qy = targetQuat.y
    const qz = targetQuat.z
    const qw = targetQuat.w
    const yaw = Math.atan2(2 * (qx * qz + qy * qw), 1 - 2 * (qx * qx + qy * qy))
    const halfYaw = yaw * 0.5
    yawQuat.set(0, Math.sin(halfYaw), 0, Math.cos(halfYaw))

    tmpEuler.set(orbitPitch, orbitYaw, 0, 'YXZ')

    // Yaw-only goal: offset + look-ahead rotated by the bike's yaw only.
    tmpOffset.copy(idealOffset).applyEuler(tmpEuler).applyQuaternion(yawQuat)
    goalPos.copy(tmpOffset).add(targetPos)
    goalLook.copy(idealLookAhead).applyQuaternion(yawQuat).add(targetPos)

    if (follow > 0.001) {
      // Full-frame goal: rotate by the bike's full quaternion (roll +
      // pitch + yaw). The camera follows the bike's "up" — on a banked
      // wall or upside-down loop the seat-of-the-pants view rotates
      // with the bike, exactly what the anti-grav signature mechanic
      // is supposed to feel like.
      tmpOffsetFull.copy(idealOffset).applyEuler(tmpEuler).applyQuaternion(targetQuat)
      tmpLookFull.copy(idealLookAhead).applyQuaternion(targetQuat)
      // Blend the two goals by the live follow weight (lerped toward
      // followTarget on the FOLLOW_SMOOTH_TAU time constant).
      goalPos.lerp(tmpOffsetFull.add(targetPos), follow)
      goalLook.lerp(tmpLookFull.add(targetPos), follow)
    }
  }

  return {
    setOrbit(yaw, pitch) {
      orbitYawTarget = yaw
      // Clamp pitch to a sane range — slight downward / mild upward.
      orbitPitchTarget = Math.max(-Math.PI / 3, Math.min(Math.PI / 5, pitch))
    },
    setAntiGravFollow(weight) {
      followTarget = Math.max(0, Math.min(1, weight))
    },
    tick(targetPos, targetQuat, dt) {
      // Lerp orbit + follow toward their targets.
      const ot = 1 - Math.exp(-dt * orbitDamping)
      orbitYaw += (orbitYawTarget - orbitYaw) * ot
      orbitPitch += (orbitPitchTarget - orbitPitch) * ot
      const ft = 1 - Math.exp(-dt / FOLLOW_SMOOTH_TAU)
      follow += (followTarget - follow) * ft

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
      // Snap also catches up the follow weight so a respawn mid-anti-grav
      // doesn't slide into the follow over the next 150ms.
      follow = followTarget
      compute(targetPos, targetQuat)
      camera.position.copy(goalPos)
      currentLook.copy(goalLook)
      camera.lookAt(currentLook)
      initialized = true
    },
  }
}
