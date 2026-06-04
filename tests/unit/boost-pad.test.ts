import { describe, expect, it } from 'vitest'
import { isOverBoostPad } from '../../src/game/systems/boost-pad'
import type { BoostPad } from '../../src/game/tracks/types'

function axisAlignedPad(
  pos: { x: number; y: number; z: number },
  halfWidth = 3,
  halfDepth = 5,
  halfHeight = 3,
  strength = 1.5,
): BoostPad {
  return {
    position: pos,
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    halfWidth,
    halfHeight,
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
      halfHeight: 3,
      halfDepth: 5,
      strength: 1.5,
    }
    // 4 m along world +X is 4 m along local +Z — within halfDepth (5).
    expect(isOverBoostPad({ x: 4, y: 0, z: 0 }, pad)).toBe(true)
    // 4 m along world +Z is 4 m along local -X — |4| > halfWidth (3), out.
    expect(isOverBoostPad({ x: 0, y: 0, z: 4 }, pad)).toBe(false)
  })

  it('respects an authored halfHeight (pad-local up)', () => {
    // Larger 6 m halfHeight catches a bike that the legacy 3 m band missed.
    const pad = axisAlignedPad({ x: 0, y: 0, z: 0 }, 3, 5, 6)
    expect(isOverBoostPad({ x: 0, y: 5, z: 0 }, pad)).toBe(true)
    expect(isOverBoostPad({ x: 0, y: 6.5, z: 0 }, pad)).toBe(false)
  })

  it('catches a bike hovering over a high-water surface (south-beach regression)', () => {
    // South Beach Sunken: water at +3.3 m, pad authored at y≈0.1, bike
    // rides ~4.5 m. The old hardcoded 3 m band topped out at 3.1 m and
    // missed the bike entirely; the generous legacy default (6 m) catches
    // it. Pad-local up == world up here (axis-aligned).
    const tightLegacy = axisAlignedPad({ x: 0, y: 0.1, z: 0 }, 3, 6, 3)
    const generousLegacy = axisAlignedPad({ x: 0, y: 0.1, z: 0 }, 3, 6, 6)
    const ridePos = { x: 0, y: 4.5, z: 0 }
    expect(isOverBoostPad(ridePos, tightLegacy)).toBe(false) // the bug
    expect(isOverBoostPad(ridePos, generousLegacy)).toBe(true) // the fix
  })
})
