export type Vec3 = { x: number; y: number; z: number }
export type Quat = { x: number; y: number; z: number; w: number }

/** Rotate a vector by a quaternion. q must be unit-length. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  // v' = q * v * q^-1
  // Using the standard formula expanded for performance:
  const x = q.x
  const y = q.y
  const z = q.z
  const w = q.w
  const ix = w * v.x + y * v.z - z * v.y
  const iy = w * v.y + z * v.x - x * v.z
  const iz = w * v.z + x * v.y - y * v.x
  const iw = -x * v.x - y * v.y - z * v.z
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
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
