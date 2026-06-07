# Asset pipeline — author guide

End-to-end walkthrough for editing a JSON spec and seeing the result
in the running game. For track-specific authoring (gates, splines,
pickups), see [blender-pipeline-guide.md](./blender-pipeline-guide.md)
— that flow remains canonical for tracks. For the v1 production plan
and per-track set-piece sequencing, see
[v1-asset-pipeline-plan.md](./v1-asset-pipeline-plan.md).

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
| `specs/bikes/*.json`, `specs/props/*.json`, `specs/tracks/*.json` | authors | Bike specs are slim (display name + physics + appearance overrides); the geometry source of truth is `bikes-src/<id>.blend`. Prop + track specs remain parametric. |
| `bikes-src/<id>.blend` | authors | One per bike variant — open, edit, click *Export Bike to Game* in the addon. The runtime GLB is built from this directly. |
| `tracks-src/<id>.blend` | authors | One per track — same flow with *Export Track to Game*. |
| `tools/blender/lib/*.blend` | authors | Prop kit `.blend` (`prop_kit.blend`); the legacy `bike_parts.blend` is no longer consumed by the bike builder but kept around for reference. |
| `tools/blender/build_*.py` | pipeline | Headless builders. `build_bike.py` opens `bikes-src/<id>.blend` + applies spec overrides; `build_prop.py` + `build_track.py` are spec-driven. |
| `tools/blender/run.mjs` | pipeline | Cross-platform Node wrapper. Discovers specs, validates, spawns Blender per spec, writes the manifest. |
| `public/assets/<cat>/*.glb` | generated | Output GLBs. Committed today; Phase 5 will gitignore. |
| `public/assets/manifest.json` | generated | Index of every built asset. The runtime + editor read it. |

## The three categories

### Bikes (`bikes-src/<id>.blend` + `specs/bikes/<id>.json`)

**The `.blend` is the source of truth for geometry.** Author each
variant directly in `bikes-src/<id>.blend` — chassis, fairing, fork,
thrusters, fin, tail, sockets, and collider all live there. No shared
kit; no parametric assembly; no propagation across variants. Edit a
bike, click *Export Bike to Game* in the Blender addon, the GLB
updates and the runtime picks it up on next reload. (Headless
`pnpm gen:bikes` opens each `.blend` and rebuilds non-interactively
for CI.)

The slim `specs/bikes/<id>.json` carries:

- `displayName` — for the garage menu + manifest.
- `physics.{massKg, topSpeedMps, hoverHeight}` — written into
  `bike_root` extras at build time so the runtime + viewer HUD see
  spec-driven values without reopening Blender. Optional.
- `appearance.{liveryColor, metalColor, glowColor, glowIntensity}` —
  recolour overrides applied to matching `mat_bike_<id>_*` materials
  at build time so palette tweaks don't need a Blender round-trip.
  Used by the garage menu's swatches. Optional.

Drop either block from the spec to use whatever's authored in the
`.blend`. (Older `geometry` and `rider` blocks are accepted by the
schema for backward compatibility but ignored by the builder.)

Each built bike GLB ships with:

- `bike_root` empty, `extras.kind="bike"` + bike-id/mass/top-speed/
  hover-height/display-name.
- Visual meshes (`bike_body`, `bike_fairing`, `bike_thruster_*`,
  `bike_fork`, `bike_fin`, `bike_tail`) parented under it.
- Five sockets — `seat`, `nose_cam`, `fx_thruster_l`, `fx_thruster_r`,
  `fx_exhaust` — each an empty with `extras.kind="socket"` and `slot`.
- One `collider_body` empty with `extras.kind="collider", shape="box",
  half_extents=[hx, hy, hz]` already in three.js axes (right, up,
  forward).

The runtime path lives in
[`src/game/assets/bike-loader.ts`](../src/game/assets/bike-loader.ts).

#### In-game viewer (`?viewer=<bikeId>`)

For visual verification of a built bike GLB, navigate to
`/?viewer=<id>` (e.g. `/?viewer=scout`) — also reachable via the
addon's **Copy Viewer URL** button. Skips the entire game boot and
renders one bike on a turntable with `OrbitControls`. The HUD shows
mass, top speed, hover height, world bbox, livery/metal/glow
swatches, every socket, and a quick-switch row across the manifest's
bikes. Sockets render as small green dots; the box collider as an
orange wireframe. See
[`src/viewer/bike-viewer.ts`](../src/viewer/bike-viewer.ts).

