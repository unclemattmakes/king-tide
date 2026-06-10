import { describe, expect, it } from 'vitest'
import {
  generateWindStreamline,
  type WindStreamlineSpec,
} from '../../src/engine/render/wind-streamline'

/** mulberry32 — the same PRNG the render systems inject. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SPEC: WindStreamlineSpec = {
  dirX: 1,
  dirZ: 0,
  lengthM: 40,
  segments: 96,
  loopChance: 1,
  loopRadiusMin: 1.2,
  loopRadiusMax: 2.4,
  tiltMin: 0.45,
  tiltMax: 1.35,
  wander: 0.42,
  bobAmp: 0.5,
}

/** Net signed turning of the curve, projected into its dominant lateral
 *  plane: Σ signed angle between consecutive segment directions in (u, v),
 *  where u = wind axis and v = the lateral with the most variance. A full
 *  inscribed curl contributes ±2π; meander alone stays well under that. */
function netTurning(points: Float32Array, dirX: number, dirZ: number): number {
  const n = points.length / 3
  // Lateral basis candidates: horizontal-perp and world Y. Project onto
  // whichever carries more energy (the curl plane's lateral).
  const px = -dirZ
  const pz = dirX
  let varP = 0
  let varY = 0
  for (let i = 0; i < n; i++) {
    const lp = points[i * 3]! * px + points[i * 3 + 2]! * pz
    varP += lp * lp
    varY += points[i * 3 + 1]! * points[i * 3 + 1]!
  }
  const useY = varY > varP
  const u = (i: number) => points[i * 3]! * dirX + points[i * 3 + 2]! * dirZ
  const v = (i: number) =>
    useY ? points[i * 3 + 1]! : points[i * 3]! * px + points[i * 3 + 2]! * pz
  let total = 0
  let prevA: number | null = null
  for (let i = 1; i < n; i++) {
    const du = u(i) - u(i - 1)
    const dv = v(i) - v(i - 1)
    if (Math.hypot(du, dv) < 1e-6) continue
    const a = Math.atan2(dv, du)
    if (prevA !== null) {
      let d = a - prevA
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      total += d
    }
    prevA = a
  }
  return total
}

describe('wind streamline generator', () => {
  it('is deterministic per seed', () => {
    const a = generateWindStreamline(mulberry32(99), SPEC)
    const b = generateWindStreamline(mulberry32(99), SPEC)
    expect(Array.from(a.points)).toEqual(Array.from(b.points))
    expect(a.loop).toEqual(b.loop)
  })

  it('walks exactly the requested arc length in equal steps', () => {
    const { points } = generateWindStreamline(mulberry32(7), { ...SPEC, bobAmp: 0 })
    let sum = 0
    for (let i = 1; i <= SPEC.segments; i++) {
      sum += Math.hypot(
        points[i * 3]! - points[(i - 1) * 3]!,
        points[i * 3 + 1]! - points[(i - 1) * 3 + 1]!,
        points[i * 3 + 2]! - points[(i - 1) * 3 + 2]!,
      )
    }
    expect(sum).toBeGreaterThan(SPEC.lengthM * 0.99)
    expect(sum).toBeLessThan(SPEC.lengthM * 1.01)
  })

  it('centres the curve midpoint on the origin', () => {
    const { points } = generateWindStreamline(mulberry32(3), SPEC)
    const mid = (SPEC.segments >> 1) * 3
    expect(Math.abs(points[mid]!)).toBeLessThan(1e-6)
    expect(Math.abs(points[mid + 1]!)).toBeLessThan(1e-6)
    expect(Math.abs(points[mid + 2]!)).toBeLessThan(1e-6)
  })

  it('loopChance 1 inscribes a full curl (≈2π extra net turning)', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { points, loop } = generateWindStreamline(mulberry32(seed * 31), SPEC)
      expect(loop).not.toBeNull()
      expect(Math.abs(netTurning(points, 1, 0))).toBeGreaterThan(4.6)
    }
  })

  it('loopChance 0 never curls — net turning stays meander-bounded', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { points, loop } = generateWindStreamline(mulberry32(seed * 17), {
        ...SPEC,
        loopChance: 0,
      })
      expect(loop).toBeNull()
      expect(Math.abs(netTurning(points, 1, 0))).toBeLessThan(2.5)
    }
  })

  it('trends downwind: the run ends ahead of where it starts, along the wind', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const dirX = 0.6
      const dirZ = -0.8
      const { points } = generateWindStreamline(mulberry32(seed * 13), { ...SPEC, dirX, dirZ })
      const n = SPEC.segments
      const along = (points[n * 3]! - points[0]!) * dirX + (points[n * 3 + 2]! - points[2]!) * dirZ
      expect(along).toBeGreaterThan(SPEC.lengthM * 0.3)
    }
  })

  it('keeps the curl radius inside the requested range (and fit cap)', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { loop } = generateWindStreamline(mulberry32(seed * 7), SPEC)
      if (!loop) continue
      expect(loop.radius).toBeGreaterThanOrEqual(SPEC.loopRadiusMin - 1e-9)
      expect(loop.radius).toBeLessThanOrEqual(SPEC.loopRadiusMax + 1e-9)
      expect(loop.at).toBeGreaterThan(0.2)
      expect(loop.at).toBeLessThan(0.8)
    }
  })
})
