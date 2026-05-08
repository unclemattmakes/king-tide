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
    raw.checkpoints[1].index = 5
    expect(() => buildTrackFromJson(raw)).toThrow(/checkpoints\[1\]\.index = 5/)
  })

  it('rejects aiSplines without a "main" entry', () => {
    const raw = baseTrack()
    raw.aiSplines[0].id = 'alt'
    expect(() => buildTrackFromJson(raw)).toThrow(/missing aiSplines entry with id="main"/)
  })

  it('rejects splines with fewer than 2 points', () => {
    const raw = baseTrack()
    raw.aiSplines[0].points = [{ x: 0, y: 0, z: 0 }]
    expect(() => buildTrackFromJson(raw)).toThrow(/at least 2 entries/)
  })

  it('reads optional environmentGlb + water but tolerates absence', () => {
    const raw = baseTrack()
    delete raw.environmentGlb
    delete raw.water
    const track = buildTrackFromJson(raw)
    expect(track.environmentGlb).toBeUndefined()
    expect(track.water).toBeUndefined()
  })

  it('defaults missing pickupSpawns and boostPads to empty arrays', () => {
    const raw = baseTrack()
    delete raw.pickupSpawns
    delete raw.boostPads
    const track = buildTrackFromJson(raw)
    expect(track.pickupSpawns).toEqual([])
    expect(track.boostPads).toEqual([])
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

function baseTrack() {
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
