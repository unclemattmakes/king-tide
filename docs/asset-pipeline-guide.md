# Asset pipeline — author guide

End-to-end walkthrough for editing a JSON spec and seeing the result
in the running game. For the architectural rationale and full design,
see [asset-pipeline-plan.md](./asset-pipeline-plan.md). For
track-specific authoring (gates, splines, pickups), see the older
[blender-pipeline-guide.md](./blender-pipeline-guide.md) — that flow
remains canonical for tracks.

## TL;DR

```bash
# One-time setup: install Blender 5.1+ and pnpm install.
pnpm install
pnpm gen:all          # validates every spec, builds every GLB, writes manifest

pnpm dev              # http://localhost:5191 — Vite watches specs/ and kits and
                      # auto-runs gen:bikes / gen:props / gen:tracks on change

# Iterate: edit specs/bikes/scout.json → save → wait ~3s → reload tab
```

## What lives where

| Path | Owner | Notes |
|---|---|---|
| `specs/_schema/*.json` | this guide | JSON Schemas. Validated by `tools/blender/run.mjs` (ajv) before Blender runs. |
| `specs/bikes/*.json`, `specs/props/*.json`, `specs/tracks/*.json` | authors | Source of truth for parametric assets. |
| `tools/blender/lib/*.blend` | authors | Kit `.blend` files — committed source art. The seed scripts (`seed_bike_kit.py`, `seed_prop_kit.py`) regenerate the placeholders. |
| `tools/blender/build_*.py` | pipeline | Headless builders. Each reads one spec via `HOVERBIKE_SPEC` env var. |
| `tools/blender/run.mjs` | pipeline | Cross-platform Node wrapper. Discovers specs, validates, spawns Blender per spec, writes the manifest. |
| `public/assets/<cat>/*.glb` | generated | Output GLBs. Committed today; Phase 5 will gitignore. |
| `public/assets/manifest.json` | generated | Index of every built asset. The runtime + editor read it. |

## The three categories

### Bikes (`specs/bikes/<id>.json`)

Parametric chassis built from kit parts in `bike_parts.blend`. Shape
knobs (`chassisLength`, `fairingStyle`, `thrusterCount`), physics
(`massKg`, `topSpeedMps`, `hoverHeight`), appearance (livery, glow,
metal colors), and rider seat offset. Each spec emits one bike GLB
with:

- `bike_root` empty, `extras.kind="bike"` + bike-id/mass/top-speed.
- Visual meshes (chassis, fairing, thrusters, fork) parented under it.
- Five sockets — `seat`, `nose_cam`, `fx_thruster_l`, `fx_thruster_r`,
  `fx_exhaust` — each an empty with `extras.kind="socket"` and `slot`.
- One `collider_body` empty with `extras.kind="collider", shape="box",
  half_extents=[hx, hy, hz]` already in three.js axes (right, up,
  forward).

The runtime path lives in
[`src/game/assets/bike-loader.ts`](../src/game/assets/bike-loader.ts).

### Props (`specs/props/<id>.json`)

Editor-placeable static decor. Spec picks a kit part by name, applies
scale + tint, and declares a primitive collider (box / sphere /
cylinder / capsule). The in-app track editor's *+Asset* dropdown is
populated from `manifest.json` — placing one writes
`{ type: 'asset', assetId, position, rotation, size }` into the
track JSON, and the runtime preloads the GLB at boot.

### Tracks (`specs/tracks/<id>.json`)

Declarative replacement for the legacy
`tools/build_calibration_scene.py`. Specifies surface size + thickness,
water volume, checkpoints (with `halfWidth`/`height` envelopes), AI
spline control points, starts (each `[x, y, z]` or `[x, y, z, yaw]`
with yaw in radians), and pickups. `pnpm gen:tracks` builds:

  - `tracks-src/<id>.blend` — for follow-up Blender authoring
  - `public/assets/tracks/<id>.glb` — environment geometry the runtime
    fetches via `environmentGlb`
  - `public/tracks/<id>.json` — gameplay JSON (gates, spline, pickups,
    start pose, water tuning) the runtime loads first. **Existing
    files are preserved** by default — once you've tuned a track in
    the in-app editor, the spec is no longer the source of truth for
    placement. Set `HOVERBIKE_FORCE_GAMEPLAY_JSON=1` to overwrite.

