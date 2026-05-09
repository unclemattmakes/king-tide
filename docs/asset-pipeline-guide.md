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

#### Custom chassis geometry (`chassisVariant`)

The default chassis is `chassis_base` (a generic cube) scaled per
spec. To ship bespoke chassis geometry instead — own mesh per bike,
no scaling — author `chassis_<your_id>` in `bike_parts.blend` and add
`"chassisVariant": "<your_id>"` to the spec's `geometry` block. The
build appends the named variant at author-modelled size and skips the
`scale = (W, L, H)` step. `chassisLength`/`Width`/`Height` stay
required — they still drive the box collider, the thruster placement,
and the fork/fin/tail mount world positions, so keep them aligned
with the sculpted mesh's actual dims.

#### In-game viewer (`?viewer=<bikeId>`)

For visual verification of a built bike GLB, navigate to
`/?viewer=<id>` (e.g. `/?viewer=scout`). Skips the entire game boot
and renders one bike on a turntable with `OrbitControls`. The HUD
shows mass, top speed, hover height, world bbox, livery/metal/glow
swatches, every socket, and a quick-switch row across the manifest's
bikes. Sockets render as small green dots; the box collider as an
orange wireframe. See
[`src/viewer/bike-viewer.ts`](../src/viewer/bike-viewer.ts).

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

#### Edit-in-context

The bike kit is organized into Blender collections that mirror the
in-game `?viewer=<id>` switch experience. The default outliner state:

```
Source                        ← editable canonical parts (visible by default)
Bike: Calibration Bike        ← snapshot (hidden)
Bike: Cruiser                 ← snapshot (hidden)
Bike: Racer                   ← snapshot (hidden)
Bike: Scout                   ← snapshot (hidden)
Bike: Stunt                   ← snapshot (hidden)
```

Source contains the **editable** canonical parts. Each variant
fairing, fork, fin, and tail is parented to its corresponding
`mount_*` empty, so **moving a mount in the viewport drags the
dependent geometry along** — same live-attach feel as the in-game
viewer. Move `mount_fairing` and all three fairing variants follow.

`Bike: <name>` collections are **static snapshots** built from the
spec at seed time. They contain linked-data instances of the
canonical parts (mesh data shared with Source — mesh edits propagate
instantly). To **refresh a snapshot** after mount edits, re-run
`tools/blender/seed_bike_kit.py`. Toggle a snapshot visible to
eyeball how a different spec resolves without leaving Blender.

The prop kit is laid out as a row along +X — props don't have the
collection structure since they don't share a chassis or vary as
parametrically.

The viewport position of an object in the kit is **layout-only**.
`tools/blender/lib_loader.append_objects` resets each appended object's
location/rotation/scale to identity (skipping `mount_*` / `anchor*`
helpers, whose transforms ARE the data), so the build only sees the
part's mesh data and positions it programmatically per the spec.
Rules of thumb:

- ✅ Free to drag (G), rotate (R), or scale (S) kit objects in the
  viewport to find a better viewing layout — the build ignores it.
- ✅ Edit mesh data freely (Edit Mode → move vertices, extrude, etc.).
  Mesh edits ride through to every bike/prop that uses that part.
- ⚠️ Don't apply object transforms (Object → Apply → All Transforms)
  with the part at a layout position — that bakes the layout offset
  into the mesh, which **does** ride through and will render the part
  in the wrong place at build time.

If you accidentally bake a layout offset into the mesh, fix it by
re-running the seed script (which restores the canonical mesh +
layout) or by editing the mesh back to origin-centred in Edit Mode.

#### Mounts and anchors

Where bike parts attach to the chassis is controlled by **mount
empties** authored in the kit, not by hardcoded math in
`build_bike.py`. The chassis carries small `mount_<role>` empties
(`mount_fairing`, `mount_fork`, `mount_fin`, `mount_tail`) that say
"the fairing/fork/fin/tail attaches *here*." At build time the script
positions each part so its origin (or its `anchor` child empty if
present) lands on the matching mount.

To **move** an attachment point — say the fork should sit further
forward — open `tools/blender/lib/bike_parts.blend`, select
`mount_fork` (parented under `chassis_base`), and translate it. The
fork variants follow live (they're parented to the mount), so you
can eyeball the new pose immediately. Save and re-export — no code
change needed.

To **add a new attachment** — author a new empty
`mount_<your_role>` parented to the chassis, parent the relevant
part(s) to it, then add the matching
`snap_to_mount(part, chassis, "<your_role>")` call in
`build_bike.py`.

For the default `chassis_base` (no `chassisVariant`), mount positions
are in chassis-local space — they scale with `chassis.scale = (W, L,
H)` at build time, so changing the spec's chassis dims moves the
mounts proportionally. For a `chassisVariant`-based bike, the variant
ships at author-modelled size (no scaling), so the mount's
chassis-local position resolves to the same world position as in
Blender.

Mounts (and any optional `anchor` empties on child parts) are
**stripped from the GLB before export** by `strip_build_helpers()`,
so they never ship to the runtime. Runtime `socket_*` empties (seat,
nose_cam, fx_*) are a separate concept and do ride into the GLB.

Thrusters stay parametric — their count and X spacing come from
`spec.geometry.thrusterCount`/`thrusterSpacing` and the build code
does the math directly. Too dynamic to express as fixed mounts.

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
