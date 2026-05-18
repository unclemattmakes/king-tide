import { describe, expect, it } from 'vitest'
import { curveUpAtT } from '../../src/game/tracks/catmull-rom'
import {
  findContainingZone,
  isInsideAntiGravZone,
  sampleCurveGravity,
  zoneUpVector,
} from '../../src/game/systems/anti-grav'
import type { Vec3 } from '../../src/engine/sim/physics/vec'
import type { AISpline, AntiGravZone } from '../../src/game/tracks/types'

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

describe('curveUpAtT', () => {
  it('returns world +Y for a horizontal tangent with zero banking', () => {
    const up = curveUpAtT({ x: 0, y: 0, z: 1 }, 0)
    expect(up.x).toBeCloseTo(0)
    expect(up.y).toBeCloseTo(1)
    expect(up.z).toBeCloseTo(0)
  })

  it('rotates +Y to −X under banking +π/2 with tangent along +Z', () => {
    // Right-hand rule: thumb +Z, fingers curl +X → +Y, so +Y rotates
    // toward −X under positive banking.
    const up = curveUpAtT({ x: 0, y: 0, z: 1 }, Math.PI / 2)
    expect(up.x).toBeCloseTo(-1)
    expect(up.y).toBeCloseTo(0, 5)
    expect(up.z).toBeCloseTo(0)
  })

  it('rotates +Y to +X under banking −π/2 with tangent along +Z', () => {
    const up = curveUpAtT({ x: 0, y: 0, z: 1 }, -Math.PI / 2)
    expect(up.x).toBeCloseTo(1)
    expect(up.y).toBeCloseTo(0, 5)
    expect(up.z).toBeCloseTo(0)
  })

  it('flips to −Y under banking π (upside-down ceiling)', () => {
    const up = curveUpAtT({ x: 0, y: 0, z: 1 }, Math.PI)
    expect(up.x).toBeCloseTo(0, 5)
    expect(up.y).toBeCloseTo(-1)
    expect(up.z).toBeCloseTo(0, 5)
  })

  it('keeps up perpendicular to a non-axis-aligned tangent', () => {
    // Tangent 45° in XZ plane, zero banking → up should still be +Y.
    const t = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 }
    const up = curveUpAtT(t, 0)
    const dot = up.x * t.x + up.y * t.y + up.z * t.z
    expect(dot).toBeCloseTo(0, 5)
  })
})

describe('sampleCurveGravity', () => {
  function makeFlaggedSpline(points: Vec3[], bankings: number[], falloff = 8): AISpline {
    return {
      id: 'test',
      points,
      bankings,
      antiGrav: true,
      antiGravFalloff: falloff,
    }
  }

  it('returns null when spline has no antiGrav flag', () => {
    const s: AISpline = {
      id: 'test',
      points: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }],
    }
    expect(sampleCurveGravity({ x: 0, y: 0, z: 5 }, s)).toBeNull()
  })

  it('returns null when bike is past falloff distance', () => {
    const s = makeFlaggedSpline(
      [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }],
      [0, 0],
      4,
    )
    // Bike at x=100 is way past 4m falloff.
    expect(sampleCurveGravity({ x: 100, y: 0, z: 5 }, s)).toBeNull()
  })

  it('reports weight ≈ 1 on the spline and weight ≈ 0.5 at half-falloff', () => {
    // Densely-sampled straight line at x=0 so the nearest-point distance
    // is the bike's lateral offset, not aliasing from sparse samples.
    const pts: Vec3[] = []
    const bks: number[] = []
    for (let i = 0; i <= 40; i++) {
      pts.push({ x: 0, y: 0, z: i * 0.5 })
      bks.push(0)
    }
    const s = makeFlaggedSpline(pts, bks, 8)
    const onCurve = sampleCurveGravity({ x: 0, y: 0, z: 5 }, s)
    expect(onCurve).not.toBeNull()
    expect(onCurve!.weight).toBeCloseTo(1, 1)
    const halfway = sampleCurveGravity({ x: 4, y: 0, z: 5 }, s)
    expect(halfway).not.toBeNull()
    expect(halfway!.weight).toBeCloseTo(0.5, 1)
  })

  it('reports a wall-rotated up when banking = π/2 on a +Z spline', () => {
    const s = makeFlaggedSpline(
      [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 5 },
        { x: 0, y: 0, z: 10 },
        { x: 0, y: 0, z: 15 },
      ],
      [Math.PI / 2, Math.PI / 2, Math.PI / 2, Math.PI / 2],
    )
    const r = sampleCurveGravity({ x: 0, y: 0, z: 7 }, s)
    expect(r).not.toBeNull()
    expect(r!.upX).toBeCloseTo(-1)
    expect(Math.abs(r!.upY)).toBeLessThan(0.05)
    expect(Math.abs(r!.upZ)).toBeLessThan(0.05)
  })
})
