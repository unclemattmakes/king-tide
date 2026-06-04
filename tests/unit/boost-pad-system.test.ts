/**
 * Boost-pad system integration — `src/game/systems/boost-pad.ts`.
 *
 * `boost-pad.test.ts` pins the `isOverBoostPad` geometry; this suite covers
 * the system that wraps it: that sitting on a pad actually attaches a
 * `BoostEffect` whose multiplier reaches `getCurrentBoostMultiplier` (the
 * value the hover thrust reads), that the effect survives the same-tick
 * `boostTickSystem` decrement, and — the regression that motivated the
 * generous legacy band — that a bike hovering above a high-water surface
 * still triggers a legacy pad loaded through `buildTrackFromJson`.
 *
 * Uses a minimal Rapier mock (only `translation()` is needed) so no WASM.
 */

import { addComponent, addEntity } from 'bitecs'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSimWorld, type SimWorld } from '../../src/engine/sim/ecs/world'
import type { PhysicsWorld } from '../../src/engine/sim/physics/rapier'
import { BikeTag, RBHandle, RBHandleStore } from '../../src/game/components'
import { BoostEffectStore } from '../../src/game/components/pickup'
import { boostPadSystem } from '../../src/game/systems/boost-pad'
import { boostTickSystem, getCurrentBoostMultiplier } from '../../src/game/systems/pickup'
import { buildTrackFromJson } from '../../src/game/tracks/json-loader'
import type { BoostPad, Track } from '../../src/game/tracks/types'

const HANDLE = 1

function physAt(pos: { x: number; y: number; z: number }): PhysicsWorld {
  const rb = { translation: () => pos }
  return {
    world: { getRigidBody: (h: number) => (h === HANDLE ? rb : null) },
    fixedDt: 1 / 60,
  } as unknown as PhysicsWorld
}

function spawnBike(sim: SimWorld): number {
  const eid = addEntity(sim)
  addComponent(sim, eid, BikeTag)
  addComponent(sim, eid, RBHandle)
  RBHandleStore.set(eid, { handle: HANDLE })
  return eid
}

function padAt(pos: { x: number; y: number; z: number }, halfHeight = 4, strength = 1.5): BoostPad {
  return {
    position: pos,
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    halfWidth: 3,
    halfHeight,
    halfDepth: 6,
    strength,
  }
}

function trackWith(pads: BoostPad[]): Track {
  return { boostPads: pads } as unknown as Track
}

/** Minimal valid track JSON carrying a single legacy boost pad (no
 *  `halfHeight`) so `buildTrackFromJson` fills the real loader default. */
function trackJsonWithLegacyPad(pad: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'unit-test',
    name: 'Unit Test',
    lapsToFinish: 1,
    environmentGlb: '/assets/tracks/x.glb',
    water: { height: 3.3, waveHeight: 1, waveFreq: 0.5 },
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
          { x: 0, y: 0.5, z: 10 },
        ],
      },
    ],
    pickupSpawns: [],
    boostPads: [pad],
  }
}

describe('boostPadSystem', () => {
  // The component stores are module-global Maps keyed by entity id, and a
  // fresh sim world reuses low ids — so clear BoostEffect between cases or a
  // prior test's effect leaks in and the "stronger wins" merge masks the new
  // pad's multiplier.
  beforeEach(() => {
    const stale: number[] = []
    BoostEffectStore.forEach((_, eid) => {
      stale.push(eid)
    })
    for (const eid of stale) BoostEffectStore.delete(eid)
  })

  it('attaches a BoostEffect whose multiplier reaches getCurrentBoostMultiplier', () => {
    const sim = createSimWorld()
    const eid = spawnBike(sim)
    const pad = padAt({ x: 10, y: 0, z: 20 }, 4, 1.6)

    boostPadSystem(sim, physAt(pad.position), trackWith([pad]))

    expect(BoostEffectStore.has(eid)).toBe(true)
    expect(getCurrentBoostMultiplier(eid)).toBeCloseTo(1.6)
  })

  it('applies no boost when the bike is off the pad', () => {
    const sim = createSimWorld()
    const eid = spawnBike(sim)
    const pad = padAt({ x: 0, y: 0, z: 0 })

    boostPadSystem(sim, physAt({ x: 100, y: 0, z: 100 }), trackWith([pad]))

    expect(getCurrentBoostMultiplier(eid)).toBe(1)
  })

  it('keeps the boost alive through the same-tick boostTickSystem decrement', () => {
    const sim = createSimWorld()
    const eid = spawnBike(sim)
    const pad = padAt({ x: 0, y: 0, z: 0 }, 4, 1.5)
    const phys = physAt(pad.position)

    // sim-step.ts order: pad refresh, then the global boost-timer decrement.
    boostPadSystem(sim, phys, trackWith([pad]))
    boostTickSystem(sim, phys.fixedDt)

    expect(getCurrentBoostMultiplier(eid)).toBeCloseTo(1.5)
  })

  it('lingers briefly after leaving the pad, then expires', () => {
    const sim = createSimWorld()
    const eid = spawnBike(sim)
    const pad = padAt({ x: 0, y: 0, z: 0 }, 4, 1.5)

    boostPadSystem(sim, physAt(pad.position), trackWith([pad]))
    // Bike has left the pad — no more refresh, only the timer ticking down.
    const offPad = trackWith([pad])
    boostPadSystem(sim, physAt({ x: 50, y: 0, z: 0 }), offPad)
    expect(getCurrentBoostMultiplier(eid)).toBeCloseTo(1.5) // still within ~0.25 s

    // Drain the short refresh window.
    for (let i = 0; i < 20; i++) boostTickSystem(sim, 1 / 60)
    expect(getCurrentBoostMultiplier(eid)).toBe(1)
  })

  it('triggers a legacy pad even when the bike hovers above a high-water surface', () => {
    // The regression: a legacy pad (no authored halfHeight) on a track with
    // water at +3.3 m. The bike rides ~4.5 m; the historic 3 m band missed
    // it. Load through buildTrackFromJson so the real generous default
    // (LEGACY_BOOST_PAD_HALF_HEIGHT) is what's exercised.
    const track = buildTrackFromJson(
      trackJsonWithLegacyPad({
        position: { x: 0, y: 0.1, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 3,
        halfDepth: 6,
        strength: 1.4,
      }),
    )

    const sim = createSimWorld()
    const eid = spawnBike(sim)
    boostPadSystem(sim, physAt({ x: 0, y: 4.5, z: 0 }), track)

    expect(getCurrentBoostMultiplier(eid)).toBeCloseTo(1.4)
  })
})
