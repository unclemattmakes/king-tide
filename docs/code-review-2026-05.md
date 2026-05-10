# Code Review — May 2026

A pass over the repository looking for code reuse, documentation quality,
runtime efficiency, and maintainability concerns. Findings are grouped by
category and prioritized at the bottom.

## 1. Code Reuse / DRY

### 1.1 Inline squared-distance math is duplicated 8+ times

`src/game/systems/combat.ts`, `ai-control.ts`, `ai-combat.ts`, and
`pickup.ts` all repeat the same pattern:

```ts
const dx = t.x - m.position.x
const dy = t.y - m.position.y
const dz = t.z - m.position.z
if (dx * dx + dy * dy + dz * dz > R * R) continue
```

**Fix:** add `distanceSquared(a, b)` to `src/game/util/vec.ts` (or wherever
the existing vector helpers live) and migrate call sites. Bonus: the same
files also recompute `R * R` per frame even though `R` is a module
constant — pre-compute `R_SQ` once.

### 1.2 Velocity normalization re-implemented

`src/game/systems/combat.ts:248-260` and `src/engine/render/water.ts`
both manually normalize a 3-vector. Add `normalize3D()` next to
`distanceSquared`.

### 1.3 Mesh entity lifecycle duplicated 4× in combat-render

`src/engine/render/combat-render.ts:30-159` maintains four parallel Maps
(mines, missiles, shields, explosions) each with create / query / update
position / dispose boilerplate. A small `MeshEntityPool<T>` generic would
eliminate roughly 150 lines.

### 1.4 Spline-following math is private to AI

`src/game/systems/ai-control.ts` does closest-point search, lookahead, and
curvature sampling inline. The track editor and any future visualization
will need the same primitives. Extract to
`src/game/tracks/spline.ts` with testable helpers
(`findClosestPoint`, `sampleAlong`, `curvatureAt`).

## 2. Documentation

### Strengths

- README covers tech stack, controls, deployment, and architecture rule.
- `docs/` has product plan, implementation plan, status, and asset
  pipeline guides — most folders most projects don't have.
- Inline comments in the AI control heuristic are clear.

### Gaps

- **`src/main.ts` is 1,333 lines** with no top-of-file architecture
  comment. Replay mode, edit mode, JSON tracks, and procedural tracks all
  branch in the same boot sequence; a 10-line "phases of startup" header
  would save future readers significant tracing.
- **Component stores in `src/game/components/index.ts` are inconsistently
  documented.** `HoverStateStore` has field-by-field comments;
  `BikeStatsStore` and several neighbors rely on TypeScript types alone.
- **No ADRs.** Decisions like "why bitECS", "render/sim split rules",
  "canvas vs. WebGL2" live only in commit history. A
  `docs/adr/` folder with one short note per decision would be cheap.
- **Render system factory ordering is undocumented.**
  `createBikeRenderSystem`, `createCombatRenderSystem`, `createFxSystem`
  have implicit init order requirements that aren't called out anywhere.

## 3. Performance

### 3.1 O(n²) bike scans per tick (real)

- `src/game/systems/combat.ts:131-175` (mine system) re-queries all bikes
  inside the per-mine loop.
- `src/game/systems/ai-combat.ts:105-121` re-queries all bikes inside the
  per-AI loop.

With current entity counts the cost is small, but it grows quadratically
with bike count. **Fix:** query `bikeQuery(world)` once at the start of
the system and pass the array down.

### 3.2 AI spline lookups are not cached

`src/game/systems/ai-control.ts:55-80` finds the closest spline point by
scanning a sliding window every tick. The spline is static; cache the
last index per AI and only search a small neighborhood. Same for the
curvature lookahead at lines 130-159.

### 3.3 Radius-squared multiplied every frame

`pickup.ts:73`, `combat.ts:160,282` — these constants never change. Lift
them to module-level `*_SQ` constants.

### 3.4 Water debug menu rewrites uniforms unconditionally

`src/engine/water-debug-menu.ts:331` updates shader uniforms every frame
even when no slider has changed. Add a dirty flag.

### 3.5 `Math.hypot` where squared compare suffices

A handful of radius checks call `Math.hypot(dx, dy, dz)` then compare to
`R`. Compare squared distances to skip the `sqrt`.

## 4. Maintainability

### 4.1 Monolith files

