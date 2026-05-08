import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTrackFromGltf, type GltfRoot, parseGlbJson } from '@/game/tracks/glb-loader'

const REPO_ROOT = path.resolve(__dirname, '../..')
const CALIBRATION_GLB = path.join(REPO_ROOT, 'public', 'assets', 'tracks', 'calibration.glb')

describe('parseGlbJson', () => {
  it('reads the JSON chunk out of a real .glb produced by the build pipeline', () => {
    const buf = fs.readFileSync(CALIBRATION_GLB)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const gltf = parseGlbJson(ab)
    expect(gltf.nodes?.length).toBeGreaterThan(0)
    const names = new Set((gltf.nodes ?? []).map((n) => n.name))
    expect(names.has('cp_00')).toBe(true)
    expect(names.has('cp_03')).toBe(true)
    expect(names.has('ai_spline_main')).toBe(true)
    expect(names.has('start_00')).toBe(true)
    expect(names.has('pickup_main')).toBe(true)
    expect(names.has('water_volume_main')).toBe(true)
  })

  it('rejects a buffer with the wrong magic', () => {
    const buf = new ArrayBuffer(20)
    new DataView(buf).setUint32(0, 0xdeadbeef, true)
    expect(() => parseGlbJson(buf)).toThrow(/invalid magic/)
  })
})

describe('buildTrackFromGltf', () => {
  it('builds a complete Track from the calibration .glb', () => {
    const buf = fs.readFileSync(CALIBRATION_GLB)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const gltf = parseGlbJson(ab)
    const track = buildTrackFromGltf(gltf, {
      id: 'calibration',
      name: 'Calibration',
      lapsToFinish: 1,
    })

    expect(track.id).toBe('calibration')
    expect(track.lapsToFinish).toBe(1)
    expect(track.checkpoints).toHaveLength(4)
    // Indices contiguous starting at 0.
    expect(track.checkpoints.map((cp) => cp.index)).toEqual([0, 1, 2, 3])
    // Each checkpoint has the gate envelope from extras.
    for (const cp of track.checkpoints) {
      expect(cp.halfWidth).toBe(4)
      expect(cp.height).toBe(2)
    }
    expect(track.pickupSpawns).toHaveLength(1)
    expect(track.aiSplines).toHaveLength(1)
    expect(track.aiSplines[0]!.id).toBe('main')
    // Spline was sampled at Blender's default curve resolution_u — should
    // be tens of points, not zero.
    expect(track.aiSplines[0]!.points.length).toBeGreaterThan(10)
    // Start pose populated.
    expect(track.start.position.y).toBeGreaterThan(0)
  })

  it('throws when an ai_spline has no points', () => {
    const gltf: GltfRoot = {
      nodes: [
        {
          name: 'start_00',
          translation: [0, 0, 0],
          extras: { kind: 'start', index: 0 },
        },
        {
          name: 'cp_00',
          extras: { kind: 'checkpoint', index: 0, half_width: 4, height: 2 },
        },
        {
          name: 'ai_spline_main',
          extras: { kind: 'ai_spline', branch: 'main' }, // no points
        },
      ],
    }
    expect(() => buildTrackFromGltf(gltf, { id: 't', name: 't', lapsToFinish: 1 })).toThrow(
      /extras.points/,
    )
  })

  it('throws when checkpoint indices are not contiguous', () => {
    const gltf: GltfRoot = {
      nodes: [
        { name: 'start_00', extras: { kind: 'start', index: 0 } },
        {
          name: 'cp_00',
          extras: { kind: 'checkpoint', index: 0, half_width: 4, height: 2 },
        },
        {
          name: 'cp_02',
          extras: { kind: 'checkpoint', index: 2, half_width: 4, height: 2 },
        },
        {
          name: 'ai_spline_main',
          extras: { kind: 'ai_spline', branch: 'main', points: [0, 0, 0, 1, 0, 0] },
        },
      ],
    }
    expect(() => buildTrackFromGltf(gltf, { id: 't', name: 't', lapsToFinish: 1 })).toThrow(
      /contiguous/,
    )
  })

  it('throws when ai_spline_main is missing', () => {
    const gltf: GltfRoot = {
      nodes: [
        { name: 'start_00', extras: { kind: 'start', index: 0 } },
        {
          name: 'cp_00',
          extras: { kind: 'checkpoint', index: 0, half_width: 4, height: 2 },
        },
        // Only an _alt branch, no main.
        {
          name: 'ai_spline_alt',
          extras: { kind: 'ai_spline', branch: 'alt', points: [0, 0, 0, 1, 0, 0] },
        },
      ],
    }
    expect(() => buildTrackFromGltf(gltf, { id: 't', name: 't', lapsToFinish: 1 })).toThrow(
      /branch=main/,
    )
  })
})