### Props (`specs/props/<id>.json`)

Editor-placeable decor. Spec picks a kit part by name, applies
scale + tint, and declares a primitive collider (box / sphere /
cylinder / capsule). The in-app track editor's *+Asset* dropdown is
populated from `manifest.json` — placing one writes
`{ type: 'asset', assetId, position, rotation, size }` into the
track JSON, and the runtime preloads the GLB at boot.

**Wave-rider opt-in.** Adding a `waveRider: { archetype: 'buoy' | 'log' }`
block to a prop spec stamps `wave_rider_archetype` on the GLB's
`prop_root` (see [`build_prop.py`](../tools/blender/build_prop.py:95)).
At load time the runtime's [`prop-loader.ts`](../src/game/assets/prop-loader.ts:124)
picks up the field and routes those placements through the wave-rider
entity factory ([`src/game/entities/props.ts`](../src/game/entities/props.ts:59))
+ render system instead of the static-prop path — kinematic Rapier
body driven by analytic wave sampling, with spring-damped impact
perturbation. `buoy` and `log` are the current archetypes; tuning
presets live in [`src/game/components/wave-rider.ts`](../src/game/components/wave-rider.ts:66).
Track-side wave-rider buoys are also auto-emitted from the Blender
addon's racing-line buoy tool — see the [Wave-rider buoys](./blender-pipeline-guide.md#wave-rider-buoys)
section of the Blender pipeline guide.

