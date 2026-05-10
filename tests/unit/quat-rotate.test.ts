import { describe, expect, it } from 'vitest'
import { distanceSquared, normalize3D, quatRotate } from '../../src/engine/sim/physics/vec'

describe('quatRotate', () => {
  it('identity quat preserves vectors', () => {
    const q = { x: 0, y: 0, z: 0, w: 1 }
    const v = quatRotate(q, { x: 1, y: 2, z: 3 })
    expect(v.x).toBeCloseTo(1, 6)
    expect(v.y).toBeCloseTo(2, 6)
    expect(v.z).toBeCloseTo(3, 6)
  })

  it('90° about Y rotates +Z to +X', () => {
    const q = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }
    const v = quatRotate(q, { x: 0, y: 0, z: 1 })
    expect(v.x).toBeCloseTo(1, 6)
    expect(v.y).toBeCloseTo(0, 6)
    expect(v.z).toBeCloseTo(0, 6)
  })

  it('90° about Y rotates +X to -Z', () => {
    const q = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }
    const v = quatRotate(q, { x: 1, y: 0, z: 0 })
    expect(v.x).toBeCloseTo(0, 6)
    expect(v.z).toBeCloseTo(-1, 6)
  })

  it('180° about Y rotates +Z to -Z', () => {
    const q = { x: 0, y: 1, z: 0, w: 0 }
    const v = quatRotate(q, { x: 0, y: 0, z: 1 })
    expect(v.x).toBeCloseTo(0, 6)
    expect(v.z).toBeCloseTo(-1, 6)
  })

  it('preserves vector length', () => {
    const q = { x: 0.3, y: 0.5, z: 0.2, w: 0.79 } // arbitrary near-unit
    const len = Math.hypot(q.x, q.y, q.z, q.w)
    const qn = { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len }
    const v = { x: 1, y: 2, z: 3 }
    const r = quatRotate(qn, v)
    expect(Math.hypot(r.x, r.y, r.z)).toBeCloseTo(Math.hypot(v.x, v.y, v.z), 5)
  })
})

describe('distanceSquared', () => {
  it('returns 0 for identical points', () => {
    const p = { x: 1, y: 2, z: 3 }
    expect(distanceSquared(p, p)).toBe(0)
  })

  it('matches squared euclidean distance', () => {
    const a = { x: 0, y: 0, z: 0 }
    const b = { x: 3, y: 4, z: 12 } // |b - a| = 13
    expect(distanceSquared(a, b)).toBe(169)
  })

  it('is symmetric', () => {
    const a = { x: -2, y: 7, z: 0.5 }
    const b = { x: 4, y: -1, z: 9 }
    expect(distanceSquared(a, b)).toBeCloseTo(distanceSquared(b, a), 10)
  })
})

describe('normalize3D', () => {
  it('produces a unit vector for non-zero input', () => {
    const v = normalize3D({ x: 3, y: 4, z: 12 })
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 6)
  })

  it('preserves direction', () => {
    const v = normalize3D({ x: 0, y: 0, z: 5 })
    expect(v.x).toBeCloseTo(0, 6)
    expect(v.y).toBeCloseTo(0, 6)
    expect(v.z).toBeCloseTo(1, 6)
  })

  it('returns input unchanged for near-zero vectors', () => {
    const tiny = { x: 1e-9, y: -2e-9, z: 0 }
    const v = normalize3D(tiny)
    expect(v).toBe(tiny)
  })
})
