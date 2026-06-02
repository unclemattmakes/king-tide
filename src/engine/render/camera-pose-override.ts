/**
 * Dev/test camera pose override.
 *
 * When set, the game loop parks the camera at a fixed world pose (position +
 * look-at target) after the chase camera has ticked, so the chase follow is
 * overridden for the frame. Used by the track screenshot harness
 * (`gen-track-shots.spec.ts`) to frame concept-art beats — set-pieces beside
 * or behind the start line that the forward chase cam never sees.
 *
 * Render-only and dev/test-only: the setter is exposed on `window.__hover`
 * (see `debug.ts`), which production builds don't ship. Setting `null`
 * releases the camera back to the chase pipeline.
 */
export type Vec3 = { x: number; y: number; z: number }
export type CameraPose = { pos: Vec3; target: Vec3 } | null

let pose: CameraPose = null

export function setCameraPoseOverride(next: CameraPose): void {
  pose = next
}

export function getCameraPoseOverride(): CameraPose {
  return pose
}
