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

/** Options for `createStore`. */
export type StoreOptions = {
  /**
   * Render-only store: its data is derived from the sim each frame (interpolated
   * transforms, debug overlays) and carries NO sim state into future ticks.
   * Excluded from `serializeSimStores` so it never enters the determinism hash
   * (otherwise render interpolation would manufacture false desync mismatches).
   */
  renderOnly?: boolean
}

type RegisteredStore = {
  name: string
  renderOnly: boolean
  delete(eid: number): boolean
  /** Snapshot of [eid, data] pairs (live Map contents). */
  entries(): [number, unknown][]
}

/**
 * Every store registers here on creation so `destroyEntity` (see
 * `ecs/destroy.ts`) can wipe an entity from ALL stores in one call, and so the
 * determinism snapshot (`serializeSimStores`) can hash all sim-carrying state
 * without snapshot.ts having to import every component module.
 *
 * `removeEntity` from bitECS only clears tag membership — without this registry
 * the Map-backed stores leak an entry for every despawned mine / missile /
 * explosion, and a recycled entity id would inherit the previous tenant's
 * stale data. Internal: consumers go through `destroyEntity`.
 */
const _allStores: RegisteredStore[] = []

/** Delete `eid` from every registered store. Called by `destroyEntity`. */
export function deleteFromAllStores(eid: number): void {
  for (const s of _allStores) s.delete(eid)
}

/**
 * Stable, sorted serialization of every SIM-carrying store (render-only stores
 * excluded) for the determinism hash. Sorted by store name, then eid, so peer
 * ordering / Map insertion order can never sneak into the hash. Closes the
 * §1.3 gap where gameplay state (drift charge, lap counts, cooldowns, pickup
 * timers…) diverging between peers went undetected by the body-only snapshot.
 */
export function serializeSimStores(): [string, [number, unknown][]][] {
  const out: [string, [number, unknown][]][] = []
  for (const s of _allStores) {
    if (s.renderOnly) continue
    const entries = s.entries()
    entries.sort((a, b) => a[0] - b[0])
    out.push([s.name, entries])
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return out
}

export function createStore<T>(name: string, opts?: StoreOptions): Store<T> {
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
  _allStores.push({
    name,
    renderOnly: opts?.renderOnly ?? false,
    delete: (eid) => m.delete(eid),
    entries: () => [...m.entries()] as [number, unknown][],
  })
  return store
}
