import { describe, expect, it } from 'vitest'
import { buildShoreField, sampleShore } from '../../src/engine/sim/water/shore-field'

const DEEP_SENTINEL = -10000

/**
 * Build a raw max-Y grid over a world AABB from a world-space terrain function.
 * Mirrors `terrain-heightmap.ts`'s row-major `v*res+u` layout and cell-centre
 * sampling so the shore-field bake sees a realistic input.
 */
function rawFromFn(
  res: number,
  minX: number,
  minZ: number,
  sizeX: number,
  sizeZ: number,
  fn: (x: number, z: number) => number,
): Float32Array {
  const raw = new Float32Array(res * res)
  const cellX = sizeX / res
  const cellZ = sizeZ / res
  for (let v = 0; v < res; v++) {
    const z = minZ + (v + 0.5) * cellZ
    for (let u = 0; u < res; u++) {
      const x = minX + (u + 0.5) * cellX
      raw[v * res + u] = fn(x, z)
    }
  }
  return raw
}

describe('shore field bake', () => {
  // A beach ramp: terrain rises west→east, crossing the water plane (y=0) at
  // worldX = 0. Land is the +X half, open water the −X half.
  const RES = 64
  const MINX = -100
  const MINZ = -100
  const SIZE = 200
  const SLOPE = 0.05 // terrainY = 0.05·x → depth = −0.05·x in water
  const ramp = () =>
    buildShoreField({
      raw: rawFromFn(RES, MINX, MINZ, SIZE, SIZE, (x) => SLOPE * x),
      resolution: RES,
      minX: MINX,
      minZ: MINZ,
      sizeX: SIZE,
      sizeZ: SIZE,
      waterLevel: 0,
    })

  it('produces a field when land and water both exist', () => {
    expect(ramp()).not.toBeNull()
  })

  it('returns null when there is no coastline', () => {
    // All deep water.
    const allWater = buildShoreField({
      raw: rawFromFn(RES, MINX, MINZ, SIZE, SIZE, () => -50),
      resolution: RES,
      minX: MINX,
      minZ: MINZ,
      sizeX: SIZE,
      sizeZ: SIZE,
      waterLevel: 0,
    })
    expect(allWater).toBeNull()
    // All land.
    const allLand = buildShoreField({
      raw: rawFromFn(RES, MINX, MINZ, SIZE, SIZE, () => 50),
      resolution: RES,
      minX: MINX,
      minZ: MINZ,
      sizeX: SIZE,
      sizeZ: SIZE,
      waterLevel: 0,
    })
    expect(allLand).toBeNull()
  })

  it('depth matches waterLevel − terrainY, sign splits land/water', () => {
    const f = ramp()!
    // Water side (x = −40): depth ≈ +2.0 m.
    const water = sampleShore(f, -40, 0)!
    expect(water.depth).toBeGreaterThan(0)
    expect(water.depth).toBeCloseTo(2.0, 1)
    // Land side (x = +40): depth ≈ −2.0 m.
    const land = sampleShore(f, 40, 0)!
    expect(land.depth).toBeLessThan(0)
  })

  it('distance-to-shore increases offshore and the normal points offshore', () => {
    const f = ramp()!
    const near = sampleShore(f, -10, 0)!
    const far = sampleShore(f, -60, 0)!
    expect(far.dist).toBeGreaterThan(near.dist)
    // Offshore on this ramp is −X (away from the +X land), so ∇dist.x < 0.
    expect(near.nrmX).toBeLessThan(-0.5)
    // Terrain is z-invariant → normal is ~axis-aligned.
    expect(Math.abs(near.nrmZ)).toBeLessThan(0.2)
    // Normal is unit length where it's defined.
    expect(Math.hypot(near.nrmX, near.nrmZ)).toBeCloseTo(1, 3)
  })

  it('radial island: normal points outward, distance grows with radius', () => {
    // A cone peaking above water at the centre, dropping below water past
    // r ≈ 30 m. Land disk in the middle, water all around.
    const island = buildShoreField({
      raw: rawFromFn(RES, MINX, MINZ, SIZE, SIZE, (x, z) => 6 - 0.2 * Math.hypot(x, z)),
      resolution: RES,
      minX: MINX,
      minZ: MINZ,
      sizeX: SIZE,
      sizeZ: SIZE,
      waterLevel: 0,
    })!
    // East of the island in water (x = +50, z = 0): offshore is +X.
    const east = sampleShore(island, 50, 0)!
    expect(east.depth).toBeGreaterThan(0)
    expect(east.nrmX).toBeGreaterThan(0.5)
    // North (z = +50): offshore is +Z.
    const north = sampleShore(island, 0, 50)!
    expect(north.nrmZ).toBeGreaterThan(0.5)
    // Distance grows moving further out.
    const closeOut = sampleShore(island, 40, 0)!
    const farOut = sampleShore(island, 70, 0)!
    expect(farOut.dist).toBeGreaterThan(closeOut.dist)
  })

  it('treats sentinel (no-terrain) cells as deep water without NaNs', () => {
    // Left third land, middle water, right third uncovered (sentinel).
    const raw = rawFromFn(RES, MINX, MINZ, SIZE, SIZE, (x) => {
      if (x < -40) return 5 // land
      if (x < 40) return -2 // shallow-ish water
      return DEEP_SENTINEL // open ocean / no terrain
    })
    const f = buildShoreField({
      raw,
      resolution: RES,
      minX: MINX,
      minZ: MINZ,
      sizeX: SIZE,
      sizeZ: SIZE,
      waterLevel: 0,
    })!
    for (let i = 0; i < f.dist.length; i++) {
      expect(Number.isFinite(f.dist[i]!)).toBe(true)
      expect(Number.isFinite(f.nrmX[i]!)).toBe(true)
      expect(Number.isFinite(f.nrmZ[i]!)).toBe(true)
      expect(Number.isFinite(f.depth[i]!)).toBe(true)
    }
    // A sentinel cell reads as very deep water.
    const ocean = sampleShore(f, 80, 0)!
    expect(ocean.depth).toBeGreaterThan(1000)
  })

  it('returns null outside the covered AABB', () => {
    const f = ramp()!
    expect(sampleShore(f, -500, 0)).toBeNull()
    expect(sampleShore(f, 0, 500)).toBeNull()
  })

  it('bakes deterministically (byte-identical across runs)', () => {
    const a = ramp()!
    const b = ramp()!
    expect(a.dist).toEqual(b.dist)
    expect(a.nrmX).toEqual(b.nrmX)
    expect(a.nrmZ).toEqual(b.nrmZ)
    expect(a.depth).toEqual(b.depth)
  })
})
