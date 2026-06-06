import * as THREE from 'three'
import {
  type BikePose,
  type BroadcastDirector,
  createBroadcastDirector,
} from '../render/broadcast-director'
import { type ChaseCamera, createChaseCamera } from '../render/camera'

/**
 * Spectator camera for replay playback. Three modes:
 *
 * - `chase`: wraps the existing ChaseCamera so the same spring-damped
 *   follow behaviour the player sees during a race is reused for the
 *   spectator. Switching the followed bike just feeds new transforms in.
 *
 * - `orbit`: free third-person camera. Mouse drag rotates yaw/pitch around
 *   the followed bike's position; wheel zooms distance in/out. Useful for
 *   getting hero shots of the recorded run.
 *
 * - `auto`: broadcast-director mode. Cycles cinematic camera shots over
 *   the field on a timer — chase, side, low, crane, orbit, hero — and
 *   picks a new bike to focus on between cuts. This is the default mode
 *   for replay so saved races feel like a live TV broadcast. The HUD's
 *   FOLLOW pills still work in chase/orbit; in auto the director picks.
 */
export type SpectatorCameraMode = 'chase' | 'orbit' | 'auto'

export type SpectatorCamera = {
  mode: SpectatorCameraMode
  setMode(mode: SpectatorCameraMode): void
  /** Mouse drag in pixels (deltaX, deltaY). Only effective in orbit mode. */
  rotate(dxPx: number, dyPx: number): void
  /** Wheel scroll. Positive zooms out, negative zooms in. */
  zoom(delta: number): void
  /** Snap the camera to the current target — e.g. when switching followed bike. */
  snap(targetPos: THREE.Vector3, targetQuat: THREE.Quaternion): void
  /** Update the camera. Call once per render frame.
   *  `allPoses` is only consulted in `auto` mode — chase/orbit use the
   *  followed bike's pose alone. */
  tick(
    targetPos: THREE.Vector3,
    targetQuat: THREE.Quaternion,
    dt: number,
    allPoses?: ReadonlyArray<BikePose>,
  ): void
  /** Reset orbit yaw/pitch/distance to defaults. */
  resetOrbit(): void
  /** Force the broadcast director to cut on its next frame.
   *  No-op outside `auto` mode. */
  cutAuto(): void
  /** Currently followed bike id when in `auto` mode, or `null` if no
   *  cut has happened yet (or not in auto). The HUD reads this to draw
   *  the lower-third tag for the right rider. */
  getAutoFocusId(): number | null
  /** Most-recent director shot label, used by the HUD. */
  getAutoShotLabel(): string | null
}

const ORBIT_MIN_PITCH = -Math.PI / 2.2
const ORBIT_MAX_PITCH = Math.PI / 2.5
const ORBIT_MIN_DIST = 3
const ORBIT_MAX_DIST = 80
// Default hero-orbit distance, pulled in for the 1× bike (half its old
// on-screen size): 12 × 0.6 ≈ the framing the old 2× bike got at 12. Matches
// broadcast-director's BIKE_SCALE_PULL_IN; the user can still zoom freely.
const ORBIT_DEFAULT_DIST = 7.2
const ORBIT_DEFAULT_PITCH = 0.18
const ORBIT_PIX_TO_RAD = 0.005

export function createSpectatorCamera(camera: THREE.PerspectiveCamera): SpectatorCamera {
  const chase: ChaseCamera = createChaseCamera(camera)
  const director: BroadcastDirector = createBroadcastDirector({ camera })

  let mode: SpectatorCameraMode = 'auto'
  let orbitYaw = 0
  let orbitPitch = ORBIT_DEFAULT_PITCH
  let orbitDist = ORBIT_DEFAULT_DIST

  const tmpOffset = new THREE.Vector3()
  const tmpLook = new THREE.Vector3()

  function tickOrbit(targetPos: THREE.Vector3, _targetQuat: THREE.Quaternion, _dt: number) {
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
      // Force a re-snap on next tick in chase/orbit; in auto, command a
      // fresh cut so the operator-style transition kicks in immediately.
      if (next === 'auto') director.cut()
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
      orbitDist *= delta > 0 ? 1.1 : 1 / 1.1
      if (orbitDist < ORBIT_MIN_DIST) orbitDist = ORBIT_MIN_DIST
      if (orbitDist > ORBIT_MAX_DIST) orbitDist = ORBIT_MAX_DIST
    },
    snap(targetPos, targetQuat) {
      if (mode === 'chase') {
        chase.snap(targetPos, targetQuat)
      } else if (mode === 'orbit') {
        tickOrbit(targetPos, targetQuat, 0)
      } else {
        // Auto: director snaps on its next tick.
        director.cut()
      }
    },
    tick(targetPos, targetQuat, dt, allPoses) {
      if (mode === 'chase') {
        chase.setOrbit(0, 0)
        chase.tick(targetPos, targetQuat, dt)
      } else if (mode === 'orbit') {
        tickOrbit(targetPos, targetQuat, dt)
      } else if (allPoses && allPoses.length > 0) {
        director.tick(allPoses, dt)
      }
    },
    resetOrbit() {
      orbitYaw = 0
      orbitPitch = ORBIT_DEFAULT_PITCH
      orbitDist = ORBIT_DEFAULT_DIST
    },
    cutAuto() {
      if (mode === 'auto') director.cut()
    },
    getAutoFocusId() {
      return mode === 'auto' ? director.getFocusId() : null
    },
    getAutoShotLabel() {
      if (mode !== 'auto') return null
      return director.getCurrentShot().kind
    },
  }
}
