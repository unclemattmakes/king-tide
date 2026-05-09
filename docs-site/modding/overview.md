# Asset pipeline overview

Three categories of asset live in this codebase: **bikes**, **props**, and **tracks**. Each one has the same shape:

```
specs/<category>/<id>.json   →   tools/blender/build_<category>.py   →   public/assets/<category>/<id>.glb
                                          (headless Blender)                    + public/assets/manifest.json
```

You edit a JSON spec. The pipeline validates it, runs Blender headlessly to assemble a GLB from kit parts (`tools/blender/lib/*.blend`), and writes the output. The runtime auto-loads everything from `public/assets/manifest.json` at boot.

For the architectural rationale and full design, see [`docs/asset-pipeline-plan.md`](https://github.com/occ-matt/hoverbike/blob/main/docs/asset-pipeline-plan.md). For a quick-reference on Blender naming + extras, see [`docs/blender-conventions.md`](https://github.com/occ-matt/hoverbike/blob/main/docs/blender-conventions.md).

## TL;DR

```bash
pnpm install
pnpm gen:all          # validates every spec, builds every GLB, writes manifest
pnpm dev              # http://localhost:5191
                      # Vite watches specs/ and tools/blender/lib/*.blend and
                      # auto-runs gen:bikes / gen:props / gen:tracks on change

# Iterate: edit specs/bikes/scout.json → save → wait ~3 s → reload tab
```

## What lives where

| Path | Owner | Notes |
|---|---|---|
| `specs/_schema/*.json` | this site | JSON Schemas. ajv-validated by `tools/blender/run.mjs` before Blender runs. |
| `specs/bikes/*.json`, `specs/props/*.json`, `specs/tracks/*.json` | authors | Source of truth for parametric assets. |
| `tools/blender/lib/*.blend` | authors | Kit `.blend` files — committed source art. The `seed_*_kit.py` scripts regenerate the placeholders if you want to start clean. |
| `tools/blender/build_*.py` | pipeline | Headless builders. Each reads one spec via `HOVERBIKE_SPEC` env var. |
| `tools/blender/run.mjs` | pipeline | Cross-platform Node wrapper. Discovers specs, validates, spawns Blender per spec, writes the manifest. |
| `public/assets/<cat>/*.glb` | generated | Output GLBs. Currently committed; future work will gitignore them. |
| `public/assets/manifest.json` | generated | Index of every built asset. The runtime + editor read it. |

## The three categories

### Bikes — `specs/bikes/<id>.json`

Parametric chassis built from kit parts in `bike_parts.blend`. Shape knobs (`chassisLength`, `fairingStyle`, `thrusterCount`), physics (`massKg`, `topSpeedMps`, `hoverHeight`), appearance (livery, glow, metal colors), and rider seat offset. → [Authoring bikes](/modding/bikes)

### Props — `specs/props/<id>.json`

Editor-placeable static decor. Spec picks a kit part by name, applies scale + tint, and declares a primitive collider (box / sphere / cylinder / capsule). Available in the in-app track editor's *+Asset* dropdown. → [Authoring props](/modding/props)

### Tracks — `specs/tracks/<id>.json`

Declarative replacement for the legacy `tools/build_calibration_scene.py`. Specifies surface size + thickness, water volume, checkpoints (with `halfWidth` / `height` envelopes), AI spline control points, starts, and pickups. → [Authoring tracks](/modding/tracks)

## Iteration loops

### Fastest — tweak a spec parameter

1. Edit a JSON file in `specs/`.
2. Save. Vite's watcher debounces 600 ms then runs `pnpm gen:<cat>` for that category (visible in the dev-server terminal).
3. Reload the browser tab. Binary GLBs aren't HMR-able; Vite serves the new file but the runtime won't swap a live mesh.

### Re-author kit geometry in Blender

1. Open `tools/blender/lib/bike_parts.blend` (or `prop_kit.blend`).
2. Edit. Save.
3. Saving a `.blend` triggers the same watcher → all bikes (or props) are rebuilt against the new kit.
4. Reload.

The bike kit opens with parts laid out at their assembled-bike positions (chassis at centre, fairing on top, fork at nose, etc.) so you see a real bike on open. Mesh edits ride through to the build; viewport object positions are layout-only.

To **move where a part attaches** (e.g. fairing sits 5 cm further forward), translate the matching `mount_*` empty parented to `chassis_base` in the kit — no code change. The build's `snap_to_mount` reads the mount's world position and snaps the part to it. See [Authoring bikes → Moving an attachment point](/modding/bikes#moving-an-attachment-point-no-code-change).

If you want to start from a clean placeholder, re-run `tools/blender/seed_bike_kit.py` (or `seed_prop_kit.py`) — those scripts regenerate the placeholders from scratch.

### Add a brand-new bike / prop

See [Authoring bikes](/modding/bikes) and [Authoring props](/modding/props).

### Add a brand-new track

You can author tracks two ways. Pick whichever fits:

- **Spec-driven** (calibration-style declarative tracks): copy `specs/tracks/test-ring.json` to `specs/tracks/<new-id>.json`, edit, save.
- **Editor-driven** (everything else): see [`docs/track-editor-guide.md`](https://github.com/occ-matt/hoverbike/blob/main/docs/track-editor-guide.md).

For environment geometry (cliffs, mesas, hand-modeled props), see [`docs/blender-pipeline-guide.md`](https://github.com/occ-matt/hoverbike/blob/main/docs/blender-pipeline-guide.md).

## Troubleshooting

**"`schema FAIL ...`" before Blender runs.** ajv validation against `specs/_schema/<cat>.json`. The error path tells you which field is wrong. Fix the JSON; the watcher retries on save.

**"`could not locate Blender`".** `tools/blender/run.mjs` checks `$BLENDER_EXE`, then `PATH`, then OS-default install paths. Set `BLENDER_EXE` if Blender is in a non-standard location.

**Bike loads but renders sideways or stretched.** The Blender → glTF Y-up conversion swaps axes. The builders compensate by authoring with the bike's nose at Blender `-Y` (so it lands at three.js `+Z` forward). If you write a new builder, follow the same convention or ship an explicit rotation on the root.

**Editor's *+Asset* dropdown is empty.** Run `pnpm gen:props` at least once. The editor reads `public/assets/manifest.json`; if no prop GLBs have been built, the dropdown shows the "no assets" hint.

**CI fails on a fresh PR.** [`.github/workflows/asset-pipeline.yml`](https://github.com/occ-matt/hoverbike/blob/main/.github/workflows/asset-pipeline.yml) runs `pnpm gen:all` on PRs that touch `specs/` or `tools/blender/`. The run log shows the exact validation or Blender error.
