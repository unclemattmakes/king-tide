import { describe, expect, it } from 'vitest'
import { applyNumEdit, applyPropFlag } from '@/engine/editor/field-edits'
import { placeAt } from '@/engine/editor/placement'
import { createUndoStack } from '@/engine/editor/undo-redo'
import { buildTrackFromJson } from '@/game/tracks/json-loader'
import type { Prop, Track } from '@/game/tracks/types'

/** A minimal-but-valid runtime Track, built through the real loader so every
 *  array the editor touches (props / waveZones / antiGravZones / …) exists. */
function makeTrack(): Track {
  return buildTrackFromJson({
    id: 'edit-test',
    name: 'Edit Test',
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
    pickupSpawns: [{ x: 0, y: 1, z: 2 }],
    boostPads: [
      {
        position: { x: 1, y: 4, z: 1 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 3,
        halfHeight: 4,
        halfDepth: 6,
        strength: 1.5,
      },
    ],
  })
}

describe('applyNumEdit', () => {
  it('writes a free gate position axis and clamps dimensions', () => {
    const t = makeTrack()
    applyNumEdit(t, { kind: 'gate', index: 0 }, 'pos.x', 12.5)
    expect(t.checkpoints[0]!.position.x).toBe(12.5)
    applyNumEdit(t, { kind: 'gate', index: 0 }, 'halfWidth', 999)
    expect(t.checkpoints[0]!.halfWidth).toBe(200) // clamped to the gate max
    applyNumEdit(t, { kind: 'gate', index: 0 }, 'height', 0.01)
    expect(t.checkpoints[0]!.height).toBe(0.5) // clamped to the gate min
  })

  it('edits boost-pad strength (the previously-unreachable scalar)', () => {
    const t = makeTrack()
    applyNumEdit(t, { kind: 'pad', index: 0 }, 'strength', 2.4)
    expect(t.boostPads[0]!.strength).toBeCloseTo(2.4)
    applyNumEdit(t, { kind: 'pad', index: 0 }, 'strength', 99)
    expect(t.boostPads[0]!.strength).toBe(5) // clamped
  })

  it('converts start yaw from degrees to radians', () => {
    const t = makeTrack()
    applyNumEdit(t, { kind: 'start' }, 'yawDeg', 90)
    expect(t.start.yaw).toBeCloseTo(Math.PI / 2)
  })

  it('keeps prop size strictly positive', () => {
    const t = makeTrack()
    t.props.push({
      type: 'box',
      position: { x: 0, y: 1, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      size: { x: 2, y: 2, z: 2 },
    })
    applyNumEdit(t, { kind: 'prop', index: 0 }, 'size.y', -5)
    expect(t.props[0]!.size.y).toBe(0.01)
  })

  it('materialises a wave-zone surge amplitude when the period is first set', () => {
    const t = makeTrack()
    t.waveZones.push({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      halfWidth: 40,
      halfHeight: 10,
      halfDepth: 40,
      heightMult: 1,
      freqMult: 1,
      blendRadiusM: 20,
    })
    applyNumEdit(t, { kind: 'waveZone', index: 0 }, 'surgePeriodS', 30)
    expect(t.waveZones[0]!.surgePeriodS).toBe(30)
    // The loader rejects a period without an amplitude — it must be seeded.
    expect(t.waveZones[0]!.surgeAmplitude).toBe(1)
  })
})

describe('applyPropFlag', () => {
  const baseProp = (): Prop => ({
    type: 'asset',
    assetId: 'buoy',
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    size: { x: 1, y: 1, z: 1 },
  })

  it('stores a real surface override but not the implicit default', () => {
    const p = baseProp()
    applyPropFlag(p, 'surface', 'metal')
    expect(p.surface).toBe('metal')
    applyPropFlag(p, 'surface', 'default')
    expect(p.surface).toBeUndefined()
  })

  it('persists only the waterline opt-out', () => {
    const p = baseProp()
    applyPropFlag(p, 'waterline', false)
    expect(p.waterline).toBe(false)
    applyPropFlag(p, 'waterline', true)
    expect(p.waterline).toBeUndefined()
  })

  it('toggles wave-rider float and its dof', () => {
    const p = baseProp()
    applyPropFlag(p, 'waveRider', true)
    expect(p.waveRider).toEqual({ dof: 'locked' })
    applyPropFlag(p, 'waveRiderDof', 'yaw')
    expect(p.waveRider).toEqual({ dof: 'yaw' })
    applyPropFlag(p, 'waveRider', false)
    expect(p.waveRider).toBeUndefined()
  })
})

describe('placeAt: wave zones', () => {
  it('places a neutral-ish zone and caps the track at 8', () => {
    const t = makeTrack()
    for (let i = 0; i < 8; i++) {
      const sel = placeAt({
        draft: t,
        hit: { x: i, y: 0, z: 0 },
        tool: 'waveZone',
        pickedAssetId: '',
      })
      expect(sel).toEqual({ kind: 'waveZone', index: i })
    }
    expect(t.waveZones).toHaveLength(8)
    expect(t.waveZones[0]!.heightMult).toBeGreaterThan(0)
    expect(t.waveZones[0]!.blendRadiusM).toBeGreaterThan(0)
    // A 9th is refused so the editor never desyncs from the runtime cap.
    const overflow = placeAt({
      draft: t,
      hit: { x: 9, y: 0, z: 0 },
      tool: 'waveZone',
      pickedAssetId: '',
    })
    expect(overflow).toBeNull()
    expect(t.waveZones).toHaveLength(8)
  })
})

describe('createUndoStack: generic restore', () => {
  it('reverts blocks beyond the old hand-maintained field list (sky, waveZones)', () => {
    const t = makeTrack()
    const undo = createUndoStack(t, () => {})
    expect(t.sky).toBeUndefined()
    const zonesBefore = t.waveZones.length

    undo.push()
    // Author new atmosphere + a wave zone — exactly the blocks the old
    // tryUndo restore omitted.
    t.sky = { cloudiness: 0.9, colorGrade: 'tokyo_neon' }
    t.waveZones.push({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      halfWidth: 40,
      halfHeight: 10,
      halfDepth: 40,
      heightMult: 2,
      freqMult: 1,
      blendRadiusM: 20,
    })

    expect(undo.tryUndo()).toBe(true)
    expect(t.sky).toBeUndefined()
    expect(t.waveZones).toHaveLength(zonesBefore)
  })
})
