/**
 * Per-component data store keyed by entity id.
 *
 * bitECS 0.4 components are pure tags — data attachment goes through observable
 * hooks. For hot-path data we just use Maps. Faster, simpler, and bitECS still
 * tracks entity membership / queries via addComponent on the matching tag.
 */
export type Store<T> = {
  set(eid: number, data: T): void
  get(eid: number): T | undefined
  /** Throw if eid has no entry. Use only when you know it exists (after a query). */
  must(eid: number): T
  delete(eid: number): boolean
  has(eid: number): boolean
  forEach(fn: (data: T, eid: number) => void): void
  size: number
}

/**
 * Every store registers here on creation so `destroyEntity` (see
 * `ecs/destroy.ts`) can wipe an entity from ALL stores in one call.
 * `removeEntity` from bitECS only clears tag membership — without this
 * registry the Map-backed stores leak an entry for every despawned mine /
 * missile / explosion, and a recycled entity id would inherit the previous
 * tenant's stale data. Internal: consumers go through `destroyEntity`.
 */
const _allStores: { delete(eid: number): boolean }[] = []

/** Delete `eid` from every registered store. Called by `destroyEntity`. */
export function deleteFromAllStores(eid: number): void {
  for (const s of _allStores) s.delete(eid)
}

export function createStore<T>(name: string): Store<T> {
  const m = new Map<number, T>()
  const store: Store<T> = {
    set: (eid, data) => {
      m.set(eid, data)
    },
    get: (eid) => m.get(eid),
    must: (eid) => {
      const v = m.get(eid)
      if (v === undefined) throw new Error(`${name}: no data for entity ${eid}`)
      return v
    },
    delete: (eid) => m.delete(eid),
    has: (eid) => m.has(eid),
    forEach: (fn) => {
      for (const [eid, data] of m) fn(data, eid)
    },
    get size() {
      return m.size
    },
  }
  _allStores.push(store)
  return store
}
