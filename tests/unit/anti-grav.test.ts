import { describe, expect, it } from 'vitest'
import {
  findContainingZone,
  isInsideAntiGravZone,
  zoneUpVector,
} from '../../src/game/systems/anti-grav'
import type { AntiGravZone } from '../../src/game/tracks/types'

function axisAlignedZone(
  pos: { x: number; y: number; z: number },
  halfWidth = 8,
  halfHeight = 5,
  halfDepth = 12,
): AntiGravZone {
  return {
    position: pos,
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    halfWidth,
    halfHeight,
    halfDepth,
  }
}

describe('isInsideAntiGravZone', () => {
  it('detects center overlap on an axis-aligned zone', () => {
    const z = axisAlignedZone({ x: 10, y: 4, z: 20 })
    expect(isInsideAntiGravZone({ x: 10, y: 4, z: 20 }, z)).toBe(true)
  })

  it('rejects points outside any extent', () => {
    const z = axisAlignedZone({ x: 0, y: 0, z: 0 }, 8, 5, 12)
    expect(isInsideAntiGravZone({ x: 8.5, y: 0, z: 0 }, z)).toBe(false)
    expect(isInsideAntiGravZone({ x: 0, y: 5.5, z: 0 }, z)).toBe(false)
    expect(isInsideAntiGravZone({ x: 0, y: 0, z: 12.5 }, z)).toBe(false)
  })

  it('is inclusive at exact half-extents', () => {
    const z = axisAlignedZone({ x: 0, y: 0, z: 0 }, 8, 5, 12)
    expect(isInsideAntiGravZone({ x: 8, y: 5, z: 12 }, z)).toBe(true)
    expect(isInsideAntiGravZone({ x: -8, y: -5, z: -12 }, z)).toBe(true)
  })

  it('respects orientation — a 90° yaw swaps local X and Z onto world Z and -X', () => {
    // 90° rotation around Y: local +Z aligns to world +X, local +X to world -Z.
    const z: AntiGravZone = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
      halfWidth: 4,
      halfHeight: 3,
      halfDepth: 10,
    }
    // 9 m along world +X = 9 m along local +Z — within halfDepth (10).
    expect(isInsideAntiGravZone({ x: 9, y: 0, z: 0 }, z)).toBe(true)
    // 9 m along world +Z = 9 m along local -X — |9| > halfWidth (4), out.
    expect(isInsideAntiGravZone({ x: 0, y: 0, z: 9 }, z)).toBe(false)
  })
})

describe('zoneUpVector', () => {
  it('returns world +Y for an unrotated zone', () => {
    const z = axisAlignedZone({ x: 0, y: 0, z: 0 })
    const up = zoneUpVector(z)
    expect(up.x).toBeCloseTo(0)
    expect(up.y).toBeCloseTo(1)
    expect(up.z).toBeCloseTo(0)
  })

  it('returns world +Z for a zone tipped 90° around X (top-face-forward)', () => {
    // Rotate +90° around X: local +Y → world +Z.
    const z: AntiGravZone = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 },
      halfWidth: 1,
      halfHeight: 1,
      halfDepth: 1,
    }
    const up = zoneUpVector(z)
    expect(up.x).toBeCloseTo(0)
    expect(up.y).toBeCloseTo(0)
    expect(up.z).toBeCloseTo(1)
  })
})

describe('findContainingZone', () => {
  it('returns null when no zones contain the point', () => {
    const zones = [axisAlignedZone({ x: 50, y: 0, z: 0 })]
    expect(findContainingZone({ x: 0, y: 0, z: 0 }, zones)).toBeNull()
  })

  it('returns the first matching zone (first-match wins on overlap)', () => {
    const a = axisAlignedZone({ x: 0, y: 0, z: 0 })
    const b = axisAlignedZone({ x: 0, y: 0, z: 0 })
    expect(findContainingZone({ x: 1, y: 1, z: 1 }, [a, b])).toBe(a)
  })

  it('returns null on an empty zone list', () => {
    expect(findContainingZone({ x: 0, y: 0, z: 0 }, [])).toBeNull()
  })
})
