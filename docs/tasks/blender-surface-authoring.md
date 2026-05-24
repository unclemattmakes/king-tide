# Task: Blender authoring UI for surface-type material tags

**Status:** open · **Depends on:** PR #195 (drift mechanic + runtime
surface-grip system) · **Scope:** Blender addon + one sync test ·
**Est:** small

## Background

PR #195 ("Mario-Kart-style drift mechanic") added a runtime
surface-grip system. Track surfaces can be tagged
`default / asphalt / sand / ice / metal / water`, and each scales the
bike's lateral grip so a drift feels different on ice vs. metal vs.
sand. See the **Surface-aware drift** section of
[drift-deep-dive.md](../drift-deep-dive.md) for the whole design.

The runtime is fully wired. This task is the **Blender authoring side**
so artists can tag surfaces in `.blend` files instead of hand-editing
track JSON.

## Dependency + branch

Build on PR #195. Branch from `claude/pensive-cray-K7PTt` (or from
`main` once #195 has merged) so `src/engine/sim/surface-types.ts`
exists. Develop on your own designated feature branch — do **not**
push to `claude/pensive-cray-K7PTt`.

## What already works — do NOT rebuild

- **`src/engine/sim/surface-types.ts`** — the TS `SurfaceType` registry
  (`default/asphalt/sand/ice/metal/water`), `SURFACE_PROFILES` (grip
  multipliers), `asSurfaceType`, `createSurfaceRegistry`. This is the
  source of truth the Python side mirrors; don't modify it.
- **`src/engine/render/glb-track.ts`** `attachTrackColliders()` already
  reads `obj.userData.surface` (validated via `asSurfaceType`, unknowns
  ignored) and tags the collider in the surface registry.
- **`tools/blender/hoverbike_addon/export.py`** already exports with
  `export_extras=True` (two call sites). So **any
  `obj["surface"] = "ice"` custom property automatically flows into the
  glTF extras → `userData.surface` at runtime.** No export-pipeline
  changes should be needed — verify this, don't rebuild it.

## What to build

### 1. Python `SurfaceType` mirror
Add a `SurfaceType` class to `tools/blender/hoverbike_kinds.py`
alongside `ExportedKind`, with the same six values as the TS side.
Follow the existing `ExportedKind` docstring/style. This becomes the
single source of truth for the Python side. Use these constants (not
string literals) at all new call sites.

### 2. Sync test (definition-of-done gate)
Add `tests/unit/surface-kinds-sync.test.ts` (or extend
`tests/unit/asset-kinds.test.ts`) that parses `class SurfaceType:` out
of `hoverbike_kinds.py` and asserts it matches
`Object.values(SurfaceType)` from `src/engine/sim/surface-types.ts`.
**Copy the parsing approach in `tests/unit/asset-kinds.test.ts`** —
its `parsePythonExportedKind()` slices the class body up to the next
`class`/EOF and regex-matches `NAME = "value"`. Symmetric-diff the two
sets for a precise drift error. Run with `pnpm test`.

### 3. Addon UI
Add a panel control + operator(s) that set `obj["surface"]` on the
selected mesh object(s). Follow the module pattern in
`tools/blender/hoverbike_addon/boost_pad.py` / `decal.py`:
- a `HOVERBIKE_OT_*` operator, `bl_idname = "hoverbike.set_surface"`,
  registered via the module's `register()`,
- surfaced in `panel.py` (selection-driven sub-panel is fine — it's a
  per-mesh property),
- a dropdown (`EnumProperty`) of the six surface types whose values
  come from the `SurfaceType` constants,
- a "clear surface tag" action that **deletes** the key (so the
  runtime falls back to DEFAULT) rather than setting `"default"`.

Optionally surface it in the top-bar Hoverbike menu (`menu.py`) +
Quick Pie if it fits the existing categorisation, but the N-panel
control is the must-have.

### 4. Install + verify
- `pnpm install:blender-addon` to symlink the package so Blender picks
  up the change on next *Reload Scripts*.
- If a **Blender MCP connection** is configured (see the "Blender
  connector — optional" section of [CLAUDE.md](../../CLAUDE.md)): tag a
  test mesh, export, and confirm `userData.surface` lands on the
  collider. `BLENDER_EXE` should point at Blender 5.1 for headless
  `_for_cli` / `pnpm gen:*` scripts.
- If Blender is **not** reachable: rely on the sync test + a code read
  of the `export.py` extras path to confirm the round-trip.

## Conventions (from [CLAUDE.md](../../CLAUDE.md))

- Mirror the `kind`-registry rule: a value added to one side without
  the other must fail the sync test loud.
- Definition-of-done: a system isn't done until it works *and* has its
  authoring entry point. Here that's the addon panel control + the
  passing sync test.
- Don't modify the runtime `surface-types.ts` — it's the source of
  truth the Python side mirrors.

## Acceptance checklist

- [ ] `SurfaceType` exists in `hoverbike_kinds.py` with all six values.
- [ ] Sync test passes and fails loud on drift between the two sides.
- [ ] Addon panel can tag **and** clear a mesh's surface;
      `pnpm install:blender-addon` picks it up.
- [ ] `pnpm test` + `pnpm typecheck` green.
- [ ] (If Blender reachable) round-trip confirmed: tagged mesh → GLB →
      `userData.surface` → collider tagged in the surface registry.
- [ ] Consider tagging a real ship track's surfaces (sand beach, metal
      pier, etc.) as a follow-up once the tool exists — not required
      for this task.

## Reference files

| File | Why |
|---|---|
| `src/engine/sim/surface-types.ts` | TS source of truth (do not edit) |
| `src/engine/render/glb-track.ts` | runtime read of `userData.surface` |
| `tools/blender/hoverbike_addon/export.py` | `export_extras=True` (already done) |
| `tools/blender/hoverbike_kinds.py` | add `SurfaceType` here |
| `tests/unit/asset-kinds.test.ts` | copy the sync-test parsing approach |
| `tools/blender/hoverbike_addon/boost_pad.py` | operator + custom-prop template |
| `tools/blender/hoverbike_addon/panel.py` | where panel sections register |
| `docs/drift-deep-dive.md` | full surface-system design |
