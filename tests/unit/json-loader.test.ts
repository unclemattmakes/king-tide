import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTrackFromJson, trackToJson } from '@/game/tracks/json-loader'

const REPO_ROOT = path.resolve(__dirname, '../..')
const CALIBRATION_JSON = path.join(REPO_ROOT, 'public', 'tracks', 'calibration.json')

describe('buildTrackFromJson', () => {
  it('builds a complete Track from the calibration JSON', () => {
    const raw = JSON.parse(fs.readFileSync(CALIBRATION_JSON, 'utf8'))
    const track = buildTrackFromJson(raw)

    expect(track.id).toBe('calibration')
    expect(track.name).toBe('Calibration')
    expect(track.lapsToFinish).toBe(1)
    expect(track.environmentGlb).toBe('/assets/tracks/calibration.glb')
    expect(track.checkpoints).toHaveLength(4)
    expect(track.checkpoints.map((cp) => cp.index)).toEqual([0, 1, 2, 3])
    expect(track.aiSplines).toHaveLength(1)
    expect(track.aiSplines[0]!.id).toBe('main')
    expect(track.aiSplines[0]!.points.length).toBeGreaterThan(10)
    expect(track.pickupSpawns).toHaveLength(1)
    expect(track.boostPads).toHaveLength(0)
    expect(track.water).toEqual({ height: 0, waveHeight: 1, waveFreq: 0.5 })
  })

  it('round-trips: trackToJson(buildTrackFromJson(x)) preserves shape', () => {
    const raw = JSON.parse(fs.readFileSync(CALIBRATION_JSON, 'utf8'))
    const built = buildTrackFromJson(raw)
    const back = trackToJson(built)
    const rebuilt = buildTrackFromJson(back)
    expect(rebuilt.checkpoints).toEqual(built.checkpoints)
    expect(rebuilt.pickupSpawns).toEqual(built.pickupSpawns)
    expect(rebuilt.aiSplines).toEqual(built.aiSplines)
    expect(rebuilt.boostPads).toEqual(built.boostPads)
    expect(rebuilt.start).toEqual(built.start)
    expect(rebuilt.water).toEqual(built.water)
    expect(rebuilt.environmentGlb).toEqual(built.environmentGlb)
  })

  it('rejects missing required fields', () => {
    expect(() => buildTrackFromJson({})).toThrow(/missing required field "id"/)
    expect(() => buildTrackFromJson({ id: 'x' })).toThrow(/missing required field "name"/)
  })

  it('rejects non-contiguous checkpoint indices', () => {
    const raw = baseTrack()
    raw.checkpoints[1]!.index = 5
    expect(() => buildTrackFromJson(raw)).toThrow(/checkpoints\[1\]\.index = 5/)
  })

  it('rejects aiSplines without a "main" entry', () => {
    const raw = baseTrack()
    raw.aiSplines[0]!.id = 'alt'
    expect(() => buildTrackFromJson(raw)).toThrow(/missing aiSplines entry with id="main"/)
  })

  it('rejects splines with fewer than 2 points', () => {
    const raw = baseTrack()
    raw.aiSplines[0]!.points = [{ x: 0, y: 0, z: 0 }]
    expect(() => buildTrackFromJson(raw)).toThrow(/needs either anchors\[≥2\] or points\[≥2\]/)
  })

  it('rejects anchored splines with fewer than 2 anchors', () => {
    const raw = baseTrack()
    ;(raw.aiSplines[0] as Record<string, unknown>).anchors = [{ x: 0, y: 0, z: 0 }]
    expect(() => buildTrackFromJson(raw)).toThrow(/anchors must have at least 2 entries/)
  })

  it('samples anchors into a dense polyline at load time', () => {
    const raw = baseTrack()
    ;(raw.aiSplines[0] as Record<string, unknown>).anchors = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 0, z: 10 },
      { x: 0, y: 0, z: 10 },
    ]
    raw.aiSplines[0]!.points = []
    const track = buildTrackFromJson(raw)
    // Catmull-Rom samples 12 points per segment * 4 segments (closed loop).
    expect(track.aiSplines[0]!.anchors).toHaveLength(4)
    expect(track.aiSplines[0]!.points.length).toBeGreaterThan(40)
  })

  it('derives gate position + yaw from spline when splineT is set', () => {
    const raw = baseTrack()
    // Define a known straight spline along +Z at x=5.
    ;(raw.aiSplines[0] as Record<string, unknown>).anchors = [
      { x: 5, y: 1, z: 0 },
      { x: 5, y: 1, z: 10 },
      { x: 5, y: 1, z: 20 },
      { x: 5, y: 1, z: 30 },
    ]
    raw.aiSplines[0]!.points = []
    // Bind cp 0 at t=0.5 (about halfway around the closed loop).
    ;(raw.checkpoints[0] as Record<string, unknown>).splineT = 0.0
    const track = buildTrackFromJson(raw)
    expect(track.checkpoints[0]!.splineT).toBeCloseTo(0)
    expect(track.checkpoints[0]!.position.x).toBeCloseTo(5, 1)
  })

  it('reads optional environmentGlb + water but tolerates absence', () => {
    const raw = baseTrack()
    delete raw['environmentGlb']
    delete raw['water']
    const track = buildTrackFromJson(raw)
    expect(track.environmentGlb).toBeUndefined()
    expect(track.water).toBeUndefined()
  })

  it('defaults missing pickupSpawns and boostPads to empty arrays', () => {
    const raw = baseTrack()
    delete (raw as { pickupSpawns?: unknown }).pickupSpawns
    delete (raw as { boostPads?: unknown }).boostPads
    const track = buildTrackFromJson(raw)
    expect(track.pickupSpawns).toEqual([])
    expect(track.boostPads).toEqual([])
  })

  it('round-trips an optional sky config block', () => {
    const raw = baseTrack()
    raw.sky = {
      tint: '#ffe4c4',
      cloudiness: 0.7,
      sunIntensity: 1.2,
      fogNear: 100,
      fogFar: 1200,
    }
    const built = buildTrackFromJson(raw)
    expect(built.sky).toEqual({
      tint: '#ffe4c4',
      cloudiness: 0.7,
      sunIntensity: 1.2,
      fogNear: 100,
      fogFar: 1200,
    })
    const back = trackToJson(built)
    const rebuilt = buildTrackFromJson(back)
    expect(rebuilt.sky).toEqual(built.sky)
  })

  it('treats sky as fully optional (omitted on tracks that do not need it)', () => {
    const raw = baseTrack()
    expect('sky' in raw).toBe(false)
    const built = buildTrackFromJson(raw)
    expect(built.sky).toBeUndefined()
  })

  it('rejects malformed sky.tint', () => {
    const raw = baseTrack()
    raw.sky = { tint: 'orange' }
    expect(() => buildTrackFromJson(raw)).toThrow(/sky\.tint must be a 6-digit hex color/)
  })

  it('rejects sky.cloudiness out of [0,1]', () => {
    const raw = baseTrack()
    raw.sky = { cloudiness: 1.5 }
    expect(() => buildTrackFromJson(raw)).toThrow(/sky\.cloudiness must be in \[0,1\]/)
  })

  it('rejects sky.sunIntensity below zero', () => {
    const raw = baseTrack()
    raw.sky = { sunIntensity: -0.1 }
    expect(() => buildTrackFromJson(raw)).toThrow(/sky\.sunIntensity must be >= 0/)
  })

  it('rejects sky.fogNear >= sky.fogFar', () => {
    const raw = baseTrack()
    raw.sky = { fogNear: 500, fogFar: 400 }
    expect(() => buildTrackFromJson(raw)).toThrow(/sky\.fogNear .* must be < sky\.fogFar/)
  })

  it('accepts a partial sky config (only the keys present)', () => {
    const raw = baseTrack()
    raw.sky = { cloudiness: 0.2 }
    const built = buildTrackFromJson(raw)
    expect(built.sky).toEqual({ cloudiness: 0.2 })
  })

  it('reads boost pad fields', () => {
    const raw = baseTrack()
    raw.boostPads = [
      {
        position: { x: 1, y: 0, z: 2 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 3,
        halfDepth: 6,
        strength: 1.7,
      },
    ]
    const track = buildTrackFromJson(raw)
    expect(track.boostPads).toHaveLength(1)
    expect(track.boostPads[0]!.strength).toBe(1.7)
    expect(track.boostPads[0]!.halfDepth).toBe(6)
  })
})

