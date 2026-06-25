import { describe, expect, it } from 'vitest'
import {
  createEditorFloatPreview,
  type FloatState,
  quatYaw,
  stepFloat,
} from '@/engine/editor/editor-wave-rider'
import { advanceWaveField, createWaveField, defaultWaves } from '@/engine/sim/water/wave-field'
import { deriveWaveRiderTuning } from '@/game/components/wave-rider'
import { buildTrackFromJson } from '@/game/tracks/json-loader'
import type { Track } from '@/game/tracks/types'

function floatState(restOffsetY = 0.5): FloatState {
  return {
    propIndex: 0,
    tuning: deriveWaveRiderTuning({
      halfHeight: 0.45,
      footprint: 0.45,
      restOffsetY,
      dof: 'locked',
    }),
    anchorX: 8,
    anchorZ: -4,
    perturbY: 0,
    perturbYVel: 0,
    tiltDirX: 0,
    tiltDirZ: 0,
    tiltVelX: 0,
    tiltVelZ: 0,
    yawDrift: 0,
  }
}

describe('quatYaw', () => {
  it('recovers the yaw of a pure-Y quaternion', () => {
    const yaw = Math.PI / 3
    const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }
    expect(quatYaw(q)).toBeCloseTo(yaw, 6)
  })
})

describe('stepFloat', () => {
  it('rests near surface + offset and moves as the wave field advances', () => {
    const field = createWaveField(defaultWaves(), { baseY: 0 })
    advanceWaveField(field, 0.5)
    const s = floatState(0.5)
    const a = stepFloat(s, field, 1 / 60)
    // At rest the body sits ~ restOffset above the local surface.
    expect(a.y).toBeGreaterThan(0) // floating above mean sea
    // Advance time → the surface (and the float) move.
    advanceWaveField(field, 1.0)
    const b = stepFloat(s, field, 1 / 60)
    expect(b.y).not.toBeCloseTo(a.y, 4)
  })

  it('returns to rest after a tilt perturbation (spring is stable)', () => {
    const field = createWaveField(defaultWaves(), { baseY: 0 })
    const s = floatState(0.5)
    s.tiltDirX = 0.4 // knock it over
    let last = Math.hypot(s.tiltDirX, s.tiltDirZ)
    for (let i = 0; i < 600; i++) stepFloat(s, field, 1 / 60)
    const settled = Math.hypot(s.tiltDirX, s.tiltDirZ)
    // The tilt perturbation decays well below the initial knock.
    expect(settled).toBeLessThan(last * 0.5)
    last = settled
    expect(Number.isFinite(settled)).toBe(true)
  })
})

function trackWithProps(): Track {
  const t = buildTrackFromJson({
    id: 'float-test',
    name: 'Float Test',
    lapsToFinish: 1,
    environmentGlb: '/x.glb',
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
    pickupSpawns: [],
    boostPads: [],
  })
  t.props = [
    {
      type: 'box',
      position: { x: 2, y: 1, z: 2 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      size: { x: 1, y: 1, z: 1 },
      waveRider: { dof: 'locked' }, // per-instance float
    },
    {
      type: 'asset',
      assetId: 'buoy',
      position: { x: 4, y: 0, z: 4 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      size: { x: 1, y: 1, z: 1 }, // floats via the wave-rider ASSET set
    },
    {
      type: 'box',
      position: { x: 6, y: 1, z: 6 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      size: { x: 1, y: 1, z: 1 }, // static — no float
    },
  ]
  return t
}

describe('createEditorFloatPreview', () => {
  it('floats per-instance waveRiders AND wave-rider assets, not static props', () => {
    const field = createWaveField(defaultWaves(), { baseY: 0 })
    const preview = createEditorFloatPreview(trackWithProps(), field, new Set(['buoy']))
    preview.step(1 / 60)
    // Indices 0 (per-instance) and 1 (buoy asset) float; index 2 (plain box)
    // does not.
    expect(preview.poses.has(0)).toBe(true)
    expect(preview.poses.has(1)).toBe(true)
    expect(preview.poses.has(2)).toBe(false)
  })

  it('rebuild picks up a newly-floated prop', () => {
    const field = createWaveField(defaultWaves(), { baseY: 0 })
    const track = trackWithProps()
    const preview = createEditorFloatPreview(track, field, new Set(['buoy']))
    expect(preview.poses.has(2)).toBe(false)
    // Author toggles float on the previously-static prop.
    track.props[2]!.waveRider = { dof: 'yaw' }
    preview.rebuild()
    preview.step(1 / 60)
    expect(preview.poses.has(2)).toBe(true)
  })
})
