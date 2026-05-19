# Asset pipeline overview

Three categories of asset live in this codebase: **bikes**, **props**, and **tracks**. The shape differs per category:

```
# Bikes — the .blend is the source of truth
bikes-src/<id>.blend  +  specs/<id>.json  →  tools/blender/build_bike.py  →  public/assets/bikes/<id>.glb
   (geometry / sockets         (slim metadata           (open the .blend, overlay
    / collider)                  + recolour overrides)    spec extras + colours, export)

# Props + tracks — spec-driven, kit-assembled
specs/<category>/<id>.json  →  tools/blender/build_<category>.py  →  public/assets/<category>/<id>.glb
                                       (headless Blender)                   + public/assets/manifest.json
```

For **bikes**, you author each variant directly in `bikes-src/<id>.blend` and click *Hoverbike → Export Bike to Game* in the in-Blender addon (or run `pnpm gen:bikes` headless). The slim spec carries display name, physics, and optional colour overrides. For **props** and **tracks**, you edit a JSON spec and the headless builder assembles a GLB from kit parts. The runtime auto-loads everything from `public/assets/manifest.json` at boot.

::: tip Authoring a track from a blank Blender scene?
The [Blender](/blender/overview) section has a full pipeline reference — addon panels, every operator, the headless builders, scene conventions — plus a guided [blank-scene-to-playable-map tutorial](/blender/your-first-track).
:::

For the v1 production sequencing, see [`docs/v1-asset-pipeline-plan.md`](https://github.com/occ-matt/hoverbike/blob/main/docs/v1-asset-pipeline-plan.md). For the full Blender walkthrough and object-kind reference, see [`docs/blender-pipeline-guide.md`](https://github.com/occ-matt/hoverbike/blob/main/docs/blender-pipeline-guide.md).

## TL;DR

```bash
pnpm install
pnpm gen:all          # validates every spec, builds every GLB, writes manifest
pnpm dev              # http://localhost:5191
                      # Vite watches specs/, tools/blender/lib/*.blend, and
                      # bikes-src/*.blend, and auto-runs gen:bikes / gen:props /
                      # gen:tracks on change.

# Iterate on a bike (geometry): open bikes-src/<id>.blend → edit → Ctrl+S →
#                                wait ~3 s for headless rebuild → reload tab.
#                                (Or click *Export Bike to Game* in the addon to
#                                bypass the headless rebuild and write the GLB
#                                directly.)
# Iterate on appearance: edit specs/bikes/<id>.json → save → wait ~3 s → reload
# Iterate on a prop/track: edit specs/<cat>/<id>.json → save → wait ~3 s → reload
```

## What lives where

| Path | Owner | Notes |
|---|---|---|
| `specs/_schema/*.json` | this site | JSON Schemas. ajv-validated by `tools/blender/run.mjs` before Blender runs. |
| `bikes-src/<id>.blend` | authors | One per bike variant — source of truth for bike geometry, sockets, collider. Edit directly in Blender, click *Export Bike to Game* in the addon. |
| `tracks-src/<id>.blend` | authors | One per track — same flow with *Export Track to Game*. |
| `specs/bikes/*.json` | authors | Slim metadata + recolour overrides for each variant. `geometry` and `rider` blocks accepted but ignored (legacy). |
| `specs/props/*.json`, `specs/tracks/*.json` | authors | Parametric specs for kit-assembled props and declarative tracks. |
| `tools/blender/lib/prop_kit.blend` | authors | Prop kit `.blend` — committed source art. `seed_prop_kit.py` regenerates placeholders. The legacy `bike_parts.blend` + `seed_bike_kit.py` are kept for reference but no longer wired up. |
| `tools/blender/hoverbike_addon.py` | pipeline | In-Blender addon — installs a Hoverbike sidebar with *Export Bike to Game* / *Export Track to Game* buttons that auto-pick mode by the .blend's parent dir. |
| `tools/blender/build_*.py` | pipeline | Headless builders. `build_bike.py` opens `bikes-src/<id>.blend`; `build_prop.py` and `build_track.py` are spec-driven. Each reads one spec via `HOVERBIKE_SPEC` env var. |
| `tools/blender/run.mjs` | pipeline | Cross-platform Node wrapper. Discovers specs, validates, spawns Blender per spec, writes the manifest. |
| `public/assets/<cat>/*.glb` | generated | Output GLBs. Currently committed; future work will gitignore them. |
| `public/assets/manifest.json` | generated | Index of every built asset. The runtime + editor read it. |

## The three categories

### Bikes — `bikes-src/<id>.blend` + `specs/bikes/<id>.json`

Each variant is a standalone `.blend` (no shared kit, no propagation between variants). Open it in Blender, edit the geometry / sockets / collider directly, click **Hoverbike → Export Bike to Game**. The slim spec carries `displayName`, optional `physics` overrides written into `bike_root` extras at build, and optional `appearance` recolour hex strings applied to `mat_bike_<id>_*` materials. → [Authoring bikes](/modding/bikes)

### Props — `specs/props/<id>.json`

Editor-placeable static decor. Spec picks a kit part by name, applies scale + tint, and declares a primitive collider (box / sphere / cylinder / capsule). Available in the in-app track editor's *+Asset* dropdown. → [Authoring props](/modding/props)

### Tracks — `specs/tracks/<id>.json`

Declarative replacement for the legacy `tools/build_calibration_scene.py`. Specifies surface size + thickness, water volume, checkpoints (with `halfWidth` / `height` envelopes), AI spline control points, starts, and pickups. → [Authoring tracks](/modding/tracks)

## Iteration loops

### Fastest for bikes — edit the .blend, save (or click Export)

There are two paths from "edit a bike" to "see the change in-game":

1. **Ctrl+S in Blender → Vite watcher rebuilds.** The dev server watches `bikes-src/*.blend`; saving any of them debounces 600 ms and runs `pnpm gen:bikes`. ~3 s later the new GLB is on disk; reload the tab. Best when you're iterating tightly and just want save-to-test parity with the spec/track flows.
2. **N → Hoverbike → Export Bike to Game.** The addon writes the GLB directly without going through the headless rebuild — faster (skips the Blender boot), and on first export materialises a starter `specs/bikes/<id>.json`. **Shift-click** to rewrite the spec from the .blend. Best when you're done editing and want an explicit "ship it" gesture.

Either way, reload your browser tab. (Headless `pnpm gen:bikes` runs the same code path as path 1, without a GUI, for CI / batch builds.)

### Fastest for props + tracks — tweak a spec parameter

1. Edit a JSON file in `specs/`.
2. Save. Vite's watcher debounces 600 ms then runs `pnpm gen:<cat>` for that category (visible in the dev-server terminal).
3. Reload the browser tab. Binary GLBs aren't HMR-able; Vite serves the new file but the runtime won't swap a live mesh.

### Tweak a bike's appearance via JSON (no Blender round-trip)

The slim `specs/bikes/<id>.json` carries optional `appearance` and `physics` overlays that the headless build applies on top of what's in the .blend. Editing those JSON values and re-running `pnpm gen:bikes` (or letting the watcher fire) recolours `mat_bike_<id>_*` materials and rewrites `bike_root` extras without opening Blender. Use this for palette tuning between playtests.

### Re-author the prop kit

Props still use a shared kit at `tools/blender/lib/prop_kit.blend`.

1. Open `prop_kit.blend`.
2. Edit. Save.
3. Saving the `.blend` triggers the watcher → all props are rebuilt against the new kit.
4. Reload.

If you want to start from a clean placeholder, re-run `tools/blender/seed_prop_kit.py`.

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
