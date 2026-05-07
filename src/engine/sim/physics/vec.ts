export type Vec3 = { x: number; y: number; z: number }
export type Quat = { x: number; y: number; z: number; w: number }

/**
 * Rotate a vector by a unit quaternion.
 * v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
 * (Equivalent to v' = q * v * q^(-1).)
 */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  // t = 2 * (q.xyz × v)
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)
  // v' = v + q.w * t + (q.xyz × t)
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}

export function vecLength(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z)
}

export function vecHorizontalLength(v: Vec3): number {
  return Math.hypot(v.x, v.z)
}

export function vecScale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s }
}
