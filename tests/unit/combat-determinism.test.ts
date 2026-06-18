/**
 * Deterministic contested-resolution tie-breaks (docs/systems-review.md §1.4).
 * When two bikes are equidistant from a missile-target query, the lowest eid
 * must win regardless of (peer-divergent) ECS query order.
 */
import { addComponent, addEntity } from 'bitecs'
import { describe, expect, it } from 'vitest'
import { createSimWorld, type SimWorld } from '../../src/engine/sim/ecs/world'
import type { PhysicsWorld } from '../../src/engine/sim/physics/rapier'
import { BikeTag, RBHandle, RBHandleStore } from '../../src/game/components'
import { pickMissileTarget } from '../../src/game/systems/combat'

type P = { x: number; y: number; z: number }

function mockPhys(pos: Map<number, P>): PhysicsWorld {
  return {
    world: {
      getRigidBody: (h: number) => {
        const t = pos.get(h)
        if (!t) return null
        return { translation: () => t, rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }) }
      },
    },
    fixedDt: 1 / 60,
  } as unknown as PhysicsWorld
}

function spawnBike(sim: SimWorld, handle: number): number {
  const eid = addEntity(sim)
  addComponent(sim, eid, BikeTag)
  addComponent(sim, eid, RBHandle)
  RBHandleStore.set(eid, { handle })
  return eid
}

describe('pickMissileTarget determinism', () => {
  it('breaks an exact-distance tie by lowest eid', () => {
    const sim = createSimWorld({ seed: 1 })
    const pos = new Map<number, P>()
    // Firer at origin facing +z (identity rotation).
    const firer = spawnBike(sim, 1)
    pos.set(1, { x: 0, y: 0, z: 0 })
    // Two candidates, mirror-image positions → identical distance (5) and both
    // inside the forward cone (dot = 4/5 = 0.8).
    const a = spawnBike(sim, 2)
    pos.set(2, { x: 3, y: 0, z: 4 })
    const b = spawnBike(sim, 3)
    pos.set(3, { x: -3, y: 0, z: 4 })

    const target = pickMissileTarget(sim, mockPhys(pos), firer)
    expect(target).toBe(Math.min(a, b))
  })
})
