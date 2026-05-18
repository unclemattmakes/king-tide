/**
 * Anti-grav camera follow + intensity scalar.
 *
 * Owns the chase-camera half of the anti-grav definition-of-done:
 * `setAntiGravFollow(weight)` blends the camera between yaw-only
 * (weight=0, default) and full bike-frame follow (weight=1). The
 * player-facing intensity scalar (`ANTI_GRAV_CAMERA_SCALAR`) is
 * multiplied onto the live override weight upstream, so e.g. an "off"
 * intensity collapses the chase camera back to yaw-only even mid-loop.
 */

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  ANTI_GRAV_CAMERA_SCALAR,
  DEFAULT_PLAYER_SETTINGS,
  loadPlayerSettings,
  playerSettings,
  setAntiGravCameraIntensity,
} from '../../src/engine/player-settings'
import { createChaseCamera } from '../../src/engine/render/camera'

function resetPlayerSettings(): void {
  playerSettings.wavePumpIntensity = DEFAULT_PLAYER_SETTINGS.wavePumpIntensity
  playerSettings.aiDifficulty = DEFAULT_PLAYER_SETTINGS.aiDifficulty
  playerSettings.rubberBandAssist = DEFAULT_PLAYER_SETTINGS.rubberBandAssist
  playerSettings.antiGravCameraIntensity = DEFAULT_PLAYER_SETTINGS.antiGravCameraIntensity
}

describe('ANTI_GRAV_CAMERA_SCALAR', () => {
  it('full=1, reduced<full, off=0', () => {
    expect(ANTI_GRAV_CAMERA_SCALAR.full).toBe(1)
    expect(ANTI_GRAV_CAMERA_SCALAR.off).toBe(0)
    expect(ANTI_GRAV_CAMERA_SCALAR.reduced).toBeGreaterThan(0)
    expect(ANTI_GRAV_CAMERA_SCALAR.reduced).toBeLessThan(1)
  })
})

describe('setAntiGravCameraIntensity', () => {
  it('round-trips via localStorage with the other player settings', () => {
    if (typeof window === 'undefined' || !window.localStorage) return
    try {
      window.localStorage.removeItem('hoverbike.playerSettings.v1')
      setAntiGravCameraIntensity('reduced')
      expect(playerSettings.antiGravCameraIntensity).toBe('reduced')
      // Wipe in-memory + reload from storage.
      playerSettings.antiGravCameraIntensity = 'full'
      loadPlayerSettings()
      expect(playerSettings.antiGravCameraIntensity).toBe('reduced')
    } finally {
      window.localStorage.removeItem('hoverbike.playerSettings.v1')
      resetPlayerSettings()
    }
  })
})

describe('createChaseCamera anti-grav follow', () => {
  it('keeps the yaw-only frame when follow weight is 0', () => {
    const camera = new THREE.PerspectiveCamera()
    const chase = createChaseCamera(camera)
    // Bike rolled 90° about Z (right side down) — yaw-only frame
    // should be unaffected by the roll.
    const pos = new THREE.Vector3(0, 0, 0)
    const rollQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI / 2,
    )
    chase.setAntiGravFollow(0)
    chase.snap(pos, rollQuat)
    // Yaw-only frame: ideal offset (0, 2.5, -5.5) — camera should land
    // at +y above the origin regardless of bike roll.
    expect(camera.position.y).toBeGreaterThan(1.5)
    expect(camera.position.y).toBeLessThan(3.5)
  })

  it('follows the bike full-frame when follow weight is 1', () => {
    const camera = new THREE.PerspectiveCamera()
    const chase = createChaseCamera(camera)
    // Bike rolled 90° about Z (right side down). With full follow the
    // camera's "above the bike" offset should swing to the bike's new
    // up direction — which after a +90° roll about Z points along +X.
    const pos = new THREE.Vector3(0, 0, 0)
    const rollQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI / 2,
    )
    chase.setAntiGravFollow(1)
    chase.snap(pos, rollQuat)
    // After a +90° Z roll, the original (0, +y) offset rotates to (-y,
    // 0) — so the camera lands at negative X with near-zero Y.
    expect(Math.abs(camera.position.y)).toBeLessThan(1.5)
    expect(camera.position.x).toBeLessThan(-1.0)
  })

  it('snap() catches up the follow weight (no slide-in after respawn)', () => {
    const camera = new THREE.PerspectiveCamera()
    const chase = createChaseCamera(camera)
    chase.setAntiGravFollow(1)
    const pos = new THREE.Vector3(0, 0, 0)
    const rollQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI / 2,
    )
    // snap should jump to the full-follow goal in a single call (vs.
    // tick() which would lerp follow over ~150ms).
    chase.snap(pos, rollQuat)
    const xAfterSnap = camera.position.x
    expect(xAfterSnap).toBeLessThan(-1.0)
  })

  it('blends between yaw-only and full frame proportionally', () => {
    const camera = new THREE.PerspectiveCamera()
    const chase = createChaseCamera(camera)
    const pos = new THREE.Vector3(0, 0, 0)
    const rollQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI / 2,
    )

    chase.setAntiGravFollow(0)
    chase.snap(pos, rollQuat)
    const xYawOnly = camera.position.x

    chase.setAntiGravFollow(0.5)
    chase.snap(pos, rollQuat)
    const xHalf = camera.position.x

    chase.setAntiGravFollow(1)
    chase.snap(pos, rollQuat)
    const xFull = camera.position.x

    // Half-weight should sit between the two extremes.
    expect(xHalf).toBeLessThan(xYawOnly)
    expect(xHalf).toBeGreaterThan(xFull)
  })
})