**Per-instance float (no asset change).** Any placed asset prop can be
floated *per placement* — even one whose GLB isn't a wave-rider — via a
`waveRider` field on the **placement** (not the spec). It floats on the
prop's own collider with a size-derived tuning, resting at the authored
height; DOF is `locked` (heave + pitch/roll) or `yaw`. Authored in
Blender's Prop Placements panel. Checkpoint gates have a separate
track-level `floatGates` toggle. See
[Float any prop on waves](./blender-pipeline-guide.md#float-any-prop).

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

### Edit a bike directly (one-click flow)

1. Install the addon once: *Edit → Preferences → Add-ons → Install…*
   pick `tools/blender/hoverbike_addon.py`, tick the checkbox.
2. Open `bikes-src/<id>.blend` (e.g. `bikes-src/racer.blend`).
3. Edit. Move `bike_fairing`, sculpt `bike_body`, drag `socket_seat`,
   recolour materials — whatever the variant needs. Each variant is
   independent; nothing propagates between them.
4. Press **N** → **Hoverbike** tab → **Export Bike to Game**. The
   addon validates (one `bike_root`, all five required sockets, at
   least one collider), writes `public/assets/bikes/<id>.glb`, and on
   first export materialises a starter `specs/bikes/<id>.json` from
   `bike_root` extras + the bike's authored materials. Subsequent
   exports preserve the spec; **Shift-click** rewrites it from the
   `.blend`.
5. Reload `http://localhost:5191/?bike=<id>` (or the **Copy Play
   URL** button in the addon panel). The dev server picks up the new
   GLB on next request.

What lives in each `bikes-src/<id>.blend`:

```
bike_root                    (empty; extras kind=bike, bike_id, ...)
  ├── bike_body              (mesh)
  ├── bike_fairing           (mesh)
  ├── bike_fork              (mesh)
  ├── bike_thruster_0..N     (mesh)
  ├── bike_fin               (mesh)
  ├── bike_tail              (mesh)
  ├── socket_seat            (empty; kind=socket, slot=seat)
  ├── socket_nose_cam        (empty; kind=socket, slot=nose_cam)
  ├── socket_fx_thruster_l   (empty; kind=socket, slot=...)
  ├── socket_fx_thruster_r   (empty; kind=socket, slot=...)
  ├── socket_fx_exhaust      (empty; kind=socket, slot=...)
  └── collider_body          (empty; kind=collider, shape=box,
                              half_extents=[hx, hy, hz] in three axes)
```

Materials follow the convention `mat_bike_<id>_*` (`_chassis`,
`_livery`, `_glow`, `_fork`, `_fin`, `_tail`) so the spec's
`appearance.*` block can recolour them at build time without
clobbering the .blend's roughness/metallic settings.

Studio lights baked into the .blend make the in-Blender preview look
like the in-game viewer; the GLB exporter strips lights
(`export_lights=False`), so they never reach the runtime.

### Re-author the prop kit

Props still use the shared kit at `tools/blender/lib/prop_kit.blend`
(parametric small set, no per-prop .blend yet). Edit + save → watcher
rebuilds. Use `tools/blender/seed_prop_kit.py` to regenerate
placeholders.

Individual parts can also be seeded by a focused script — see
[`tools/blender/seed_buoy_kit_part.py`](../tools/blender/seed_buoy_kit_part.py)
for the pattern. The script wipes any pre-existing `buoy` datablock,
rebuilds the mesh from explicit ring/strip math (so proportions are
tunable via constants at the top of the file), and saves back into
`prop_kit.blend`. Re-run with
`"$BLENDER_EXE" --background tools/blender/lib/prop_kit.blend --python tools/blender/seed_buoy_kit_part.py`
followed by `pnpm gen:props` (rebuilds every spec under `specs/props/`,
including `buoy.glb`) to refresh the deployed GLB.

### Locking a hand-edited prop (non-destructive re-seed)

All three hand-editable seeds are **merge-based** (the shared convention
lives in `tools/blender/seed_merge.py`): re-running opens the existing
`.blend` and refreshes only the assets the seed owns, preserving anything
you added by hand. This covers:

- `seed_props_library.py` → `tracks-src/props-library.blend`
- `seed_landmarks_library.py` → `tracks-src/landmarks-library.blend`
- `seed_prop_kit.py` → `tools/blender/lib/prop_kit.blend` (the kit's
  author-added `buoy`, seeded by `seed_buoy_kit_part.py`, survives a
  prop-kit re-seed because it lives under a name the kit seed never emits)

If you *replace* a seed asset with your own geometry (e.g. a
geometry-nodes race gate), **lock it** so the next re-seed leaves it alone:

- In Blender, select the asset and add a **Custom Property** named
  `hv_locked`, value `1`. For the library seeds that's the `prop_<id>` /
  `landmark_<id>` **collection** (or its `_root` empty); for the prop kit
  it's the **object** itself (e.g. `crate`).
- Re-seed: the log prints `SKIP <id> (hv_locked) — preserving
  hand-authored version`, and the asset's geometry and asset metadata
  (catalogue / tags) are left untouched.

Notes:

- Each seed writes a `<file>.seedbak` copy before every save as a one-deep
  safety net (the `.blend`s are Drive-only — no git history).
- Everything the seed creates is marked `_seed_owned`; an asset you add by
  hand (a name the seed never emits) is preserved without any lock. These
  markers are authoring-only — the runtime never reads them.
- **First-run migration:** a library built *before* this convention has no
  `_seed_owned` markers, so the first merge re-seed back-stamps every
  asset whose name the seed emits and **refreshes** it. The log prints a
  `first merge run: back-stamped N …` warning. If you hand-edited a
  seed-named asset before locking existed, **lock it before that first
  re-seed** — otherwise it is overwritten with the default.
- *Known gaps* (the lock protects an asset's own geometry + asset
  metadata, not shared data the seed regenerates wholesale):
  - `prop_rock` / `prop_palm` drive their shape from a shared `HV_Prop_*`
    geometry-nodes group the seed rebuilds, so locking those two isn't
    fully honoured yet. Hard-surface / baked-mesh assets (gates,
    containers, sea-stacks, landmarks, kit parts, …) lock cleanly.
  - **Shared materials** (`mat_prop_*`, `mat_landmark_*`, `mat_kit_prop_*`)
    are re-tuned in place on every re-seed. A locked asset keeps its mesh,
    but if you re-tinted a material it *shares* with refreshed assets, the
    re-seed resets that material. To keep a custom tint, give the locked
    asset its own uniquely-named material.

### Add a brand-new bike

1. Save-as an existing variant: open `bikes-src/scout.blend`, then
   *File → Save As… → bikes-src/<new-id>.blend*. The .blend basename
   becomes the new bike id.
2. Update `bike_root`'s `bike_id` custom property to match the new id
   (or leave it — the addon backfills from the filename on first
   export).
3. Edit the variant: sculpt, recolour, drag sockets, etc.
4. **Hoverbike → Export Bike to Game**. The addon writes the GLB and
   creates a starter `specs/bikes/<new-id>.json` derived from extras
   + materials.
5. The new bike appears in the manifest. Wire it into
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

- [`v1-asset-pipeline-plan.md`](./v1-asset-pipeline-plan.md) — v1
  production plan + per-track set-piece sequencing.
- [`blender-pipeline-guide.md`](./blender-pipeline-guide.md) — full
  track-author walkthrough + object-kind reference.
- [`tools/README.md`](../tools/README.md) — quick CLI reference.
