import { describe, expect, it } from 'vitest'
import type { Vec3 } from '@/engine/sim/physics/vec'
import { sampleCatmullRom } from '@/game/tracks/catmull-rom'
import { DEFAULT_GATE_SPACING_M, resampleByArcLength } from '@/game/tracks/gate-placement'

/** Closed square of side 100, axis-aligned in xz. Perimeter 400. */
const square: Vec3[] = [
  { x: 0, y: 0, z: 0 },
  { x: 100, y: 0, z: 0 },
  { x: 100, y: 0, z: 100 },
  { x: 0, y: 0, z: 100 },
]

function circle(radius = 50, samples = 64, y = 0): Vec3[] {
  const out: Vec3[] = []
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2
    out.push({ x: radius * Math.cos(a), y, z: radius * Math.sin(a) })
  }
  return out
}

describe('resampleByArcLength', () => {
  it('returns empty for empty or single-point input', () => {
    expect(resampleByArcLength([], 10)).toEqual([])
    expect(resampleByArcLength([{ x: 0, y: 0, z: 0 }], 10)).toEqual([])
  })

  it('throws on non-positive spacing', () => {
    expect(() => resampleByArcLength(square, 0)).toThrow(/positive/)
    expect(() => resampleByArcLength(square, -5)).toThrow(/positive/)
  })

  it('returns exactly the rounded gate count for the requested spacing', () => {
    expect(resampleByArcLength(square, 100)).toHaveLength(4)
    expect(resampleByArcLength(square, 50)).toHaveLength(8)
    // Spacing 150 → round(400/150) = 3 gates; rounding keeps the loop closure clean.
    expect(resampleByArcLength(square, 150)).toHaveLength(3)
  })

  it('places gates evenly in arc length around a closed loop', () => {
    const gates = resampleByArcLength(square, 100)
    expect(gates[0]!.t).toBeCloseTo(0, 6)
    expect(gates[1]!.t).toBeCloseTo(0.25, 6)
    expect(gates[2]!.t).toBeCloseTo(0.5, 6)
    expect(gates[3]!.t).toBeCloseTo(0.75, 6)
    expect(gates[0]!.position.x).toBeCloseTo(0, 5)
    expect(gates[0]!.position.z).toBeCloseTo(0, 5)
    expect(gates[1]!.position.x).toBeCloseTo(100, 5)
    expect(gates[1]!.position.z).toBeCloseTo(0, 5)
    expect(gates[2]!.position.x).toBeCloseTo(100, 5)
    expect(gates[2]!.position.z).toBeCloseTo(100, 5)
    expect(gates[3]!.position.x).toBeCloseTo(0, 5)
    expect(gates[3]!.position.z).toBeCloseTo(100, 5)
  })

  it('places gates at uniform arc distance regardless of vertex density', () => {
    // NB: t in this codebase is *vertex-uniform*, not arc-uniform — to
    // verify arc uniformity, invert each gate's t back to its arc-from-start
    // via the cumulative arc table.
    const denseSquare: Vec3[] = []
    for (let i = 0; i < 100; i++) {
      denseSquare.push({ x: i, y: 0, z: 0 })
    }
    denseSquare.push({ x: 100, y: 0, z: 0 })
    denseSquare.push({ x: 100, y: 0, z: 50 })
    denseSquare.push({ x: 100, y: 0, z: 100 })
    denseSquare.push({ x: 50, y: 0, z: 100 })
    denseSquare.push({ x: 0, y: 0, z: 100 })
    denseSquare.push({ x: 0, y: 0, z: 50 })

    const gates = resampleByArcLength(denseSquare, 100)
    expect(gates).toHaveLength(4)

    const n = denseSquare.length
    const cum = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) {
      const a = denseSquare[i]!
      const b = denseSquare[(i + 1) % n]!
      cum[i + 1] = cum[i]! + Math.hypot(b.x - a.x, b.z - a.z)
    }
    const total = cum[n]!
    const arcAtT = (t: number): number => {
      const f = t * n
      const i0 = Math.floor(f) % n
      const frac = f - Math.floor(f)
      return cum[i0]! + frac * (cum[i0 + 1]! - cum[i0]!)
    }

    const expectedArc = total / gates.length
    for (let i = 0; i < gates.length; i++) {
      const arcA = arcAtT(gates[i]!.t)
      const arcB = arcAtT(gates[(i + 1) % gates.length]!.t)
      const gap = i + 1 < gates.length ? arcB - arcA : total - arcA + arcB
      expect(gap).toBeCloseTo(expectedArc, 3)
    }
  })

  it('produces a unit-length tangent in the xz plane', () => {
    const gates = resampleByArcLength(circle(50, 256), 25)
    const sample = gates[0]!
    const tlen = Math.hypot(sample.tangent.x, sample.tangent.z)
    expect(tlen).toBeCloseTo(1, 5)
    expect(sample.tangent.y).toBe(0)
  })

  it('matches Lagoon Loop expected count at the schema default spacing', () => {
    const lagoonAnchors: Vec3[] = [
      { x: 50, y: 1, z: 0 },
      { x: 50, y: 1, z: 50 },
      { x: 35, y: 1, z: 90 },
      { x: 0, y: 1, z: 100 },
      { x: -50, y: 1, z: 50 },
      { x: -50, y: 1, z: -50 },
      { x: -35, y: 1, z: -90 },
      { x: 0, y: 1, z: -100 },
      { x: 50, y: 1, z: -50 },
    ]
    const points = sampleCatmullRom(lagoonAnchors, {
      divisionsPerSegment: 12,
      closed: true,
    })
    const gates = resampleByArcLength(points, DEFAULT_GATE_SPACING_M)
    expect(gates.length).toBeGreaterThanOrEqual(8)
    expect(gates.length).toBeLessThanOrEqual(10)
  })
})
