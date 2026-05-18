/**
 * Dev settings — runtime-mutable feel knobs for input + camera.
 *
 * The input modules (keyboard.ts, gamepad.ts, camera-look.ts) read these
 * values every tick via the `devSettings` mutable object, so changes from
 * the dev settings menu apply live without a reload. Persisted to
 * localStorage on save; falls back to DEFAULT_DEV_SETTINGS if storage is
 * unavailable or the schema mismatches.
 */

const STORAGE_KEY = 'hoverbike.devSettings.v1'

export type DevSettings = {
  // Camera
  /** Mouse pixels → radians. Higher = more swing per pixel of drag. */
  cameraMouseSens: number
  /** Right-stick fully deflected = how many radians of yaw offset. */
  cameraStickYawRange: number
  /** Right-stick fully deflected = how many radians of pitch offset. */
  cameraStickPitchRange: number
  /** Right-stick magnitude below which the camera ignores input. */
  cameraStickDeadzone: number
  /** When true, dragging mouse up / pushing stick up tilts camera up. */
  cameraInvertY: boolean

  // Gamepad driving
  /** Left-stick magnitude below which steer/pitch read as zero. */
  gamepadDeadzone: number
  /** Power applied to the rescaled-past-deadzone stick magnitude. 1.0 is
   *  linear; 2.0+ is heavily soft-centered. Default ~1.6 reads as modern
   *  racing/flight feel — fine corrections in the center, full authority
   *  at the rim. Shared by gamepad + touch sticks. */
  stickCurve: number

  // Keyboard smoothing — exponential decay rate (1/s).
  // Higher = snappier (less smoothing); lower = more analog-feeling.
  keyboardSteerRate: number
  keyboardThrottleRate: number
  keyboardPitchRate: number

  /** How quickly steer collapses back to zero after the stick / key is
   *  released, on a 0..1 scale where 0 keeps the original heavy decay
   *  (~0.4s time constant — bike keeps turning for a beat) and 1 snaps
   *  to neutral the next frame. Read by `input-apply.ts`; player-only
   *  (AI never goes through that smoothing path). */
  steerReleaseTightness: number
}

export const DEFAULT_DEV_SETTINGS: Readonly<DevSettings> = Object.freeze({
  cameraMouseSens: 0.005,
  cameraStickYawRange: Math.PI * 0.9,
  cameraStickPitchRange: Math.PI / 4,
  cameraStickDeadzone: 0.18,
  cameraInvertY: true,

  gamepadDeadzone: 0.12,
  stickCurve: 1.6,

  keyboardSteerRate: 9,
  keyboardThrottleRate: 10,
  keyboardPitchRate: 8,

  steerReleaseTightness: 0,
})

/**
 * Live-mutable copy of the active settings. Input modules import this
 * object directly; the dev settings menu writes its fields and persists.
 */
export const devSettings: DevSettings = { ...DEFAULT_DEV_SETTINGS }

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

/** Read persisted settings into `devSettings`. Tolerant of missing fields
 *  and of schema drift — anything missing/invalid keeps the default. */
export function loadDevSettings(): void {
  let parsed: unknown
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object') return
  const p = parsed as Record<string, unknown>
  const keys: Array<keyof DevSettings> = [
    'cameraMouseSens',
    'cameraStickYawRange',
    'cameraStickPitchRange',
    'cameraStickDeadzone',
    'gamepadDeadzone',
    'stickCurve',
    'keyboardSteerRate',
    'keyboardThrottleRate',
    'keyboardPitchRate',
    'steerReleaseTightness',
  ]
  for (const k of keys) {
    if (isFiniteNumber(p[k])) (devSettings as Record<string, unknown>)[k] = p[k]
  }
  if (typeof p.cameraInvertY === 'boolean') devSettings.cameraInvertY = p.cameraInvertY
}

export function saveDevSettings(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(devSettings))
  } catch {
    // localStorage unavailable — settings still take effect for this session.
  }
}

export function resetDevSettings(): void {
  Object.assign(devSettings, DEFAULT_DEV_SETTINGS)
  saveDevSettings()
}
