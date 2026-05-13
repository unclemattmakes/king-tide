import { describe, expect, it } from 'vitest'
import { isOverBoostPad } from '../../src/game/systems/boost-pad'
import type { BoostPad } from '../../src/game/tracks/types'

function axisAlignedPad(
  pos: { x: number; y: number; z: number },
  halfWidth = 3,
  halfDepth = 5,
  strength = 1.5,
): BoostPad {
  return {
    position: pos,
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    halfWidth,
    halfDepth,
    strength,
  }
}

describe('isOverBoostPad', () => {
  it('detects center overlap on an axis-aligned pad', () => {
    const pad = axisAlignedPad({ x: 10, y: 0, z: 20 })
    expect(isOverBoostPad({ x: 10, y: 0, z: 20 }, pad)).toBe(true)
  })

  it('rejects bikes outside the lateral extent', () => {
    const pad = axisAlignedPad({ x: 0, y: 0, z: 0 }, 3, 5)
    expect(isOverBoostPad({ x: 3.5, y: 0, z: 0 }, pad)).toBe(false)
  })

  it('rejects bikes outside the depth extent', () => {
    const pad = axisAlignedPad({ x: 0, y: 0, z: 0 }, 3, 5)
    expect(isOverBoostPad({ x: 0, y: 0, z: 5.5 }, pad)).toBe(false)
  })

  it('accepts at exact half-extents (inclusive)', () => {
    const pad = axisAlignedPad({ x: 0, y: 0, z: 0 }, 3, 5)
    expect(isOverBoostPad({ x: 3, y: 0, z: 0 }, pad)).toBe(true)
    expect(isOverBoostPad({ x: 0, y: 0, z: 5 }, pad)).toBe(true)
    expect(isOverBoostPad({ x: -3, y: 0, z: -5 }, pad)).toBe(true)
  })

  it('rejects bikes outside the vertical band', () => {
    const pad = axisAlignedPad({ x: 0, y: 0, z: 0 })
    expect(isOverBoostPad({ x: 0, y: 4, z: 0 }, pad)).toBe(false)
    expect(isOverBoostPad({ x: 0, y: -4, z: 0 }, pad)).toBe(false)
  })

  it('accepts within the vertical band', () => {
    const pad = axisAlignedPad({ x: 0, y: 0, z: 0 })
    expect(isOverBoostPad({ x: 0, y: 2.5, z: 0 }, pad)).toBe(true)
  })

  it('respects orientation — a 90° rotated pad swaps local axes onto world axes', () => {
    // 90° rotation around Y: local +Z aligns to world +X, local +X to world -Z.
    const pad: BoostPad = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
      halfWidth: 3,
      halfDepth: 5,
      strength: 1.5,
    }
    // 4 m along world +X is 4 m along local +Z — within halfDepth (5).
    expect(isOverBoostPad({ x: 4, y: 0, z: 0 }, pad)).toBe(true)
    // 4 m along world +Z is 4 m along local -X — |4| > halfWidth (3), out.
    expect(isOverBoostPad({ x: 0, y: 0, z: 4 }, pad)).toBe(false)
  })
})
