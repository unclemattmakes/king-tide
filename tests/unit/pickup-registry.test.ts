/**
 * Pickup registry (docs/systems-review.md §6.3) — the single table that
 * replaced the three parallel switch statements. Covers the `use` effects and
 * the AI precompute flags; `aiShouldFire` per type is covered via
 * ai-combat.test.ts (which delegates through the registry).
 */
import { addEntity, hasComponent } from 'bitecs'
import { describe, expect, it } from 'vitest'
import { createSimWorld } from '../../src/engine/sim/ecs/world'
import type { PhysicsWorld } from '../../src/engine/sim/physics/rapier'
import { ShieldEffect, ShieldEffectStore } from '../../src/game/components/combat'
import { BoostEffect, BoostEffectStore, type PickupType } from '../../src/game/components/pickup'
import { PICKUP_REGISTRY } from '../../src/game/systems/pickup-registry'

// Mine/missile `use` need a rigid body for the launch transform; boost/shield
// don't touch physics, so a stub that returns null bodies is enough here.
const nullPhys = {
  world: { getRigidBody: () => null },
  fixedDt: 1 / 60,
} as unknown as PhysicsWorld

describe('PICKUP_REGISTRY', () => {
  it('has an entry for every PickupType', () => {
    const types: PickupType[] = ['boost', 'missile', 'mine', 'shield']
    for (const t of types) expect(PICKUP_REGISTRY[t]).toBeDefined()
  })

  it('boost.use attaches a BoostEffect with a multiplier', () => {
    const sim = createSimWorld({ seed: 1 })
    const eid = addEntity(sim)
    PICKUP_REGISTRY.boost.use({ sim, phys: nullPhys, eid })
    expect(hasComponent(sim, eid, BoostEffect)).toBe(true)
    expect(BoostEffectStore.must(eid).multiplier).toBeGreaterThan(1)
  })

  it('shield.use attaches a ShieldEffect with remaining time', () => {
    const sim = createSimWorld({ seed: 1 })
    const eid = addEntity(sim)
    PICKUP_REGISTRY.shield.use({ sim, phys: nullPhys, eid })
    expect(hasComponent(sim, eid, ShieldEffect)).toBe(true)
    expect(ShieldEffectStore.must(eid).remaining).toBeGreaterThan(0)
  })

  it('declares which spatial precompute each AI heuristic needs', () => {
    expect(PICKUP_REGISTRY.mine.needsChaser).toBe(true)
    expect(PICKUP_REGISTRY.missile.needsMissileTarget).toBe(true)
    expect(PICKUP_REGISTRY.boost.needsChaser).toBe(false)
    expect(PICKUP_REGISTRY.boost.needsMissileTarget).toBe(false)
  })
})
