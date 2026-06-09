import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { TerrainHeightmap } from '../../src/engine/render/terrain-heightmap'
import {
  reportWaterCoverage,
  WATER_COVERAGE_THRESHOLD,
} from '../../src/engine/render/water-coverage'
import type { Track } from '../../src/game/tracks/types'

const DEEP_SENTINEL = -10000

function makeHeightmap(
  res: number,
  worldHalfExtent: number,
  fill: (u: number, v: number) => number,
): TerrainHeightmap {
  const raw = new Float32Array(res * res)
  for (let v = 0; v < res; v++) {
    for (let u = 0; u < res; u++) {
      raw[v * res + u] = fill(u, v)
    }
  }
  return {
    texture: {} as THREE.DataTexture,
    worldMin: new THREE.Vector2(-worldHalfExtent, -worldHalfExtent),
    worldMax: new THREE.Vector2(worldHalfExtent, worldHalfExtent),
    resolution: res,
    raw,
  }
}

function makeTrack(points: { x: number; z: number; y?: number }[], waterHeight = 0): Track {
  const pts = points.map((p) => ({ x: p.x, y: p.y ?? 0, z: p.z }))
  return {
    id: 'test',
    name: 'test',
    start: { position: { x: 0, y: 0, z: 0 }, yaw: 0 },
    checkpoints: [],
    lapsToFinish: 1,
    surfaces: [],
    pickupSpawns: [],
    aiSplines: [{ id: 'main', points: pts }],
    boostPads: [],
    antiGravZones: [],
    waveZones: [],
    props: [],
    water: { height: waterHeight },
  } as unknown as Track
}

describe('water-coverage report', () => {
  it('returns null when no heightmap is provided', () => {
    const track = makeTrack([{ x: 0, z: 0 }])
    expect(reportWaterCoverage(track, null)).toBeNull()
  })

  it('counts all anchors over land when heightmap says terrain is above water', () => {
    const hm = makeHeightmap(8, 100, () => 5) // all 5m above water-y 0
    const track = makeTrack(
      [
        { x: 0, z: 0 },
        { x: 10, z: 10 },
        { x: -10, z: -10 },
      ],
      0,
    )
    const r = reportWaterCoverage(track, hm)!
    expect(r.water).toBe(0)
    expect(r.land).toBe(3)
    expect(r.pct).toBe(0)
    expect(r.meetsThreshold).toBe(false)
  })

  it('counts all anchors over water when terrain is below water', () => {
    const hm = makeHeightmap(8, 100, () => -5)
    const track = makeTrack(
      [
        { x: 0, z: 0 },
        { x: 10, z: 10 },
      ],
      0,
    )
    const r = reportWaterCoverage(track, hm)!
    expect(r.water).toBe(2)
    expect(r.land).toBe(0)
    expect(r.pct).toBe(1)
    expect(r.meetsThreshold).toBe(true)
  })

  it('treats outside-of-heightmap as open ocean = water', () => {
    const hm = makeHeightmap(8, 50, () => 10) // 50m square, all land
    const track = makeTrack([
      { x: 0, z: 0 }, // inside, land
      { x: 100, z: 100 }, // outside heightmap → open ocean
      { x: -100, z: -100 }, // outside heightmap → open ocean
    ])
    const r = reportWaterCoverage(track, hm)!
    expect(r.outside).toBe(2)
    expect(r.water).toBe(2)
    expect(r.land).toBe(1)
    expect(r.pct).toBeCloseTo(2 / 3, 3)
  })

  it('flags a track below the 40% water threshold', () => {
    const hm = makeHeightmap(8, 50, () => 5)
    const track = makeTrack([
      { x: 0, z: 0 }, // land
      { x: 10, z: 10 }, // land
      { x: 90, z: 90 }, // outside → water
    ])
    const r = reportWaterCoverage(track, hm)!
    expect(r.pct).toBeCloseTo(1 / 3, 3)
    expect(r.meetsThreshold).toBe(false)
    expect(r.thresholdPct).toBe(WATER_COVERAGE_THRESHOLD)
  })

  it('treats deep-sentinel neighbours as open ocean', () => {
    // Half the heightmap is sentinel (no terrain there)
    const hm = makeHeightmap(8, 100, (u) => (u < 4 ? DEEP_SENTINEL : 10))
    const track = makeTrack([
      { x: -80, z: 0 }, // u<4 → sentinel → outside → water
      { x: 80, z: 0 }, // u>=4 → land
    ])
    const r = reportWaterCoverage(track, hm)!
    expect(r.water).toBe(1)
    expect(r.land).toBe(1)
    expect(r.outside).toBe(1)
  })
})
