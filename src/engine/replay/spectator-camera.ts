import * as THREE from 'three'
import { type ChaseCamera, createChaseCamera } from '../render/camera'

/**
 * Spectator camera for replay playback. Two modes:
 *
 * - `chase`: wraps the existing ChaseCamera so the same spring-damped
 *   follow behaviour the player sees during a race is reused for the
 *   spectator. Switching the followed bike just feeds new transforms in.
 *
 * - `orbit`: free third-person camera. Mouse drag rotates yaw/pitch around
 *   the followed bike's position; wheel zooms distance in/out. Useful for
 *   getting hero shots of the recorded run.
 */
export type SpectatorCameraMode = 'chase' | 'orbit'

export type SpectatorCamera = {
  mode: SpectatorCameraMode
  setMode(mode: SpectatorCameraMode): void
  /** Mouse drag in pixels (deltaX, deltaY). Only effective in orbit mode. */
  rotate(dxPx: number, dyPx: number): void
  /** Wheel scroll. Positive zooms out, negative zooms in. */
  zoom(delta: number): void
  /** Snap the camera to the current target — e.g. when switching followed bike. */
  snap(targetPos: THREE.Vector3, targetQuat: THREE.Quaternion): void
  /** Update the camera. Call once per render frame. */
  tick(targetPos: THREE.Vector3, targetQuat: THREE.Quaternion, dt: number): void
  /** Reset orbit yaw/pitch/distance to defaults. */
  resetOrbit(): void
}

const ORBIT_MIN_PITCH = -Math.PI / 2.2
const ORBIT_MAX_PITCH = Math.PI / 2.5
const ORBIT_MIN_DIST = 3
const ORBIT_MAX_DIST = 80
const ORBIT_DEFAULT_DIST = 12
const ORBIT_DEFAULT_PITCH = 0.18
const ORBIT_PIX_TO_RAD = 0.005

export function createSpectatorCamera(camera: THREE.PerspectiveCamera): SpectatorCamera {
  const chase: ChaseCamera = createChaseCamera(camera)

  let mode: SpectatorCameraMode = 'chase'
  let orbitYaw = 0
  let orbitPitch = ORBIT_DEFAULT_PITCH
  let orbitDist = ORBIT_DEFAULT_DIST

  const tmpOffset = new THREE.Vector3()
  const tmpLook = new THREE.Vector3()

  function tickOrbit(targetPos: THREE.Vector3, _targetQuat: THREE.Quaternion, _dt: number) {
    // Spherical offset around the bike. Yaw 0 / pitch 0 puts the camera
    // due north of the target at orbitDist metres, looking at the bike.
    const cosP = Math.cos(orbitPitch)
    const sinP = Math.sin(orbitPitch)
    const cosY = Math.cos(orbitYaw)
    const sinY = Math.sin(orbitYaw)
    tmpOffset.set(orbitDist * cosP * sinY, orbitDist * sinP + 1.2, orbitDist * cosP * cosY)
    tmpLook.copy(targetPos).add(new THREE.Vector3(0, 0.5, 0))
    camera.position.copy(targetPos).add(tmpOffset)
    camera.lookAt(tmpLook)
  }

  return {
    get mode() {
      return mode
    },
    setMode(next) {
      if (mode === next) return
      mode = next
    },
    rotate(dxPx, dyPx) {
      if (mode !== 'orbit') return
      orbitYaw -= dxPx * ORBIT_PIX_TO_RAD
      orbitPitch -= dyPx * ORBIT_PIX_TO_RAD
      if (orbitPitch < ORBIT_MIN_PITCH) orbitPitch = ORBIT_MIN_PITCH
      if (orbitPitch > ORBIT_MAX_PITCH) orbitPitch = ORBIT_MAX_PITCH
    },
    zoom(delta) {
      if (mode !== 'orbit') return
      // Multiplicative so zoom feels symmetric in/out across the dist range.
      orbitDist *= delta > 0 ? 1.1 : 1 / 1.1
      if (orbitDist < ORBIT_MIN_DIST) orbitDist = ORBIT_MIN_DIST
      if (orbitDist > ORBIT_MAX_DIST) orbitDist = ORBIT_MAX_DIST
    },
    snap(targetPos, targetQuat) {
      if (mode === 'chase') {
        chase.snap(targetPos, targetQuat)
      } else {
        tickOrbit(targetPos, targetQuat, 0)
      }
    },
    tick(targetPos, targetQuat, dt) {
      if (mode === 'chase') {
        chase.setOrbit(0, 0)
        chase.tick(targetPos, targetQuat, dt)
      } else {
        tickOrbit(targetPos, targetQuat, dt)
      }
    },
    resetOrbit() {
      orbitYaw = 0
      orbitPitch = ORBIT_DEFAULT_PITCH
      orbitDist = ORBIT_DEFAULT_DIST
    },
  }
}
