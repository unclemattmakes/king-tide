/**
 * Floating checkpoint gates — the render-side bob (`TrackVisuals.tick`).
 *
 * A gate over water rides the wave surface; a gate raised onto dry land
 * stays at its authored height even with the track toggle on. Indices 1/2
 * avoid the start/finish gate's canvas banner (jsdom has no 2D context).
 */
import { describe, expect, it } from 'vitest'
import { createTrackVisuals } from '../../src/engine/render/track-mesh'
import { createWaveField, sampleHeight } from '../../src/engine/sim/water/wave-field'
import type { Checkpoint, Track } from '../../src/game/tracks/types'

function cp(index: number, x: number, y: number, z: number): Checkpoint {
  return {
    index,
    position: { x, y, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    halfWidth: 10,
    height: 6,
  }
}

function makeTrack(floatGates: boolean): Track {
  return {
    id: 'gate-float-test',
    checkpoints: [cp(1, 0, 30, 0), cp(2, 5, 0, 5)], // land gate (high), water gate
    boostPads: [],
    antiGravZones: [],
    floatGates,
    water: { height: 0 },
  } as unknown as Track
}

const FIELD = createWaveField(
  [{ dirX: 1, dirZ: 0, amplitude: 0.5, wavelength: 8, speed: 0, phase: 0 }],
  { baseY: 0 },
)

describe('floating checkpoint gates (visual bob)', () => {
  it('bobs gates over water and leaves land gates static', () => {
    const vis = createTrackVisuals(makeTrack(true), {})
    const land = vis.group.getObjectByName('gate:1')!
    const water = vis.group.getObjectByName('gate:2')!
    expect(water.position.y).toBeCloseTo(0, 5) // authored rest height
    vis.tick(FIELD)
    // Water gate rides the surface at its XZ; land gate (base 30 m up) stays.
    expect(water.position.y).toBeCloseTo(sampleHeight(FIELD, 5, 5), 5)
    expect(land.position.y).toBeCloseTo(30, 5)
    vis.dispose()
  })

  it('is a no-op when floatGates is off', () => {
    const vis = createTrackVisuals(makeTrack(false), {})
    const water = vis.group.getObjectByName('gate:2')!
    vis.tick(FIELD)
    expect(water.position.y).toBeCloseTo(0, 5)
    vis.dispose()
  })
})
