import { removeEntity } from 'bitecs'
import { deleteFromAllStores } from './store'
import type { SimWorld } from './world'

/**
 * Destroy an entity completely: wipe its data from every side-table store
 * AND clear its bitECS tag membership.
 *
 * Use this instead of bitECS `removeEntity` directly. `removeEntity` alone
 * leaves the Map-backed stores (see `createStore`) holding orphaned entries,
 * which both leaks memory across a race (combat entities spawn/despawn
 * constantly) and — because bitECS recycles entity ids — lets a fresh entity
 * inherit the previous tenant's stale component data.
 */
export function destroyEntity(sim: SimWorld, eid: number): void {
  deleteFromAllStores(eid)
  removeEntity(sim, eid)
}
