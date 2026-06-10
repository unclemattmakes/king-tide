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
    expect(track.water).toEqual({ height: 0 })
  })

  it('water: reads optional swellBearingDeg, ignores the deprecated dead knobs', () => {
    const raw = baseTrack()
    // Old JSONs (and old Blender exports) carry the dead waveHeight /
    // waveFreq pair — the loader must tolerate AND drop them, so nothing
    // downstream can "tune" a knob the wave field never reads.
    raw.water = { height: -1.5, swellBearingDeg: 120, waveHeight: 1, waveFreq: 0.5 }
    const track = buildTrackFromJson(raw)
    expect(track.water).toEqual({ height: -1.5, swellBearingDeg: 120 })
    // Absent bearing stays absent (boot falls back to WAVE_BEARING_DEFAULT).
    const rawNoBearing = baseTrack()
    rawNoBearing.water = { height: 2 }
    expect(buildTrackFromJson(rawNoBearing).water).toEqual({ height: 2 })
  })

  it('water: reads the optional spectrum block, validates the preset name', () => {
    const raw = baseTrack()
    raw.water = {
      height: 0,
      spectrum: { preset: 'open-swell', seed: 3, components: 14, swellBias: 0.7 },
    }
    const track = buildTrackFromJson(raw)
    expect(track.water?.spectrum).toEqual({
      preset: 'open-swell',
      seed: 3,
      components: 14,
      swellBias: 0.7,
    })
    // Spectrum survives the editor's save round-trip — a stripped key
    // would silently revert a track to the default bank on next save.
    expect(buildTrackFromJson(trackToJson(track)).water?.spectrum).toEqual(track.water?.spectrum)

    // Unknown preset = authoring error, not a silent default-bank fallback.
    const rawBadPreset = baseTrack()
    rawBadPreset.water = { height: 0, spectrum: { preset: 'tsunami-madness' } }
    expect(() => buildTrackFromJson(rawBadPreset)).toThrow(/water\.spectrum\.preset/)

    const rawBadShape = baseTrack()
    rawBadShape.water = { height: 0, spectrum: 'open-swell' }
    expect(() => buildTrackFromJson(rawBadShape)).toThrow(/water\.spectrum must be an object/)
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

  it('auto-flips gates that face opposite their next checkpoint', () => {
    // Repros the legacy bug from `derive_track_json`: cps were exported
    // with cp.rotation rotated 180° from the race direction, so race.ts
    // never detected gate crossings (`signed < 0 → >= 0` flip never
    // happened). The loader now corrects on read by comparing each
    // gate's forward to the direction to the next gate.
    const raw = baseTrack()
    raw.checkpoints = [
      // cp 0 at z=10, cp 1 at z=20: race direction = +Z. Rotation Ry(π)
      // puts fwd at -Z, opposite race direction → loader should flip.
      {
        index: 0,
        position: { x: 0, y: 1, z: 10 },
        rotation: { x: 0, y: 1, z: 0, w: 0 },
        halfWidth: 4,
        height: 2,
      },
      {
        index: 1,
        position: { x: 0, y: 1, z: 20 },
        rotation: { x: 0, y: 1, z: 0, w: 0 },
        halfWidth: 4,
        height: 2,
      },
    ]
    const track = buildTrackFromJson(raw)
    const q0 = track.checkpoints[0]!.rotation
    // After the flip, q · (0,0,1) should be along +Z. With original
    // q = (0,1,0,0), the swap-and-negate yields (0,0,0,-1) which is the
    // identity (up to a sign). fwd.x = 0, fwd.z = +1.
    const fwd0x = 2 * (q0.x * q0.z + q0.w * q0.y)
    const fwd0z = 1 - 2 * (q0.x * q0.x + q0.y * q0.y)
    expect(fwd0x).toBeCloseTo(0)
    expect(fwd0z).toBeCloseTo(1)
  })

  it('leaves gates alone when they already face the next checkpoint', () => {
    const raw = baseTrack()
    // baseTrack's cp 0 at z=5 with identity rotation (fwd=+Z) and cp 1
    // at z=10 — already pointing toward the next gate. Auto-fix should
    // be a no-op.
    const track = buildTrackFromJson(raw)
    expect(track.checkpoints[0]!.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 })
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

  it('round-trips an optional audio palette block', () => {
    const raw = baseTrack()
    raw.audio = {
      music: 'south-beach-vaporwave.opus',
      ambient: ['gulls.opus', 'surf-light.opus', 'neon-hum.opus'],
      ambientGains: [0.4, 0.6, 0.2],
      music3dEffects: { duckOnPump: 0.35 },
    }
    const built = buildTrackFromJson(raw)
    expect(built.audio).toEqual({
      music: 'south-beach-vaporwave.opus',
      ambient: ['gulls.opus', 'surf-light.opus', 'neon-hum.opus'],
      ambientGains: [0.4, 0.6, 0.2],
      music3dEffects: { duckOnPump: 0.35 },
    })
    const back = trackToJson(built)
    const rebuilt = buildTrackFromJson(back)
    expect(rebuilt.audio).toEqual(built.audio)
  })

  it('treats audio as fully optional (omitted on tracks that do not need it)', () => {
    const raw = baseTrack()
    expect('audio' in raw).toBe(false)
    const built = buildTrackFromJson(raw)
    expect(built.audio).toBeUndefined()
  })

  it('accepts an audio block with only ambient layers (no music)', () => {
    const raw = baseTrack()
    raw.audio = { ambient: ['surf.opus'] }
    const built = buildTrackFromJson(raw)
    expect(built.audio?.music).toBeUndefined()
    expect(built.audio?.ambient).toEqual(['surf.opus'])
  })

  it('rejects empty audio.music string', () => {
    const raw = baseTrack()
    raw.audio = { music: '' }
    expect(() => buildTrackFromJson(raw)).toThrow(/audio\.music must be a non-empty string/)
  })

  it('rejects audio.ambientGains without a matching audio.ambient', () => {
    const raw = baseTrack()
    raw.audio = { ambientGains: [0.5, 0.5] }
    expect(() => buildTrackFromJson(raw)).toThrow(
      /audio\.ambientGains requires a matching audio\.ambient/,
    )
  })

  it('rejects audio.ambient / ambientGains length mismatch', () => {
    const raw = baseTrack()
    raw.audio = {
      ambient: ['a.opus', 'b.opus'],
      ambientGains: [0.5],
    }
    expect(() => buildTrackFromJson(raw)).toThrow(
      /audio\.ambientGains length \(1\) must match audio\.ambient length \(2\)/,
    )
  })

  it('rejects negative audio.ambientGains entries', () => {
    const raw = baseTrack()
    raw.audio = {
      ambient: ['a.opus'],
      ambientGains: [-0.1],
    }
    expect(() => buildTrackFromJson(raw)).toThrow(/audio\.ambientGains\[0\] must be non-negative/)
  })

  it('rejects non-string audio.ambient entries', () => {
    const raw = baseTrack()
    raw.audio = { ambient: ['ok.opus', 42] as unknown[] }
    expect(() => buildTrackFromJson(raw)).toThrow(/audio\.ambient\[1\] must be a non-empty string/)
  })

  it('rejects negative audio.music3dEffects.duckOnPump', () => {
    const raw = baseTrack()
    raw.audio = { music3dEffects: { duckOnPump: -0.5 } }
    expect(() => buildTrackFromJson(raw)).toThrow(/duckOnPump must be non-negative/)
  })

  it('round-trips colorGrade, bloom, and seaStateBeaufort', () => {
    const raw = baseTrack()
    raw.sky = {
      colorGrade: 'tokyo_neon',
      bloom: 0.8,
      seaStateBeaufort: 7,
      timeOfDay: 180,
    }
    const built = buildTrackFromJson(raw)
    expect(built.sky).toEqual({
      colorGrade: 'tokyo_neon',
      bloom: 0.8,
      seaStateBeaufort: 7,
      timeOfDay: 180,
    })
    const back = trackToJson(built)
    const rebuilt = buildTrackFromJson(back)
    expect(rebuilt.sky).toEqual(built.sky)
  })

  it('accepts every bundled colorGrade preset', () => {
    for (const grade of [
      'neutral',
      'miami_pastel',
      'mexico_city_rosa',
      'tokyo_neon',
      'big_sur_golden',
      'venice_warm',
      'nyc_sunset',
      'cape_town_blue',
      'kilauea_volcanic',
    ]) {
      const raw = baseTrack()
      raw.sky = { colorGrade: grade }
      const built = buildTrackFromJson(raw)
      expect(built.sky?.colorGrade).toBe(grade)
    }
  })

  it('rejects unknown sky.colorGrade strings', () => {
    const raw = baseTrack()
    raw.sky = { colorGrade: 'bogus_preset' }
    expect(() => buildTrackFromJson(raw)).toThrow(/sky\.colorGrade must be one of/)
  })

  it('rejects non-string sky.colorGrade values', () => {
    const raw = baseTrack()
    raw.sky = { colorGrade: 42 }
    expect(() => buildTrackFromJson(raw)).toThrow(/sky\.colorGrade must be one of/)
  })

  it('rejects sky.bloom outside [0, 2]', () => {
    const raw = baseTrack()
    raw.sky = { bloom: 2.5 }
    expect(() => buildTrackFromJson(raw)).toThrow(/sky\.bloom must be in \[0, 2\]/)
    raw.sky = { bloom: -0.1 }
    expect(() => buildTrackFromJson(raw)).toThrow(/sky\.bloom must be in \[0, 2\]/)
  })

  it('rejects non-finite sky.bloom', () => {
    const raw = baseTrack()
    raw.sky = { bloom: 'bright' }
    expect(() => buildTrackFromJson(raw)).toThrow(/sky\.bloom must be a finite number/)
  })

  it('rejects sky.seaStateBeaufort outside [0, 12]', () => {
    const raw = baseTrack()
    raw.sky = { seaStateBeaufort: 13 }
    expect(() => buildTrackFromJson(raw)).toThrow(/sky\.seaStateBeaufort must be in \[0, 12\]/)
    raw.sky = { seaStateBeaufort: -1 }
    expect(() => buildTrackFromJson(raw)).toThrow(/sky\.seaStateBeaufort must be in \[0, 12\]/)
  })

  it('accepts integer + fractional sky.seaStateBeaufort values', () => {
    const raw = baseTrack()
    raw.sky = { seaStateBeaufort: 0 }
    expect(buildTrackFromJson(raw).sky?.seaStateBeaufort).toBe(0)
    raw.sky = { seaStateBeaufort: 12 }
    expect(buildTrackFromJson(raw).sky?.seaStateBeaufort).toBe(12)
    raw.sky = { seaStateBeaufort: 4.5 }
    expect(buildTrackFromJson(raw).sky?.seaStateBeaufort).toBe(4.5)
  })

  it('reads boost pad fields', () => {
    const raw = baseTrack()
    raw.boostPads = [
      {
        position: { x: 1, y: 0, z: 2 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 3,
        halfHeight: 5,
        halfDepth: 6,
        strength: 1.7,
      },
    ]
    const track = buildTrackFromJson(raw)
    expect(track.boostPads).toHaveLength(1)
    expect(track.boostPads[0]!.strength).toBe(1.7)
    expect(track.boostPads[0]!.halfHeight).toBe(5)
    expect(track.boostPads[0]!.halfDepth).toBe(6)
  })

  it('defaults halfHeight to a generous band on legacy boost pads without the field', () => {
    // Pre-3D-volume tracks omitted halfHeight and authored pad-Y near
    // origin rather than on the riding surface. The loader fills a generous
    // band (LEGACY_BOOST_PAD_HALF_HEIGHT) so a bike hovering above a
    // high-water surface still triggers the pad. See the constant's doc.
    const raw = baseTrack()
    raw.boostPads = [
      {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 3,
        halfDepth: 6,
        strength: 1.5,
      },
    ]
    const track = buildTrackFromJson(raw)
    // Must comfortably exceed the bike's worst-case ride height over the
    // pad-Y across shipped tracks (~4.8 m), so it never silently misses.
    expect(track.boostPads[0]!.halfHeight).toBeGreaterThanOrEqual(5)
  })

  it('parses a prop surface tag + round-trips it through trackToJson', () => {
    const raw = baseTrack()
    raw.props = [
      {
        type: 'box',
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        size: { x: 5, y: 0.5, z: 5 },
        surface: 'ice',
      },
    ]
    const built = buildTrackFromJson(raw)
    expect(built.props[0]!.surface).toBe('ice')
    const back = trackToJson(built)
    const rebuilt = buildTrackFromJson(back)
    expect(rebuilt.props[0]!.surface).toBe('ice')
  })

  it('drops an unknown surface tag silently (falls back to DEFAULT, no throw)', () => {
    const raw = baseTrack()
    raw.props = [
      {
        type: 'box',
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        size: { x: 5, y: 0.5, z: 5 },
        surface: 'lava-quicksand-typo',
      },
    ]
    const built = buildTrackFromJson(raw)
    // Unknown → field omitted; the runtime treats absent as DEFAULT.
    expect(built.props[0]!.surface).toBeUndefined()
  })

  it('leaves surface undefined when the prop has no tag', () => {
    const raw = baseTrack()
    raw.props = [
      {
        type: 'box',
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        size: { x: 5, y: 0.5, z: 5 },
      },
    ]
    const built = buildTrackFromJson(raw)
    expect(built.props[0]!.surface).toBeUndefined()
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
    water: { height: 0 },
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
