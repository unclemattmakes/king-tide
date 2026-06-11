# Level-design playbook — building a track from a shape-only canvas

> **⚠ Canonical track-build workflow (consolidated 2026-06).** This is *the*
> build-a-track-from-scratch playbook — it supersedes the archived
> [track-build-playbook.md](./track-build-playbook.md), whose unique gotchas were
> folded into "Before you start" + §8 here. Written during the **South Beach
> Sunken** build, which was cut in the 2026-06 content pass (the Reef opener is
> being rebuilt as **Mexico City**) — the *track* changed, the *pass workflow
> is current and track-agnostic*. **Anti-grav is cut** (parked for a possible
> DLC): don't author anti-grav set-pieces; verticality comes from terrain, ramps,
> berms, and cliffs.

> How to take a **shape-only** track (a locked racing line on open water, no
> geometry) all the way to a dressed, playable level. Written from the **South
> Beach Sunken** build (2026-06). This is the *build-from-scratch* companion to
> [track-art-pass-playbook.md](./track-art-pass-playbook.md) (which dresses an
> *already-gameplay-complete* track). Read both, plus
> [blender-pipeline-guide.md](./blender-pipeline-guide.md),
> [track-editor-guide.md](./track-editor-guide.md), and the per-track design +
> art-target docs in [tracks/](./tracks/README.md).
>
> The whole job is done in the connected Blender via MCP (`execute_blender_code`
> + `render_viewport_to_path`), authoring the content-root `.blend` and exporting
> with `bpy.ops.hoverbike.export_track`. The `.blend` lives in the Drive content
> root (`C:\project-content\hoverbike\tracks-src\<id>.blend`, gitignored); only
> the compiled GLB + JSON are committed.

## 0. The two rules that matter most

