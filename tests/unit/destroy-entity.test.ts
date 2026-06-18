/**
 * `destroyEntity` must wipe an entity from every side-table store, not just
 * clear its bitECS tag membership. Without it, `removeEntity` leaks a Map
 * entry per despawned combat entity, and — because bitECS recycles ids — a
 * fresh entity could inherit the previous tenant's stale component data.
 */
import { addComponent, addEntity, hasComponent } from 'bitecs'
import { describe, expect, it } from 'vitest'
import { destroyEntity } from '../../src/engine/sim/ecs/destroy'
import { createSimWorld } from '../../src/engine/sim/ecs/world'
import { MineState, MineStateStore, MineTag } from '../../src/game/components/combat'

describe('destroyEntity', () => {
  it('clears both the tag membership and the side-table store entry', () => {
    const sim = createSimWorld({ seed: 1 })
    const eid = addEntity(sim)
    addComponent(sim, eid, MineTag)
    addComponent(sim, eid, MineState)
    MineStateStore.set(eid, {
      ownerEid: 0,
      position: { x: 0, y: 0, z: 0 },
      ageSec: 0,
      detonated: false,
      detonatedAt: 0,
    })

    expect(MineStateStore.has(eid)).toBe(true)
    expect(hasComponent(sim, eid, MineTag)).toBe(true)

    destroyEntity(sim, eid)

    expect(MineStateStore.has(eid)).toBe(false)
    expect(hasComponent(sim, eid, MineTag)).toBe(false)
  })

  it('does not let a recycled entity id inherit stale store data', () => {
    const sim = createSimWorld({ seed: 1 })
    const first = addEntity(sim)
    addComponent(sim, first, MineState)
    MineStateStore.set(first, {
      ownerEid: 42,
      position: { x: 1, y: 2, z: 3 },
      ageSec: 9,
      detonated: true,
      detonatedAt: 9,
    })
    destroyEntity(sim, first)

    // bitECS recycles ids; the next addEntity may reuse `first`. Whatever id
    // we get, it must not carry the old MineState payload.
    const second = addEntity(sim)
    expect(MineStateStore.get(second)).toBeUndefined()
  })
})
