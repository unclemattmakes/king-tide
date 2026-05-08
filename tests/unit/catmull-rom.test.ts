import { describe, expect, it } from 'vitest'
import { nearestT, pointAtT, sampleCatmullRom, tangentAtT } from '@/game/tracks/catmull-rom'

describe('sampleCatmullRom', () => {
  it('returns empty array for empty input', () => {
    expect(sampleCatmullRom([])).toEqual([])
  })

  it('returns the single point for single-anchor input', () => {
    expect(sampleCatmullRom([{ x: 1, y: 2, z: 3 }])).toEqual([{ x: 1, y: 2, z: 3 }])
  })

  it('produces divisionsPerSegment * anchorCount samples for closed loops', () => {
    const anchors = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 0, z: 10 },
      { x: 0, y: 0, z: 10 },
    ]
    const samples = sampleCatmullRom(anchors, { divisionsPerSegment: 8, closed: true })
    expect(samples).toHaveLength(8 * 4)
  })

  it('passes through (or very close to) the anchors at segment boundaries', () => {
    const anchors = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 0, z: 10 },
      { x: 0, y: 0, z: 10 },
    ]
    const samples = sampleCatmullRom(anchors, { divisionsPerSegment: 8, closed: true })
    // Sample[0] is the start of segment 0 (anchor 0). Sample[8] is the start
    // of segment 1 (anchor 1).
    expect(samples[0]!.x).toBeCloseTo(0, 5)
    expect(samples[0]!.z).toBeCloseTo(0, 5)
    expect(samples[8]!.x).toBeCloseTo(10, 5)
    expect(samples[8]!.z).toBeCloseTo(0, 5)
  })
})

describe('pointAtT', () => {
  it('wraps around for t > 1 and t < 0', () => {
    const samples = [
      { x: 0, y: 0, z: 0 },
      { x: 5, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 15, y: 0, z: 0 },
    ]
    const a = pointAtT(samples, 0.0)
    const b = pointAtT(samples, 1.0)
    expect(a.x).toBeCloseTo(b.x, 5)
  })
})

describe('nearestT', () => {
  it('finds the closest sample on a ring', () => {
    const samples = [
      { x: 10, y: 0, z: 0 },
      { x: 0, y: 0, z: 10 },
      { x: -10, y: 0, z: 0 },
      { x: 0, y: 0, z: -10 },
    ]
    expect(nearestT({ x: 9.5, y: 0, z: 0 }, samples)).toBeCloseTo(0)
    expect(nearestT({ x: 0, y: 0, z: 9.5 }, samples)).toBeCloseTo(0.25)
    expect(nearestT({ x: -9.5, y: 0, z: 0 }, samples)).toBeCloseTo(0.5)
  })
})

describe('tangentAtT', () => {
  it('returns a unit vector along the local segment direction', () => {
    const samples = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 5 },
      { x: 0, y: 0, z: 10 },
      { x: 0, y: 0, z: 15 },
    ]
    const t = tangentAtT(samples, 0)
    expect(t.x).toBeCloseTo(0, 5)
    expect(t.z).toBeCloseTo(1, 5)
    expect(Math.hypot(t.x, t.z)).toBeCloseTo(1, 5)
  })
})