1. **OPEN THE CONCEPT ART BEFORE YOU MODEL.** The MJ plates live at
   `C:\project-content\hoverbike\concept-art\midjourney\<track>\best\`. The text
   design docs are *not* a substitute — they cost me a near-total hotel redo
   (I built squat grey boxes; the plate showed tall pastel Art-Deco with
   tower-fins, eyebrow windows, awnings). Read the hero plate + the relevant
   beat plate **and** the full [art-direction.md](./art-direction.md) +
   [track-art-direction.md](./track-art-direction.md) section first. Treat plates
   as mood/material/proportion, not literal geometry.
2. **WORK IN PASSES; CONFIRM AT EACH BOUNDARY WITH A DIAGRAM.** Don't run ahead.

## Before you start (tooling)

- **Read the design + the concept-art plates first** (rule 0 above): the track's
  `docs/tracks/<id>.md`, its `-art-target`, `track-themes.md`, and the beat table
  in `track-design-specs.md`.
- **Addon installed/symlinked** — `pnpm install:blender-addon`.
- **`props-library.blend` exists** in `tracks-src/`, or the scatter ops have
  nothing to link — seed it with `node tools/blender/seed.mjs seed_props_library.py`
  if missing.
- **The addon's *Project root* pref / `$HOVERBIKE_REPO_ROOT` points at the clone
  you want exports to land in** — exports go *there*, not wherever the `.blend`
  lives, and not necessarily your current git worktree (see §8).

## 1. The pass workflow (the spine)

Build in this order, lock each pass before the next:

1. **Race-line SHAPE** — the 2D footprint + direction.
2. **TERRAIN + postcard landmarks** — the land/seabed and the hero set-pieces.
3. **Race line VERTICALLY aligned to terrain** — *skippable.* A flat line works
   fine; only raise it over terrain/rooftops if the design demands it and the AI
   can follow (spline-follower + hover physics handles gentle ramps).
4. **IN-TRACK props** — pickups, boost pads, ramps, buoys (gameplay rhythm).
5. **OUT-OF-TRACK props** — palms, distant ruins, horizon skyline (parallax /
   sells speed).

Passes can run out of order on request (e.g. add buoys + skyline mid-stream), and
"polish" (art detail, wave zone, waterline) sits *outside* the passes. The owner
playtests between passes and steers — **lean on that**, it's the real look check.

## 2. The "blocking-out-the-beats" diagram (do this at every boundary)

The single highest-leverage communication tool. Render a **top-down ortho** of the
loop with:
- the **race line** as a thin bright ribbon (sample the cyclic Bézier, build a
  flat strip),
- each **moment** as a flat colored quad/ellipse at its location (sandbar = cream,
  hotel row = pink, set-piece = terracotta, finish = mint, skyline = grey strip),
- **direction arrows** (green) tangent to the line,
- a **legend in the file caption**.

Send it, take the owner's **draw-over** screenshot back, and fold the edits in
(reverse direction, resize sandbar, move a hotel to the inner side, mark OOB prop
spots). Cheap to iterate, locks alignment before any detail is built.

## 3. Coordinate transform (memorize)

**three.js `(x, y, z)` = Blender `(x, z, −y)`.** Verify on every track by mapping a
`start_00` empty's Blender translation to its JSON `start.position` — they match on
a faithful export. Evaluate the racing line by sampling `ai_spline_main`'s cyclic
Bézier (per-segment cubic through `co`/`handle_right`/`handle_left`), build an
arc-length table, and place everything by `s ∈ [0,1)` or by physical XY. The design
docs' beat timings map onto `s` via the lap-time target.

## 4. Pass-by-pass

### Pass 1 — race-line shape
Usually "already set." To **reverse direction**: select `ai_spline_main`,
`bpy.ops.hoverbike.reverse_spline()` then `snap_starts_to_spline()` (re-faces the
grid; "same line, flipped facing"). Keep the 2D shape unless the owner explicitly
wants a reshape — single loop around one feature reads clean; save braided/urban
for a later track.

### Pass 2 — terrain + landmarks
**Terrain is built with the addon's tools** (validated — see findings). Recipe:
- `add_island_terrain` drops a 1024² `HV_Island` GN terrain (`kind=track`).
- **`Shelf Depth`** socket = the lagoon floor (set deep, e.g. −14, so race channels
  read deep / no surf; the sandbar rises above it).
- **Peaks** (`peak_NN_base`/`_top` empties) shape landforms; repurpose peak 0 into
  your sandbar (low summit, no crater, `Cone Erosion N = 0`). Clear unused peak
  slots. `add_island_mod_zone` adds non-destructive local raise/carve bumps.
- **Decimate** the terrain (148k verts → ~27k via a Decimate modifier, ratio ~0.18)
  before export or the collider/load is heavy.

**Landmarks are hand-authored.** There is **no Deco/pastel building tool**
(`add_downtown` is modern grey towers — wrong register). Build oriented boxes along
the track tangent. For **flooded** buildings: sink the base well below water
(−16 m) and keep the roof low above it — "squat fits flooded" because the
translucent in-engine water shows the submerged floors (Workbench's opaque water
hides them, so they look like little boxes in clay — don't be fooled).

### Pass 3 — vertical line (skippable)
`snap_spline_to_terrain` conforms the line to terrain. Often unnecessary.

### Pass 4 — in-track props
- **Boost pads**: `boost_NN` empties (`kind=boost_pad`, props `half_width/height/
  depth/strength`, **local +Y = boost dir** → set `rotation_euler.z = atan2(−tx,
  ty)` to aim along the tangent). → `boostPads[]`.
- **Pickups**: `pickup_NN` empties (`kind=pickup_spawn`, position only). →
  `pickupSpawns[]`.
- **Ramps**: `create_gn_ramp(...)` (tested GN wedge, `kind=track`) or hand wedges.
  **Orient the ramp's uphill ALONG the track tangent** — a ramp perpendicular to
  travel is an obstacle, not a launch (this bit us on the seaplane).
- **Buoys**: `rebuild_buoys()` walks the line where it crosses open water. **It
  silently no-ops if sea level is 0 and there's no water object** — first run
  `rebuild_water_preview()` (creates `water_preview`). Buoys are **Blender-owned**
  (`waveRiderBuoys` re-derives every export), so the water reference must be present
  *at export time* — but `water_preview` is a standard preview, hidden from GLB
  geometry, so it doesn't leak.

### Pass 5 — out-of-track props
- **Palms**: build one simple palm mesh (tapered trunk + radiating frond quads),
  give fronds a **`mat_foliage_*`** material (runtime sway auto-applies), and place
  many instances sharing the datablock. **Raycast-seat** them: `scene.ray_cast(dg,
  (x,y,300),(0,0,-1))`, keep hits on terrain (sandbar) above water. Watch out:
  `water_preview` is a raycast target too — filter by the hit object's name.
- **OOB props**: distant ruins/cranes/ships/billboards at the owner's marked spots,
  `kind=decoration`, tall enough to read at distance (parallax).
- **Horizon ring**: `add_horizon_ring` then rewrite the **top-edge verts** per angle
  (`mesh.vertices[2*i].co.z = skyline_height(theta)`): a blocky downtown skyline on
  the city side, ~flat on the ocean side. Camera-locked at runtime, so a compass
  direction stays put as you lap. `kind=horizon`; the GLB loader extracts it.

### Polish (outside the passes)
- **Wave zone** (every track needs ≥1): `wave_zone_NN` empty (`kind=wave_zone`,
  `height_mult ~1.5`, `freq_mult`, half-extents; swell dir = local +X). Put a swell
  over the open straight; leave the inner bay calm. → `waveZones[]`.
- **Sky/water grade**: set scene `hoverbike_sky_color_grade='miami_pastel'`,
  `hoverbike_sky_time_of_day`, `_bloom`, etc. (Blender-owned → exports into `sky`).
- **Neon**: emissive materials (Principled `Emission Color` + `Emission Strength`)
  → glTF `emissiveFactor` → glows + picks up bloom in-engine. Only powered things
  glow (art-direction rule).

## 5. The export contract (get this wrong and you lose work)

`export_track` writes the GLB **and re-derives the Blender-owned JSON keys from the
`.blend`**: `aiSplines, checkpoints, start, sky, water, terrainShader,
waveRiderBuoys, gateSpacing, lapsToFinish, environmentGlb, roadSpline`. Everything
else (`props[], pickupSpawns, boostPads, waveZones`) is **editor-canonical**
(preserved) — but note `boostPads/pickupSpawns/waveZones` are *derived from
`boost_NN`/`pickup_NN`/`wave_zone_NN` empties* when those empties exist in the
`.blend`. **After every export, parse the JSON and confirm** the keys you expect
(reversed spline first anchor, sky grade, buoy/boost/pickup/zone counts). Parsing
the GLB/JSON directly is the **one reliable verification you have** (see §6).

### Pre-export checklist

- [ ] Lap length within ~10% of the spec target.
- [ ] Start grid placed; ≥1 checkpoint per beat; every `cp` has an `index`.
- [ ] Every gameplay element authored as an empty (pickups, boosts, zones) — not
      left to merge from stale JSON.
- [ ] Hero camera (`camera_hero`) present for the thumbnail.
- [ ] `lint_track` clean.
- [ ] After export: the right files changed in the right repo, and the look
      verified in a **headed/WebGPU** browser on **your own** dev server (§6).

## 6. Verification reality — what you can and can't see

- **Workbench clay ≠ in-engine.** Pastels (BSDF base color), translucent turquoise
  (the submerged floors!), the sunset grade, neon glow, and the horizon shader **all
  only read in the WebGPU renderer.** Judge **massing / composition / clearance**
  from Blender; do **not** judge the look from clay.
- **Headless can't help with the look — and neither can a shared preview.** A
  backgrounded preview tab pauses `rAF` and WebGPU can't be screenshotted; the
  autostart loader is flaky. Verify look + feel in **your own headed browser on
  your own dev server** — `pnpm dev --port <N> --strictPort`, open
  `localhost:<N>` — **not** the Claude in-app preview and **not** a shared
  web-extension tab (parallel instances cascade ports; CLAUDE.md hard rule 2).
  Use it at most for a clean *load* check (no console errors).
- **Verify the artifact, not the render.** Parse the exported GLB (node `kind`
  counts, biggest-mesh sanity, no preview leak) and the JSON (gameplay keys) with a
  tiny Node script — that's deterministic and trustworthy.
- **The owner's foreground playtest is the source of truth** for look + feel + AI
  completion. Hand it over; iterate on their read.

## 7. Wins (what worked)

- **Pass structure + blocking diagrams** = tight, cheap alignment; the owner could
  redirect before any detail was sunk.
- **Terrain genuinely buildable with our tools** — `add_island_terrain` + peak
  chaining + an **auto-fit loop** (shrink lobes until clearance-to-line ≥ 40 m) beat
  hand-tuning.
- **Raycast-seating** props; **emissive neon**; **hand-authored** Deco landmarks.
- **Export preserved gameplay byte-identical** when nothing gameplay-relevant
  changed — confirmed by diffing the JSON.

## 8. Failures / gotchas (what bit us)

- **Built off text, not the plates** → hotel redo. (Rule 0.)
- **Island peaks are radial: `scale.x` is the radius, `scale.y` is ignored** (see
  `seed_template_island.py`). No elliptical single peak — **chain peaks/mod-zones**
  for elongated landforms.
- **A peak's above-water footprint ≈ 1.35× its base radius** and isn't obvious by
  hand → auto-fit against the race line instead of eyeballing.
- **Ramp built perpendicular to travel = obstacle.** Orient uphill along the tangent.
- **Decimate breaks the path-wear bake** (vertex-count mismatch) — harmless when the
  racing surface is water, but noisy.
- **Empties leak into the GLB as 0-vert nodes** (`peak_*`, `boost_*`, `pickup_*`,
  `wave_zone_*`). Harmless (runtime ignores non-`track`/`horizon` nodes) but untidy;
  custom `_hoverbike_*` collections are **not** auto-hidden on export the way the
  standard previews are.
- **Buoy tool no-ops without a water reference** at sea level 0 → make a
  `water_preview` first.
- **MCP viewport *screenshot* is stale/unreliable** — use offline
  `render_viewport_to_path` and `Read` the PNG instead.
- **Don't park objects in `_hoverbike_*` preview collections** — operators
  regenerate those collections and deleted my preview camera.

Folded from the earlier Cape Hatteras build:

- **Orphan datablocks break the terrain finders.** Unlinked leftovers in
  `bpy.data` get picked up (`'_orphan_terrain' has no evaluated mesh data`).
  Purge them first; renaming isn't enough (finders key on `kind` / largest-bbox).
- **`cp_NN` needs an `index` custom prop** (`cp["index"]=N`) or export validation
  cancels — or use `hoverbike.materialize_gates_to_cp_empties`, which sets it.
- **JSON export is opt-in merge, not stomp.** It overwrites
  `pickupSpawns`/`boostPads`/`waveZones`/`checkpoints` only when the scene has the
  matching visible empties — build from scratch but skip placing those empties and
  the *old* JSON's values silently leak through. Author **every** gameplay element
  as empties in one pass.
- **Exports land in the configured clone, not your worktree.** After exporting,
  `git status` the main clone and decide deliberately where the files belong.

## 9. Tool cheat-sheet

`reverse_spline` · `snap_starts_to_spline` · `add_island_terrain` ·
`add_island_mod_zone` · `create_gn_ramp` (`hoverbike_addon.ramp`) · `add_boost_pad`
(+ `pickup_NN`/`wave_zone_NN` empties authored directly) · `add_wave_zone` ·
`rebuild_water_preview` → `rebuild_buoys` · `add_horizon_ring` (+ edit top verts) ·
`export_track`. Materials: `mat_foliage_*` sways; emissive → neon; flat BSDF for
track/decoration.
