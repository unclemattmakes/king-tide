/**
 * Camera-look input: mouse right-drag and gamepad right-stick produce
 * (yaw, pitch) in radians, relative to the bike's chase position.
 *
 * - Mouse: hold right button and drag. Accumulates with sensitivity.
 * - Gamepad: right stick (axes[2], axes[3]) maps to absolute target offsets.
 *   Stick wins over mouse when active.
 * - When neither input is active, target decays back to (0, 0) so the
 *   camera returns to the default chase position automatically.
 */

const MOUSE_SENS = 0.005
const STICK_DEADZONE = 0.18
const STICK_YAW_RANGE = Math.PI * 0.9 // almost full 180° each side
const STICK_PITCH_RANGE = Math.PI / 4
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
    yaw += (e.clientX - lastMouseX) * MOUSE_SENS
    // Invert vertical: dragging mouse UP raises the camera (looks down at bike).
    pitch -= (e.clientY - lastMouseY) * MOUSE_SENS
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
  const stickActive = Math.abs(stickX) > STICK_DEADZONE || Math.abs(stickY) > STICK_DEADZONE

  if (stickActive) {
    yaw = stickX * STICK_YAW_RANGE
    // Invert vertical: pushing stick up raises the camera (looks down at bike).
    pitch = -stickY * STICK_PITCH_RANGE
  } else if (!mouseDragging) {
    // Decay back to zero.
    const k = Math.exp(-dt * RETURN_RATE)
    yaw *= k
    pitch *= k
  }

  return { yaw, pitch }
}
