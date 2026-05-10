# ADR 0001 — ECS: bitECS 0.4 with side-table stores

**Status:** Accepted

## Context

The simulation needs to model a small, dynamic population of entities
(player + ~4 AI bikes, plus mines / missiles / explosions / pickups
that come and go each lap) with frequent component add/remove and
fast iteration in tight per-tick loops (`mineSystem`, `missileSystem`,
`aiControlSystem`, `hoverSystem`, etc.).

The realistic JS options were:

- A class-based "GameObject" hierarchy → easy to write, but mixing
  data and behaviour makes deterministic replay and headless testing
  awkward.
- One of the heavier ECS libs (e.g. miniplex, ecsy) → richer APIs
  but more allocation per query, and most rely on object-shape
  components that work against tight numeric loops.
- bitECS — archetype-based, `Uint32Array`-backed query results,
  deliberately small surface area.

## Decision

Use bitECS 0.4. Components are declared as named tags
(`{ name: 'BikeTag' }`) and the actual per-entity data lives in
side-table stores keyed by entity id (see
`src/game/components/index.ts`). This keeps the bitECS query path
fast while letting the data shape stay rich and typed via
`createStore<T>()`.

## Consequences

- **Headless tests work cleanly.** Sim systems take a `SimWorld` and
  `PhysicsWorld` and have no rendering dependency, which is
  load-bearing for `tests/unit/` (see `ai-combat.test.ts`).
- **Replay determinism is tractable.** All sim state lives in stores;
  the replay format only needs to capture rigid-body poses + a small
  amount of race state, not arbitrary object graphs.
- **Component lookup uses a fixed pattern.** `Store.get(eid)`,
  `.set(eid, …)`, `.must(eid)`, `.has(eid)`. Adding a new component
  means a tag constant + a store + (usually) a default-construct
  helper. Consistency is enforced socially, not by the library.
- **Query results are `Readonly<Uint32Array> | readonly EntityId[]`.**
  When passing query output around as a cached array (see
  `aiCombatSystem` after PR #39), the parameter type is `QueryResult`
  from bitecs.
- **Locked into bitECS 0.4 idioms.** A future major version may
  change the API; budget time for a migration if we upgrade.
