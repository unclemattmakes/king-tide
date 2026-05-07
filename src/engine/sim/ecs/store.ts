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

export function createStore<T>(name: string): Store<T> {
  const m = new Map<number, T>()
  return {
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
}
