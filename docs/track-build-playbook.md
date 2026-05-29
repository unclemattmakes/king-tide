# Building a track from scratch in Blender — a playbook

How to take a track from a blank Blender scene to an exported, playable
GLB + JSON using the Hoverbike addon. Written after the Cape Hatteras
(`hatteras-light`) rebuild; captures the workflow that worked **and the
gotchas that cost time** so the next builder doesn't re-hit them.

This is the *workflow* layer. For the underlying pipeline see
[blender-pipeline-guide.md](blender-pipeline-guide.md), the in-app
editor see [track-editor-guide.md](track-editor-guide.md), and the
content bible / numeric spec for each track in
[track-themes.md](track-themes.md) + [track-design-specs.md](track-design-specs.md).

## Before you start

1. **Read the design first.** Pull the track's entry from
   `track-themes.md` (theme, palette, set-piece, lore) and
   `track-design-specs.md` (lap target, beat table, Blender shopping
   list, sky/wave numbers). Build a one-paragraph mental model and a
   beat table you can check every later decision against.
2. **Confirm your tooling.**
   - Addon installed/symlinked (`pnpm install:blender-addon`).
   - `props-library.blend` exists in `tracks-src/` (run
     `pnpm seed:props-library` if not — otherwise the scatter ops have
     nothing to link; see gotchas).
   - The addon's **Project-root** pref / `$HOVERBIKE_REPO_ROOT` points
     at the clone you want exports to land in. **Exports go there, not
     wherever your `.blend` lives, and not your current git worktree.**
3. **Inspect the scene before you build.** If you're handed a
   "blank" file, check for orphaned datablocks
   (`bpy.data.objects` vs `scene.objects`) and **purge them first** —
   leftover orphans break the addon's terrain finders (see gotchas).

## The four passes

Work in this order. Screenshot/inspect after each sub-step — it's
cheaper than guessing a number three times.

### Pass A — Terrain & landmarks
- **Terrain base.** For land/island tracks: *Add Island Terrain*
  (`hoverbike.add_island_terrain`) — it wires up the runtime terrain
  shader + `COLOR_0`/`baked_ao`/`baked_path`/`baked_biome` vertex
  attributes you need later. For **open-water tracks (80 %+ sea)** the
  volcanic island template fights you — see the `Shelf Depth` gotcha.
  Drop the terrain *object's* Z for global sea depth; use the peak
  empties (small `top.z`) as low sandbar shoals.
- **Sea level.** `hoverbike_water_height` (usually 0); turn on the
  water preview (`hoverbike.rebuild_water_preview`) so you can read
  what's above/below the waterline.
- **Hero landmark.** Model it as a `kind="track"` mesh. The
  `seed_landmarks_library` builders are parametric but have a known bug
  (below) — for a hero piece, modeling directly with bmesh is reliable.
  Use **op return values** (`ret['verts']`) for translate/scale, never
  `bm.faces[pre:]` slicing without `ensure_lookup_table()`.
- Bake biome/AO/path attrs (`hoverbike.bake_terrain_attrs`).

### Pass B — Racing line, gates, buoys, wear
- **AI spline.** `hoverbike.add_ai_spline` creates the canonical
  `ai_spline_main` (cyclic). Reshape its control points to your line;
  the racing surface for open-water tracks is *just the spline + gates*
  (no road ribbon). Keep water sections at hover height (~z 3.5) and
  let the line climb in 3D for set-pieces.
- **Tune lap length** to the spec target (≈ arc-length ÷ ~25 m/s for
  Reef pace). Measure via the evaluated polyline; scale the line to hit
  it.
- **Set-pieces (anti-grav).** Build the climb tube *along the same
  helix the spline follows* (`build_antigrav_ribbon_from_curve`,
  `PROFILE_TUBE`) so the line threads the tube with no clipping. It
  auto-stamps `_zone_entry`/`_zone_exit`.
- **Gates + buoys.** `hoverbike.rebuild_gate_preview` (sets
  `gateSpacing`); over-water samples auto-flag buoys.
- **Checkpoints.** Place `cp_NN` empties at beat boundaries. **Each
  needs an `index` custom prop** (`cp["index"]=N`) or export validation
  fails — or use `hoverbike.materialize_gates_to_cp_empties`, which
  sets it.
- **Starts.** `hoverbike.snap_starts_to_spline` at `hoverbike_start_t`
  (≈0.96 = just before the finish line).