// Return type is intentionally mutable / index-able so tests can poke at
// fields. We feed it back into the loader as `unknown` anyway, so the
// loose typing doesn't reduce test fidelity.
function baseTrack(): Record<string, unknown> & {
  checkpoints: Array<Record<string, unknown>>
  aiSplines: Array<{ id: string; points: Array<{ x: number; y: number; z: number }> }>
  boostPads: Array<unknown>
  pickupSpawns: Array<{ x: number; y: number; z: number }>
} {
  return {
    id: 'unit-test',
    name: 'Unit Test',
    lapsToFinish: 1,
    environmentGlb: '/assets/tracks/x.glb',
    water: { height: 0, waveHeight: 1, waveFreq: 0.5 },
    start: { position: { x: 0, y: 1, z: 0 }, yaw: 0 },
    checkpoints: [
      {
        index: 0,
        position: { x: 0, y: 1, z: 5 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 4,
        height: 2,
      },
      {
        index: 1,
        position: { x: 0, y: 1, z: 10 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 4,
        height: 2,
      },
    ],
    aiSplines: [
      {
        id: 'main',
        points: [
          { x: 0, y: 0.5, z: 0 },
          { x: 0, y: 0.5, z: 5 },
          { x: 0, y: 0.5, z: 10 },
        ],
      },
    ],
    pickupSpawns: [{ x: 0, y: 1, z: 7 }],
    boostPads: [],
  }
}
