# Track art-pass playbook (for Claude / level designers)

> How to dress an existing, gameplay-complete track with props + foliage
> **without breaking its gameplay or its source `.blend`**. Written from the
> Sandbar art pass (2026-05-31). Companion to
> [tracks/README.md](./tracks/README.md) (per-track design + prop manifests),
> [track-editor-guide.md](./track-editor-guide.md), and
> [blender-pipeline-guide.md](./blender-pipeline-guide.md).
>
> This playbook is the *how* of dressing. For the *what it should look like* —
> the track's built/broken/blooming ratio, palette family, and set-piece notes —
> read [track-art-direction.md](./track-art-direction.md) (and
> [prop-art-direction.md](./prop-art-direction.md) for the props you're placing)
> before you start.

An "art pass" = the foundations (terrain, racing line, checkpoints, buoys) are
already authored; you're adding scenery. Two surfaces hold a track's data and
they are **owned by different layers** — know which one each change belongs in.

## 1. Two surfaces, two owners

| Surface | File | What lives here |
|---|---|---|
| **Gameplay data** | `public/tracks/<id>.json` | checkpoints, AI spline, buoys, pickups, start, sky, water, **`props[]`** |
| **Environment geometry** | `public/assets/tracks/<id>.glb` | terrain mesh, baked scatter/foliage (instanced), set-piece geometry |

The `.glb` + `.json` are exported from a raw `<id>.blend` that lives in the
**Drive content root** (`C:\project-content\hoverbike\tracks-src\`, gitignored),
**not** the repo's `tracks-src/` (templates + `props-library.blend` only).

**Editor-canonical vs Blender-owned (the export merge contract, in
`hoverbike_addon/_legacy.py`):** on `Export Track`, these JSON keys are
**re-derived from the `.blend` and overwrite the JSON** —
`BLENDER_OWNED_JSON_KEYS` = `aiSplines`, `waveRiderBuoys`, `checkpoints`,
`start`, `sky`, `water`, `terrainShader`, `gateSpacing`, `lapsToFinish`,
`environmentGlb`, `roadSpline`. Everything else (**`props[]`**, `pickupSpawns`,
`boostPads`, `antiGravZones`, `waveZones`) is **editor-canonical** — preserved
across a re-export. So:

- **Placed props → edit `public/tracks/<id>.json` `props[]` directly.** It
  survives re-export.
- **Seeing props in Blender:** asset `props[]` are mirrored into a hidden
  `_hoverbike_props_preview` collection (the shipping GLBs at the runtime pose).
  This now **auto-syncs on opening a track `.blend` and on *Reload from JSON***
  (deferred via a timer; addon `prop_placements.py:schedule_auto_import`), so
  placed props show up like the buoy/gate/water previews. Move them and click
  **Write Prop Placements → JSON** to push edits back. (Procedural `box`/
  `cylinder` props are JSON-only — not mirrored into the preview.)
- **Float a placed prop on the water** (boats, debris, …) — select its preview
  instance(s), tick **Float on Waves** in the Prop Placements panel, pick a
  Motion mode, **Apply Float to Selected**, then **Write**. Per-instance, uses
  the prop's own collider. See
  [blender-pipeline-guide.md → Float any prop on waves](blender-pipeline-guide.md#float-any-prop).
- **Geometry / scatter / foliage → edit the `.blend`, re-export the GLB** — but
  see §6, the re-export rewrites the gameplay JSON too.
- **Never run `seed_track_<id>.py`** on an authored track — it rebuilds from a
  template and stomps every hand edit.

## 2. Placing props in `props[]`

Entry shape (`src/game/tracks/types.ts` `Prop`):
```json
{ "type": "asset", "assetId": "ai/sea_boulder",
  "position": {"x":..,"y":..,"z":..}, "rotation": {"x":0,"y":..,"z":0,"w":..},
  "size": {"x":1,"y":1,"z":1} }
```
- `assetId: "ai/sea_boulder"` → loads `/assets/props/ai/sea_boulder.glb`
  (`public/assets/props/ai/`). AI props are conditioned with their **base at
  y=0**, so **`position.y` is the surface height the base rests on.**
- `size` is a **uniform scale multiplier** on the GLB's intrinsic size. Props
  are already conditioned to game scale (`specs/props/ai/<level>.json`
  `target_height`), so keep ~1.0; vary 0.85–1.4 for natural variation.
- `rotation` is a quaternion. Yaw θ about Y → `{x:0, y:sin(θ/2), z:0, w:cos(θ/2)}`.
- Runtime does **no terrain snapping** — `position.y` is literal. Seat it yourself.
- A clean way to add/replace `props[]` without reformatting the whole file: load
  the text, find the `\n  "props":` key (keep it last), and splice a freshly
  serialized block in. (json.dump reformats everything; the splice keeps the
  diff tight.)

## 3. Get the REAL terrain — don't trust the design doc

Design docs lie about land/water ratio and shape (they predate the built
terrain). Raycast the **actual** mesh. With the live Blender MCP and the track's
`.blend` open, build a BVH over the `terrain` mesh and ray-cast straight down:

```python
from mathutils.bvhtree import BVHTree
ev = terrain.evaluated_get(depsgraph); me = ev.to_mesh(); mw = terrain.matrix_world
bvh = BVHTree.FromPolygons([mw@v.co for v in me.vertices],
                           [tuple(p.vertices) for p in me.polygons])
ev.to_mesh_clear()                      # capture len(me.vertices) BEFORE this
hit = bvh.ray_cast((tx, -tz, 200), (0,0,-1))   # three.js (x,z) -> Blender (x,-z)
h = hit[0].z                            # Blender Z == three.js Y (terrain height)
```

**Coordinate transform: three.js `(x,y,z)` = Blender `(bx, bz, -by)`.** Verify
it before trusting it — map a `start_00`/`cp_NN` empty's Blender translation to
its JSON value (they match exactly on a faithful export).

Render a coarse **annotated top-down map** (raycast a grid → ASCII or a PIL PNG,
overlay `start`/`checkpoints`/`waveRiderBuoys`/`props` from the JSON) to design
against. Blender's Workbench/EEVEE render works fine for this — only the game's
**WebGPU** path can't be screenshotted headlessly (§7).

## 4. HARD RULE — keep props out of the AI racing corridor

Props with colliders sitting in the corridor make the **AI unable to finish the
race** (they get stuck). "Distance to nearest buoy" is **not** a sufficient
check. Verify against the real corridor:

1. Densely sample the AI line: closed **Catmull-Rom through
   `aiSplines[0].anchors`** (~12+ pts/segment).
2. Corridor half-width = distance from each `waveRiderBuoys` entry to that line
   (buoys are the channel walls; ~42 m half-width on Sandbar).
3. A prop is safe only if `dist(prop, AI line) ≥ (local buoy half-width) + ~12 m`
   — i.e. **outside the buoy wall**. Also keep ≥ ~16 m from any checkpoint
   centre (gate `halfWidth` is ~14).

If a region's shoreline falls *inside* the corridor (e.g. a bay the line sweeps
through), **leave it bare** rather than crowd the line. Scenery reads fine at
50–120 m off the line.

## 5. Seat + sink so props look rooted

- Seat each prop at the **raycast terrain height** at its `(x,z)`.
- **Sink rocks / sea-stacks into the ground** so they read as part of the
  environment, not perched: `position.y = terrainH − f·intrinsicHeight·size`,
  `f ≈ 0.30` for boulders/rubble/anchors. Wrecks/cabs settle a fixed ~1.5–2 m.
- **Sea-stacks rising from water:** place on a shallow shoal/seabed and size them
  so the top clears the water (`top = base + intrinsicHeight·size`, water is at
  `track.water.height`, usually `-1.5`). Steep shores drop to −20…−40 m fast —
  a stack on deep seabed vanishes underwater, so pick shallow rims or scale up.

## 6. Foliage / scatter + re-exporting the GLB (preserve gameplay!)

Palms/foliage live in the **env GLB**, not `props[]`. Runtime sway
(`engine/render/foliage-sway.ts`) auto-applies to any material named
`mat_foliage_*` (and reads `COLOR_0` for sway strength/phase). `prop_palm` in
`tracks-src/props-library.blend` already uses `mat_foliage_palm*` + has `COLOR_0`.

For ~a dozen, **hand-place** (more reliable seating than GN scatter on hilly
shore, which lays a flat grid): append `prop_palm_mesh`, duplicate it sharing the
mesh datablock, raycast-seat each on a shore (`0.4 ≤ h ≤ ~9`), set
`obj['kind']='decoration'` (render-only — no collider, skipped by the heightmap),
scale ~3× (props read ~3× small), vary yaw. Put them in a **normal collection**
(not a `_hoverbike_*` preview) so the export includes them.

**Re-export with the addon `Export Track` operator** (`bpy.ops.hoverbike.export_track()`)
— it hides `_hoverbike_*` preview collections, realizes scatter, and writes the
GLB correctly. A naïve `export_scene.gltf` would wrongly include the gate/buoy/
water previews. The operator resolves the repo root via addon pref /
`$HOVERBIKE_REPO_ROOT` → writes to the **git clone**, not the content folder.

**The catch:** `export_track` also re-derives + overwrites the Blender-owned JSON
keys (§1) from the `.blend`'s *current* state. To ship **GLB-only** art without
disturbing authored gameplay (especially if someone was mid-edit on the spline):
**back up `public/tracks/<id>.json`, run the export, then restore the backup.**
The GLB only carries terrain + your foliage (splines/curves aren't exported as
geometry), so the restored JSON stays perfectly consistent. Then **save the
`.blend`** so the foliage persists in source for future re-exports.

## 7. Verification — what you can and can't check headlessly

- **All prop GLBs fetch (no 404), no console errors, track loads** — checkable
  via the Claude-Preview dev server (`?track=<id>`): `preview_network` (filter
  `failed`), `__hover.qa.consoleHasErrors()`, `__hover.ready`.
- **AI lap completion / feel — NOT reliably checkable headlessly.** A
  backgrounded preview tab **pauses `requestAnimationFrame`** (`__hover.fps()`
  → 0), so the sim never steps and bikes read idle regardless of props.
  `__hover.setIntentOverride(intent)` skips the start countdown, but it won't run
  if rAF is paused. **WebGPU screenshots also fail** headlessly. Hand the
  in-engine look + race-completion to a **foreground playtest** — the user's
  hands-on read is the source of truth.
- Your static guarantees (§4 corridor clearance, §3 seating against the real
  terrain) are what carry the headless pass.