- `src/main.ts` — 1,333 lines. Boot, game loop, replay, edit mode, garage,
  HUD, debug UI all live here. Split into a `GameLoop` module plus
  mode-specific entry points.
- `src/.../track-editor.ts` — 1,704 lines. Editor state, gizmos, undo/redo,
  serialization. Split into `editor-state.ts`, `editor-gizmos.ts`,
  `editor-ui.ts`.

### 4.2 Debug UI shipped to production

`dev-settings-menu.ts`, `water-debug-menu.ts`, and `collision-debug.ts`
add ~800 lines to the production bundle. Gate behind a build flag or
`import()` lazily under a query-string toggle.

### 4.3 Asset/JSON fetch errors are silent

Bike loader, manifest loader, and track JSON fetches log to console on
failure with no user-facing surface and no retry. A small centralized
error reporter + retry middleware would help.

### 4.4 Alternate entry point of unclear status

`src/viewer/bike-viewer.ts` (~302 lines) is reachable via `?viewer=` and
rarely touched. Either document its maintenance status in the README or
mark for deprecation.

## Priority Matrix

| Issue                                       | File(s)                          | Effort  | Impact                | Status                       |
|---------------------------------------------|----------------------------------|---------|-----------------------|------------------------------|
| `distanceSquared` / `normalize3D` utilities | `vec.ts` + 4 systems             | Low     | Medium (clarity)      | ✅ PR #39                    |
| Pre-compute `*_SQ` radius constants         | `combat.ts`, `pickup.ts`         | Trivial | Low (micro)           | ✅ PR #39                    |
| Cache bike query per frame                  | `combat.ts`, `ai-combat.ts`      | Low     | Medium (scales w/ N)  | ✅ PR #39                    |
| Cache spline lookups in AI                  | `ai-control.ts`                  | Medium  | Medium                | partial (lastClosestIndex)   |
| Mesh entity pool                            | `combat-render.ts`               | Medium  | Medium (maintain.)    | ✅ PR #39                    |
| Split `main.ts`                             | `main.ts`                        | High    | High (maintain.)      | open                         |
| Split `track-editor.ts`                     | `track-editor.ts`                | High    | High (maintain.)      | open                         |
| Extract spline utilities                    | new `tracks/spline-query.ts`     | Medium  | Medium (DRY)          | ✅ PR #39                    |
| Lazy-load debug UIs                         | `*-debug-menu.ts`                | Low     | Low (bundle)          | ✅ PR #40                    |
| ADRs + boot-sequence comment                | `docs/adr/`, `main.ts` header    | Low     | Medium (onboarding)   | ✅ PR #40                    |

## Batch 1 — PR #39 (merged)

1. `distanceSquared` / `normalize3D` extracted to `vec.ts`; migrated the
   inline copies in `combat.ts` / `pickup.ts`.
2. `*_SQ` radius constants in `combat.ts` and `pickup.ts`.
3. Bike entity query cached once per tick in `aiCombatSystem` and
   threaded into `pickMissileTarget` / `isChaserBehind`.
4. `spline-query.ts` extracted from `ai-control.ts` (closest-index,
   lookahead, curvature scan) with unit tests.
5. `syncEntityMeshes` extracted from `combat-render.ts` — four parallel
   lifecycle blocks collapsed onto one helper.

## Batch 2 — PR #40 (this PR)

1. **Lazy-load debug UIs.** `dev-settings-menu` and `water-debug-menu`
   are now dynamic-imported on first toggle-button click via
   `bindLazyMenuButton` in `src/engine/lazy-menu.ts`. The persisted
   water tuning still applies eagerly through the new lightweight
   `water-debug-storage.ts` module so the visible water doesn't
   regress to defaults until the user opens the menu. Vite splits
   each menu into its own chunk (~2 kB / ~4 kB minified).
2. **Boot-sequence header in `main.ts`.** A JSDoc on `boot()` lays out
   the eight phases (mode dispatch → subsystem setup → params →
   asset load → entity spawn → render systems → game loop → edit
   mode) with pointers to where each lives.
3. **ADR scaffolding** in `docs/adr/`. Four short ADRs capture the
   load-bearing decisions: bitECS, sim/render separation, Three.js
   with WebGPU-first, and Rapier deterministic physics. Index in
   `docs/adr/README.md`.

## Remaining

Spinning out as a separate task: split the two big files (`main.ts`,
`track-editor.ts`) into focused modules. These are the only "High"
items left and each warrants its own PR with extra testing.
