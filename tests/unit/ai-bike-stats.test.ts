/**
 * Regression: AI opponents must ride the SIM STATS of the bike variant
 * their grid slot maps to — not a one-size-fits-all default.
 *
 * The bug: `spawnBikes` created every AI via `createBike(..., { ai })`
 * with no `stats`, so each fell back to `defaultBikeStats()` (Racer). A
 * Cruiser AI handled exactly like a Sparrow AI; the broadcast roster
 * showed five archetypes that all drove identically. These tests drive
 * the real spawn path (Rapier-backed, same infra as rider-spawn) and
 * assert each AI's `BikeStatsStore` entry matches `variantForAiSlot`.
 */
import { describe, expect, it } from 'vitest'
import { spawnBikes } from '@/boot/spawn-bikes'
import { createSimWorld } from '@/engine/sim/ecs/world'
import { createPhysicsWorld } from '@/engine/sim/physics/rapier'
import { resolveBikeVariant, variantForAiSlot } from '@/game/bikes/variants'
import { BikeStatsStore } from '@/game/components'
import type { Track } from '@/game/tracks/types'

// Minimal stub — `spawnBikes` only reads `track.start` on the live path.
const TRACK_STUB = {
  start: { position: { x: 0, y: 5, z: 0 }, yaw: 0 },
} as unknown as Track

async function spawnFiveAi() {
  const sim = createSimWorld()
  const phys = await createPhysicsWorld()
  const result = spawnBikes({
    sim,
    phys,
    track: TRACK_STUB,
    playerVariant: resolveBikeVariant('racer'),
    activeReplay: null,
    aiCount: 5,
  })
  return result
}

describe('AI bikes ride their variant stats', () => {
  it('each AI slot is spawned with the sim stats of its rotation variant', async () => {
    const { aiEids } = await spawnFiveAi()
    expect(aiEids.length).toBe(5)
    aiEids.forEach((eid, i) => {
      const expected = variantForAiSlot(i + 1).stats
      const actual = BikeStatsStore.must(eid)
      // Spot-check the headline handling numbers that define the archetype.
      expect(actual.mass).toBe(expected.mass)
      expect(actual.topSpeed).toBe(expected.topSpeed)
      expect(actual.turnTorque).toBe(expected.turnTorque)
      expect(actual.surfaceFollow).toBe(expected.surfaceFollow)
      expect(actual.hoverSpring).toBe(expected.hoverSpring)
    })
  })

  it('does NOT spawn the whole field on identical default stats — the bug', async () => {
    const { aiEids } = await spawnFiveAi()
    // Rotation = cruiser(200) · stunt(115) · racer(150) · scout(220) ·
    // sparrow(80): five distinct masses. Before the fix this set was {150}.
    const masses = aiEids.map((eid) => BikeStatsStore.must(eid).mass)
    expect(new Set(masses).size).toBeGreaterThan(1)
  })

  it('gives each AI its own stats object (no shared mutable reference)', async () => {
    const { aiEids } = await spawnFiveAi()
    // The rotation repeats variants (cruiser at slots 1 & 6), so spawning
    // must spread a fresh stats object per bike — otherwise two AIs would
    // share one reference and a runtime mutation on one would hit both.
    const statsObjs = aiEids.map((eid) => BikeStatsStore.must(eid))
    expect(new Set(statsObjs).size).toBe(statsObjs.length)
  })
})
