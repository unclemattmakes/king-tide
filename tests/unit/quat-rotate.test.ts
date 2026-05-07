import { describe, expect, it } from 'vitest'
import { quatRotate } from '../../src/engine/sim/physics/vec'

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
