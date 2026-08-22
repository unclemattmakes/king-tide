/**
 * Spatial one-shot placement — the pure half of the positional-audio
 * pass (evaluation summary #5). Pins the distance-gain curve and the
 * pan sign convention so "mine on your right sounds on the right"
 * can't silently flip.
 */

import { describe, expect, it } from 'vitest'
import {
  SPATIAL_NEAR_FULL_M,
  SPATIAL_REF_DISTANCE_M,
  spatialCueFor,
} from '../../src/engine/audio/audio'

const ORIGIN = { x: 0, y: 0, z: 0 }
const RIGHT = { x: 1, y: 0, z: 0 } // identity-camera right

describe('spatialCueFor', () => {
  it('is full volume and centered at the listener', () => {
    expect(spatialCueFor(ORIGIN, ORIGIN, RIGHT)).toEqual({ gain: 1, pan: 0 })
  })

  it('keeps a near-field plateau — the chase camera must not attenuate own-bike events', () => {
    // The listener is the chase camera, ~4-12 m behind the player's
    // bike; without the plateau the player's own missile fire and a
    // mine at their wheel played quieter than before spatialization.
    const at = (d: number) => spatialCueFor({ x: 0, y: 0, z: d }, ORIGIN, RIGHT).gain
    expect(at(4)).toBe(1)
    expect(at(SPATIAL_NEAR_FULL_M)).toBe(1)
    expect(at(SPATIAL_NEAR_FULL_M + 1)).toBeLessThan(1)
  })

  it('halves one ref-distance past the near field and keeps falling monotonically', () => {
    const at = (d: number) => spatialCueFor({ x: 0, y: 0, z: d }, ORIGIN, RIGHT).gain
    expect(at(SPATIAL_NEAR_FULL_M + SPATIAL_REF_DISTANCE_M)).toBeCloseTo(0.5, 5)
    expect(at(300)).toBeLessThan(0.15) // the "mine 300 m away" case
    expect(at(20)).toBeGreaterThan(at(50))
    expect(at(50)).toBeGreaterThan(at(200))
  })

  it('pans toward the emitter side, never hard-panned', () => {
    const right = spatialCueFor({ x: 50, y: 0, z: 0 }, ORIGIN, RIGHT)
    const left = spatialCueFor({ x: -50, y: 0, z: 0 }, ORIGIN, RIGHT)
    expect(right.pan).toBeGreaterThan(0.5)
    expect(left.pan).toBeLessThan(-0.5)
    expect(Math.abs(right.pan)).toBeLessThan(1)
    expect(right.pan).toBeCloseTo(-left.pan, 5)
    // Dead ahead = centered.
    expect(spatialCueFor({ x: 0, y: 0, z: 60 }, ORIGIN, RIGHT).pan).toBeCloseTo(0, 5)
  })

  it('respects a rotated listener frame', () => {
    // Camera yawed 180°: right is now world -X, so an emitter at +X
    // must pan LEFT.
    const flippedRight = { x: -1, y: 0, z: 0 }
    expect(spatialCueFor({ x: 50, y: 0, z: 0 }, ORIGIN, flippedRight).pan).toBeLessThan(0)
  })
})