- **Track wear.** `hoverbike.bake_path_worn` along the line.
- Verify with `rebuild_ghost_lap` / `rebuild_turn_indicators` /
  `rebuild_racer_preview`.

### Pass C — Props (instanced)
- Scatter via geometry nodes so props export as
  `EXT_mesh_gpu_instancing`. The export realizer keys on the **modifier
  name prefix `HV_Scatter`** — name your scatter modifier accordingly
  and instances collapse automatically.
- **Density gradient.** Gate the scatter on a height/biome selection so
  props only land where they should (e.g. shoals only → clean racing
  water, alive periphery). One height-gated modifier on the terrain
  beats hand-placing hundreds of props.
- Hero detail (piers, breakwaters, etc.): hand-place instances sharing
  one mesh datablock.

### Pass D — Lighting, ambience, horizon, export
- **Sky.** Set the `hoverbike_sky_*` scene props from the spec
  (cloudiness, sun, fog near/far, time-of-day, sea-state, color grade,
  tint, bloom). These export to the JSON `sky` block.
- **Wave zones.** `hoverbike.add_wave_zone` (or `wave_zone_NN` empties)
  — typically an open-swell zone + a sheltered lee.
- **Custom horizon.** `hoverbike.add_horizon_ring` then edit-mode the
  top edge, **or** author the mesh directly (top vert per angle =
  silhouette height, bottom = base −40). Keep the radius inside
  `fogFar` or the silhouette is fully fogged out. The runtime
  camera-locks it.
- **Emitters.** `hoverbike.add_emitter` (or `emitter_NN` empties with
  `atlas_cell`/`emit_rate`/`lifetime_s`/… extras). Include the required
  explosion emitter.
- **Hero camera.** `camera_hero` (`kind="camera_hero"`) — the export
  renders the hero + tile thumbnail from it.
- **Export.** `hoverbike.lint_track` then `hoverbike.export_track`.
  Save the `.blend` afterward (`Ctrl+S`).

## Gotchas (hard-won)

- **Orphan datablocks break terrain finders.** Unlinked leftovers in
  `bpy.data` get picked up (`'_orphan_terrain' has no evaluated mesh
  data`). Purge them first; renaming isn't enough (finders key on
  `kind`/largest-bbox, not name).
- **`HV_TemplateIsland` `Shelf Depth` does not lower the open seabed**
  — it's additive over a flat z=0 base; the cones are world-anchored to
  the peak empties. Drop the terrain object's Z for depth; use peaks
  for shoals. *A flat-seabed template would save everyone this dance.*
- **`cp_NN` needs an `index` prop** or validation cancels the export.
- **JSON export is opt-in merge, not stomp** (`_merge_export_json`). It
  only overwrites `pickupSpawns`/`boostPads`/`waveZones`/
  `antiGravZones`/`checkpoints` when the scene has the matching visible
  empties. **Build from scratch but skip placing those empties → the
  old JSON's values silently leak through.** Author *every* gameplay
  element as empties in one pass. (`audio`/`lapWeather` are preserved by
  design — they aren't Blender-authored.)
- **`props-library.blend` may be missing**; the scatter ops fail to
  link a source. Seed it, or build a local kit + `HV_Scatter*`-named GN
  modifier.
- **`seed_landmarks_library` `_append_*` helpers** identified new
  geometry with a `bm.faces[pre_face_count:]` slice. `bmesh.ops` reorder
  internal element storage, so after multiple `_append_*` calls the
  slice returns the *wrong* faces and re-translates earlier verts — the
  cylinder tower's aperture stacked to ~2× height (118 m for a 54 m
  tower). **Fixed** in `_append_box`/`_append_cone` by using the op's
  `ret["verts"]` and deriving faces via `link_faces`. The same fragile
  pattern still exists in other inline builders (≈ lines 364/379/501/608
  and `_new_face_indices`) — use op return values, never a face-index
  slice, when sweeping multi-part bmesh.
- **Exports land in the configured clone, not your worktree.** After
  exporting, `git status` the *main clone* and decide deliberately
  where the files should be committed.

## Pre-export checklist

- [ ] Lap length within ~10 % of the spec target.
- [ ] Start grid, ≥1 checkpoint per beat, every `cp` has an `index`.
- [ ] All gameplay elements authored as empties (pickups, boosts,
      zones) — not left to merge from stale JSON.
- [ ] Hero camera present (for the thumbnail).
- [ ] `lint_track` clean.
- [ ] After export: verified the right files changed in the right repo,
      and the look in a **headed/WebGPU** browser (not headless).
