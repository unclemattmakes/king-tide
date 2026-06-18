/**
 * Hand-rolled quaternion / vector helpers for the rider-pose pipeline.
 *
 * INTENDED SHARED HOME: `wave-rider.ts` and `rider-crash.ts` currently
 * hand-roll the same math; this module is the intended place for all of them
 * to converge on (a later pass will adopt it from those files).
 */

import type { Quat, Vec3 } from '@/engine/sim/physics/vec'

export const IDENT_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 }

/** Convert degrees → radians. */
export const D2R = Math.PI / 180

export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

/** Rotate a vector by a unit quaternion. Inlined here for hot-path use. */
export function rotByQuat(q: Quat, vx: number, vy: number, vz: number): Vec3 {
  const tx = 2 * (q.y * vz - q.z * vy)
  const ty = 2 * (q.z * vx - q.x * vz)
  const tz = 2 * (q.x * vy - q.y * vx)
  return {
    x: vx + q.w * tx + (q.y * tz - q.z * ty),
    y: vy + q.w * ty + (q.z * tx - q.x * tz),
    z: vz + q.w * tz + (q.x * ty - q.y * tx),
  }
}

/** Quaternion from axis-angle (axis must be unit). */
export function quatAxisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const h = angle * 0.5
  const s = Math.sin(h)
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(h) }
}

/** Build a quaternion that maps the unit `from` vector onto the unit `to`
 *  vector by the shortest rotation. Used by the arm IK to compute world
 *  bone orientations from "down the bone" target directions. */
export function quatFromTo(from: Vec3, to: Vec3): Quat {
  const d = from.x * to.x + from.y * to.y + from.z * to.z
  if (d > 0.999999) return { x: 0, y: 0, z: 0, w: 1 }
  if (d < -0.999999) {
    // 180° rotation around any axis perpendicular to `from`.
    let ax = -from.y
    let ay = from.x
    let az = 0
    if (Math.hypot(ax, ay) < 1e-6) {
      ax = 0
      ay = -from.z
      az = from.y
    }
    const len = Math.hypot(ax, ay, az)
    return { x: ax / len, y: ay / len, z: az / len, w: 0 }
  }
  const cx = from.y * to.z - from.z * to.y
  const cy = from.z * to.x - from.x * to.z
  const cz = from.x * to.y - from.y * to.x
  const w = 1 + d
  const len = Math.hypot(cx, cy, cz, w)
  return { x: cx / len, y: cy / len, z: cz / len, w: w / len }
}

/** Compose pitch + yaw + roll into a single quaternion. Rotation order:
 *  Y (yaw) → Z (roll) → X (pitch), so q = pitch · roll · yaw. Picked to
 *  match the way "pitch the bone forward, roll it out, twist it" reads
 *  intuitively when scrubbing the sliders in the calibration scene. */
export function quatPYR(pitchDeg: number, yawDeg: number, rollDeg: number): Quat {
  const pitch = quatAxisAngle(1, 0, 0, pitchDeg * D2R)
  const yaw = quatAxisAngle(0, 1, 0, yawDeg * D2R)
  const roll = quatAxisAngle(0, 0, 1, rollDeg * D2R)
  return quatMul(pitch, quatMul(roll, yaw))
}

export function vsub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}
export function vscale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s }
}
export function vlen(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z)
}
export function vnorm(v: Vec3): Vec3 {
  const L = vlen(v)
  if (L < 1e-6) return { x: 0, y: 1, z: 0 }
  return { x: v.x / L, y: v.y / L, z: v.z / L }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
