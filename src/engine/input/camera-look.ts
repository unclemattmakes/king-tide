/**
 * Camera-look input: mouse right-drag and gamepad right-stick produce
 * (yaw, pitch) in radians, relative to the bike's chase position.
 *
 * - Mouse: hold right button and drag. Accumulates with sensitivity.
 * - Gamepad: right stick (axes[2], axes[3]) maps to absolute target offsets.
 *   Stick wins over mouse when active.
 * - When neither input is active, target decays back to (0, 0) so the
 *   camera returns to the default chase position automatically.
 *
 * Sensitivity / range / deadzone are read from `devSettings`; the
 * X / Y invert knobs are player-facing (Controls tab → "Invert camera
 * X" / "Invert camera Y").
 */

import { devSettings } from '../dev-settings'
import { playerSettings } from '../player-settings'

const RETURN_RATE = 3 // exponential decay coefficient when no input

export type CameraLookState = {
  yaw: number
  pitch: number
}

let yaw = 0
let pitch = 0

let mouseDragging = false
let lastMouseX = 0
let lastMouseY = 0

export function installCameraLookInput(): void {
  window.addEventListener('mousedown', (e) => {
    if (e.button === 2) {
      mouseDragging = true
      lastMouseX = e.clientX
      lastMouseY = e.clientY
      e.preventDefault()
    }
  })
  // Suppress right-click menu so drag works.
  window.addEventListener('contextmenu', (e) => {
    if (mouseDragging) e.preventDefault()
  })
  window.addEventListener('mouseup', (e) => {
    if (e.button === 2) mouseDragging = false
  })
  window.addEventListener('mousemove', (e) => {
    if (!mouseDragging) return
    const sens = devSettings.cameraMouseSens
    // Invert horizontal: flips the drag→yaw direction. Default (false)
    // keeps the shipped "drag right pans the view right" feel.
    const xSign = playerSettings.invertCameraX ? -1 : 1
    yaw += (e.clientX - lastMouseX) * sens * xSign
    // Invert vertical (default): dragging mouse UP raises the camera. Dev
    // settings menu can flip this — when not inverted, dragging up looks down.
    const ySign = playerSettings.invertCameraY ? 1 : -1
    pitch += (e.clientY - lastMouseY) * sens * ySign
    lastMouseX = e.clientX
    lastMouseY = e.clientY
  })
  window.addEventListener('blur', () => {
    mouseDragging = false
  })
}

/** Per-frame: read inputs, advance camera-look state, return current (yaw, pitch). */
export function tickCameraLook(dt: number): CameraLookState {
  const pad = navigator.getGamepads?.()?.[0]
  const stickX = pad?.axes[2] ?? 0
  const stickY = pad?.axes[3] ?? 0
  const dz = devSettings.cameraStickDeadzone
  const stickActive = Math.abs(stickX) > dz || Math.abs(stickY) > dz

  if (stickActive) {
    // Base sign negates X so pushing the stick right orbits the view
    // right. Push (stick) and grab-and-drag (mouse) have opposite
    // natural directions, so the stick's default sign is the inverse of
    // the drag handler's — but the Invert-camera-X knob flips both.
    const xSign = playerSettings.invertCameraX ? 1 : -1
    yaw = stickX * devSettings.cameraStickYawRange * xSign
    // Invert vertical (default): pushing stick UP raises the camera.
    const ySign = playerSettings.invertCameraY ? 1 : -1
    pitch = stickY * devSettings.cameraStickPitchRange * ySign
  } else if (!mouseDragging) {
    // Decay back to zero.
    const k = Math.exp(-dt * RETURN_RATE)
    yaw *= k
    pitch *= k
  }

  return { yaw, pitch }
}