The track surface is built as a 1m-thick **slab** (configurable via
`surface.thickness`) rather than a 0-thickness plane — that gives the
trimesh enough volume that Rapier's discrete broadphase can catch a
fast-falling capsule on its first downward step. This pairs with
`setCcdEnabled(true)` on the bike to keep the bike on track even at
top speed off ramps. Both fixes were added in M9.27.

For tracks **with hand-authored geometry**, the gameplay-data JSON
under `public/tracks/<id>.json` (authored via the in-app editor)
remains the higher-level entry point — that file references an
`environmentGlb` produced from a hand-edited `.blend`. Specs are for
*calibration-style* declarative tracks; mixing the two is fine.

## Iteration loops

### Fastest: tweak a spec parameter

1. Edit a JSON file in `specs/`.
2. Save. Vite's watcher debounces 600ms then runs `pnpm gen:<cat>`
   for that category (visible in the dev-server terminal).
3. Reload the browser tab (binary GLBs aren't HMR-able; Vite serves
   the new file but the runtime won't swap a live mesh).

### Re-author kit geometry in Blender

1. Open `tools/blender/lib/bike_parts.blend` (or `prop_kit.blend`).
2. Edit. Save.
3. Saving a `.blend` triggers the same watcher → all bikes (or props)
   are rebuilt against the new kit.
4. Reload.

If you want to start from a clean placeholder, re-run
`tools/blender/seed_bike_kit.py` (or `seed_prop_kit.py`) — those
scripts regenerate the placeholders from scratch.

### Add a brand-new bike

1. Copy `specs/bikes/scout.json` to `specs/bikes/<new-id>.json`. Edit
   `id`, `displayName`, geometry, physics, appearance.
2. Save → watcher rebuilds.
3. The new bike appears in the manifest. Wire it into
   `src/game/bikes/variants.ts` if you want it selectable from the
   garage; otherwise reach it via `?bike=<new-id>`.

### Add a brand-new prop

1. If the shape needs a new kit object, edit
   `tools/blender/lib/prop_kit.blend` and add a named mesh — or
   extend `tools/blender/seed_prop_kit.py` and re-run.
2. Copy `specs/props/barrier_low.json` → `specs/props/<new-id>.json`.
   Edit `id`, `displayName`, `kitPart`, `tint`, and the collider.
3. Save. The prop becomes available in the editor's *+Asset* dropdown
   on next page reload (the editor reads the manifest at boot).

## Troubleshooting

**"`schema FAIL ...`" before Blender runs.** ajv validation against
`specs/_schema/<cat>.json`. The error path tells you which field is
wrong. Fix the JSON; the watcher retries on save.

**"`could not locate Blender`".** `tools/blender/run.mjs` checks
`$BLENDER_EXE`, then PATH, then OS-default install paths. Set
`BLENDER_EXE` if Blender is in a non-standard location.

**Bike loads but renders sideways or stretched.** The Blender→glTF
yup conversion swaps axes; the builders compensate by authoring with
the bike's nose at Blender `-Y` (so it lands at three `+Z` forward).
If you write a new builder, follow the same convention or ship an
explicit rotation on the root.

**Editor's *+Asset* dropdown is empty.** Run `pnpm gen:props` at
least once. The editor reads `public/assets/manifest.json`; if no
prop GLBs have been built, the dropdown shows the "no assets" hint.

**CI fails on a fresh PR.** The
[`.github/workflows/asset-pipeline.yml`](../.github/workflows/asset-pipeline.yml)
job runs `pnpm gen:all` on PRs that touch `specs/` or
`tools/blender/`. If it fails, the run log shows the exact validation
or Blender error.

## See also

- [`asset-pipeline-plan.md`](./asset-pipeline-plan.md) — original brief.
- [`blender-conventions.md`](./blender-conventions.md) — name + extras
  reference card.
- [`blender-pipeline-guide.md`](./blender-pipeline-guide.md) — full
  track-author walkthrough.
- [`tools/README.md`](../tools/README.md) — quick CLI reference.
