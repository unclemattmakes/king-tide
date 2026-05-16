# Addon reference

Comprehensive reference for the in-Blender addon — every panel, every
operator, and the headless builders that mirror them. For a guided
walk-through that uses these tools end-to-end, see
[Your first track](./your-first-track).

## Top-level panel

Press **N** in the 3D viewport → switch to the **Hoverbike** tab.
The panel re-renders based on the `.blend`'s parent directory:

| Parent dir | Mode | Header buttons |
|---|---|---|
| `tracks-src/<id>.blend` | Track | **Export Track to Game**, Lint, Reload from JSON, Play / Edit, Copy Play / Edit URL |
| `bikes-src/<id>.blend` | Bike | **Export Bike to Game**, Copy Play / Viewer URL |
| anything else | Unknown | Help text — save your .blend somewhere recognised |

Inside track mode you get 12 collapsible sub-panels covering every
authoring tool. Bike mode is intentionally minimal — the .blend is
the source of truth; the export is one click.

---

## Track sub-panels

### Spline tools

Operates on `ai_spline_main` — the canonical racing line.

| Operator | What it does | Notes |
|---|---|---|
| **Snap Spline to Terrain** | Raycasts each control point straight down onto the scene, then lifts each hit by **Hover (m)**. | Hides preview gizmos during the cast so they can't catch the ray. Hides `road_main` too so the spline lands on terrain, not the road slab. Water counts as drivable. |
| **Cursor → Spline** | Moves the 3D cursor to a parameter `t` ∈ [0,1] along the racing line, with rotation aligned to the tangent. | Useful before dropping a ramp / boost pad / prop so it inherits the racing-line orientation. |
| **Snap Starts to Spline** | Repositions `start_00` / `start_01` on the racing line, perpendicular to the tangent, at **Start gap** apart. | The grid pattern for AI bikes spawns relative to `start_00` (see `specs/grid-offsets.json`). |
| **Add Ramp at Spline t** | Snaps the cursor (using *t*), then drops a ramp. One-click. | Uses the current ramp dimensions from the Ramps sub-panel. |
| **Auto-place Ramps** | Drops tangent-aligned ramps at every curvature peak above **\|κ\|**, respecting **Spacing**. | Same curvature detector that powers the turn-indicator preview. |

Scene properties live here: `hoverbike_snap_hover_height`,
`hoverbike_placement_t`, `hoverbike_start_grid_spacing`,
`hoverbike_auto_ramp_kappa`, `hoverbike_auto_ramp_min_spacing`.

### Placement helper

A persistent, curve-constrained empty named `placement_helper`.
Park it at any (`t`, lateral offset) and use it as a placement
anchor.

| Operator | What it does |
|---|---|
| **Add Placement Helper** | Spawns the singleton (or re-poses it to the current `t` / offset). |
| **Remove Placement Helper** | Deletes the helper. |
| **Cursor → Helper** | Snaps the 3D cursor to the helper's transform. |
| **Add Ramp at Helper** | Drops a ramp at the helper's pose. |
| **Add Boost Pad at Helper** | Drops a boost pad at the helper's pose. |

Scene properties: `hoverbike_helper_t` (0..1),
`hoverbike_helper_offset` (-200..+200 m, perpendicular to the
tangent; positive = right).

Sliders re-pose live via the addon's debounce timer — scrubbing is
interactive, not click-to-apply.

### Road tool

Bezier curve → drivable road slab with terrain conform + F1 curbs.

| Operator | What it does |
|---|---|
| **Add Road Curve** | Drops `road_curve_main`, a 4-point Bezier near the scene origin. Tab into edit mode to shape it. |
| **Build Road** | Samples the curve, conforms the terrain to its altitude in a `width/2 + curb_width + blend_radius` band, emits the road mesh tagged `kind=track`. |

Scene properties:

| Property | Default | Notes |
|---|---|---|
| `hoverbike_road_width` | 8 m | Total road surface width. |
| `hoverbike_road_lift` | 0.15 m | Z offset so the road reads above terrain. |
| `hoverbike_road_thickness` | 0.6 m | Extrusion depth. 0 = paper-thin ribbon; any positive value gives a volumetric slab. |
| `hoverbike_road_blend_radius` | 6 m | Outer falloff band; terrain smoothsteps back to natural beyond. |
| `hoverbike_road_samples` | 64 | Arc-length sample count. |
| `hoverbike_road_smooth_passes` | 4 | 1-2-1 binomial smoothing on the height profile. |
| `hoverbike_road_bank_strength` | 0.6 | Multiplier on curvature-driven auto-bank. 0 disables. |
| `hoverbike_road_bank_max_deg` | 25° | Hard cap on signed bank angle. |
| `hoverbike_road_curb_width` | 0.6 m | F1 curb width. 0 disables curbs. |
| `hoverbike_road_curb_height` | 0.12 m | Curb rise. |
| `hoverbike_road_curb_stripe_length` | 2 m | Length of each red / white stripe. |

Per-control-point banking: edit a Bezier point's **Tilt** in the
N-panel → Curve → Tilt; that value adds on top of the auto-bank.

Materials emitted: `mat_track_road` (asphalt), `mat_track_curb_white`,
`mat_track_curb_red`, `mat_track_road_underside`.

::: warning Active terrain modifiers
If the terrain has active modifiers (e.g. `HV_Island` GN graph),
the operator errors out — GN displacement stacks on top of the
road's vertex edits and spikes the terrain. Toggle **Apply
modifiers first** in the Build Road redo panel to bake the
modifier in. One-way; save first.
:::

### Tunnels

Bezier curve → boolean cut through any terrain mesh + a concrete
liner interior shell.

| Operator | What it does |
|---|---|
| **Add Tunnel Starter Curve** | Drops `tunnel_curve_main` near the scene origin. |
| **Build Tunnel** | Samples the curve, emits a closed-manifold cutter cylinder + an inward-facing interior shell, ensures the terrain has a Boolean DIFFERENCE modifier targeting the cutters collection. |

Scene properties:

| Property | Default | Notes |
|---|---|---|
| `hoverbike_tunnel_radius` | 8 m | Interior radius. 16 m diameter is arcade-sized. |
| `hoverbike_tunnel_wall_thickness` | 1 m | Extra radius on the cutter beyond the interior — the apparent concrete thickness at the mouth. |
| `hoverbike_tunnel_samples` | 32 | Arc-length subdivisions of the curve. |
| `hoverbike_tunnel_segments` | 14 | Radial segments per ring. |
| `hoverbike_tunnel_end_extend` | 4 m | Distance the cutter pushes past the curve endpoints. Ensures the cap clears the hillside surface. |

The terrain carries a single Boolean DIFFERENCE modifier named
`HV_Tunnel_Cut` whose operand is the `_hoverbike_tunnel_cutters`
collection (hidden in viewport + render). A second tunnel just
drops another cutter in — the existing modifier picks it up.
`export_apply=True` on the GLB exporter bakes the cut.

Re-builds pick the next free `tunnel_NN` slot. To author multiple
tunnels, rename `tunnel_curve_main` between builds.

::: tip Canonical reference: `tracks-src/template-tunnels.blend`
A hand-curve-driven seed file with three mountains, one tunnel
through each, and an AI-completable racing line threading them all.
The seed script is `tools/blender/seed_template_tunnels.py`. The
addon's tunnel tool is now marked deprecated — the seed file is the
canonical implementation.
:::

### Ramps

Drop a parametric stunt-ramp wedge at the 3D cursor.

| Operator | What it does |
|---|---|
| **Add Ramp** | Drops a `ramp_NN` empty + child mesh at the 3D cursor, tagged `kind=track` with `mat_track_ramp`. |

Scene properties: `hoverbike_ramp_length`, `hoverbike_ramp_width`,
`hoverbike_ramp_height` — used at placement time.

The mesh is driven by a Geometry Nodes modifier (`HV_Ramp`); to
resize an existing ramp, open its modifier and edit Length / Width
/ Height live. The wedge has a 30 cm foundation depth so it's
always a closed solid (no degenerate top/bottom coplanar quads).

### Terrain

Heightmap import, sculpt entry, raise / lower / smooth, AO + path
bakes.

| Operator | What it does |
|---|---|
| **Import Heightmap** | Reads a greyscale PNG/EXR and emits `terrain_heightmap`, a subdivided plane whose verts are luminance-displaced. Tagged `kind=track`. Re-import is idempotent. |
| **Apply Terrain Modifiers** | Bakes every viewport-enabled modifier on the terrain into vertex data. One-way: parametric tunability of GN sliders is lost. Save first. |
| **Subdivide Terrain** | One cut per click (each face → 4) when the procedural mesh is too coarse. |
| **Sculpt Terrain** | Selects the terrain and enters Sculpt Mode. Standard Blender brushes apply once the modifier stack is empty. |
| **Raise / Lower @ cursor** | Bulk-shape with a smoothstep falloff from the 3D cursor. Faster than brushes for large hills. |
| **Smooth Terrain** | Laplacian-Z pass over every vertex. XY positions stay locked so the heightfield stays a heightfield. |
| **Bake Terrain Attrs** | Cycles vertex-colour bake + KDTree path-wear pass. Fills `baked_ao` (G channel) and `baked_path` (B channel) into the active vertex-colour layer. |

Scene properties: `hoverbike_heightmap_size`,
`hoverbike_heightmap_subdivisions`, `hoverbike_heightmap_height`,
`hoverbike_heightmap_base`, `hoverbike_heightmap_path`,
`hoverbike_sculpt_radius`, `hoverbike_sculpt_magnitude`,
`hoverbike_sculpt_smooth_iters`, `hoverbike_sculpt_smooth_weight`.

### Water

Sea level + Gerstner wave preview.

| Operator | What it does |
|---|---|
| **Add Water Volume** | Creates `water_volume_main` (cube empty) with `kind=water`, `wave_height=0.6`, `wave_freq=0.5` extras. Spawns the wave preview plane. |
| **Rebuild Water Preview** | Rebuilds the wave-displaced preview plane around the volume. |
| **Hide Water Preview** | Toggles the preview collection's visibility off without deleting. |

Scene properties: `hoverbike_water_height` (proxies `water_volume_main.location.z`),
`hoverbike_water_size`, `hoverbike_water_subdivisions`,
`hoverbike_water_time`.

The volume's Z position is the in-game sea level — round-trips
through `water.height` in the JSON on export.

### Downtown

Procedural city block at the 3D cursor.

| Operator | What it does |
|---|---|
| **Add Downtown** | Spawns a `downtown_NN` parent empty + a flat plinth + a grid of placeholder building boxes, all tagged `kind=track`. |

Scene properties:

| Property | Default | Notes |
|---|---|---|
| `hoverbike_downtown_blocks_x` / `_y` | 6 / 6 | Block grid extent. |
| `hoverbike_downtown_block_size` | 30 m | Block edge length. |
| `hoverbike_downtown_street_width` | 8 m | Inter-block gap. |
| `hoverbike_downtown_height_min` / `_max` | 18 / 80 m | Per-building height range. |
| `hoverbike_downtown_seed` | random | Deterministic layout seed. |
| `hoverbike_downtown_conform` | on | Conform the plinth to terrain (off = single flat quad, all buildings at z=0). |

Each building's four footprint corners raycast onto the largest
visible `kind="track"` mesh. The base seats at the highest corner;
a downhill skirt extends below z=0 to bury the low side in the
slope. Result: SF-style "buildings step into the hill" look, no
floating stilts.

Materials: `mat_track_downtown_sidewalk` (light concrete) under
building lots, `mat_track_downtown_road` (dark asphalt) on
inter-block strips. Single mesh per block, per-face material
indices, no z-fight.

Reference scene: `tracks-src/template-downtown.blend`.

### Gameplay

Gates, boost pads, racer preview, turn indicators.

| Operator | What it does |
|---|---|
| **Rebuild Gate Preview** | Instances the real `prop_gate_mesh` (linked from `tracks-src/props-library.blend`) every `gateSpacing` metres along `ai_spline_main`. Falls back to a wireframe rectangle if the library is missing. |
| **Hide Gate Preview** | Toggles the gate preview off without deleting. |
| **Add Boost Pad** | Drops a `boost_NN` empty at the 3D cursor. The empty's local +Y axis is the boost direction. |
| **Refresh Boost Pads** | Rebuilds the cyan-emissive slab gizmos under every `boost_NN` empty. |
| **Rebuild Racer Preview** | Drops a bike silhouette at `start_00` plus one per AI slot from `specs/grid-offsets.json`. |
| **Hide Racer Preview** | Toggles the racer preview off. |
| **Rebuild Turn Indicators** | Drops chevron gizmos at every curvature peak above `\|κ\|`. |
| **Hide Turn Indicators** | Toggles the indicators off. |

Scene properties: `hoverbike_gate_spacing`, `hoverbike_gate_half_width`,
`hoverbike_gate_height`, `hoverbike_turn_kappa`,
`hoverbike_turn_min_spacing`.

Boost pad custom properties (defaults match the in-app editor):

| Property | Default | Notes |
|---|---|---|
| `half_width` | 3 m | Extent across the pad. |
| `half_depth` | 6 m | Extent along the boost direction. |
| `strength` | 1.5 | Top-speed multiplier on overlap. |

Gate / racer / turn previews live in render-disabled
`_hoverbike_*_preview` collections; they never reach the GLB.

### Ghost lap + chase cam

| Operator | What it does |
|---|---|
| **Rebuild Ghost Lap** | Binds a bike silhouette to `ai_spline_main` via Follow Path. Attaches a chase camera with Track-To. Sets the scene's frame range to one full lap at **Speed (m/s)**. |
| **Hide Ghost Lap** | Toggles the ghost-lap preview off. |

Scene properties: `hoverbike_ghost_speed`, `hoverbike_ghost_fps`.

After **Rebuild Ghost Lap**, hit `Spacebar` in the viewport to play
back — the chase cam becomes the scene's active camera so
view-from-camera frames the bike.

### Terrain shader (runtime)

Tunes the runtime terrain shader's ramp / slope / wet-band /
coloration knobs. These mirror constants in
`src/engine/render/terrain-shader.ts` and round-trip through
`terrainShader` in the track JSON.

Scene properties (all `hoverbike_shader_*`):

| Property | Range | Notes |
|---|---|---|
| `alt_min` / `alt_max` | -500..500 m | World-Y mapped to ramp 0 / 1. |
| `slope_start` / `slope_end` | 0..1 (cos θ) | Below `slope_start` reads as flat; above `slope_end` reads as cliff. 0.85 ≈ 30°; 0.55 ≈ 55°. |
| `variation` | 0..1 | ±brightness perturbation from per-vertex noise. |
| `wet_band` | 0..20 m | Half-height of the \|y\|-mask around the waterline. |
| `path_tint_r/g/b` | 0..2 each | Tint multiplied through the path-worn vertex channel. |
| `warp_strength` | 0..4 | Low-freq noise that warps the colour-noise UVs. |
| `macro_scale` / `micro_scale` | 10..1000 / 0.5..40 m | World-space scales for macro / micro detail. |
| `alt_jitter` | 0..30 m | Vertical jitter so contour lines aren't perfectly level. |
| `scree_band` | 0..1 | Width of the intermediate gravel band between flat and cliff. |
| `saturation` | 0..2 | Output saturation multiplier. |
| `triplanar` | 0..1 | Blend factor between top-down and triplanar sampling on cliffs. |

Default-closed sub-panel — usually set once per track.

### Track stats

Read-only counts + spline length + lap-time estimate + terrain
extents + water coverage.

| Operator | What it does |
|---|---|
| **Refresh Terrain Stats** | Evaluates the terrain mesh and stashes min/max y + water-coverage fraction on scene custom properties. |

Cheap counts (gates, starts, pickups, boosts) recompute on every
redraw. The terrain heavy lift is gated behind the button so the
panel stays responsive.

---

## Track-mode header operators

These live above the sub-panels (always visible in track mode):

| Operator | What it does |
|---|---|
| **Export Track to Game** | Validates the scene, writes `public/assets/tracks/<id>.glb`, merges the Blender-owned fields into `public/tracks/<id>.json` (preserving editor-owned fields), and upserts the manifest entry. |
| **Lint Track** | Pre-export sanity check — walks the spline, start, and terrain. Reports errors + warnings without modifying anything. |
| **Reload from JSON** | Pulls scalar fields from `public/tracks/<id>.json` back into the scene custom properties (gate spacing, terrain shader, water, start pose). |
| **Open in Browser → Play** | Opens `http://localhost:5191/?track=<id>`. |
| **Open in Browser → Edit** | Opens `?track=<id>&edit=1` (in-app editor). |
| **Copy Play URL** | Copies the Play URL to the clipboard. |
| **Copy Edit URL** | Copies the Edit URL. |

### Export Track to Game

The export merges with the existing JSON instead of overwriting,
so in-app editor saves survive Blender re-exports. The contract:

| Field | Who owns it |
|---|---|
| `environmentGlb` | Blender (always) — points at the just-written .glb |
| `water` | Blender — `wave_height` / `wave_freq` from `water_volume_main` extras, height from its Z |
| `terrainShader` | Blender — the `hoverbike_shader_*` scene props |
| `aiSplines` | Blender — baked from `ai_spline_main` (and `ai_spline_alt_*` if present) |
| `gateSpacing` | Blender — `hoverbike_gate_spacing` |
| `start` | Blender — `start_00`'s transform |
| `checkpoints` | Blender if the .blend has `cp_NN` empties; editor otherwise |
| `pickups` | Blender if the .blend has `pickup_*` empties; editor otherwise |
| `boostPads` | Blender if the .blend has `boost_NN` empties; editor otherwise |
| Anything else (props, sky, etc.) | Editor — preserved through Blender exports |

Pre-export the addon also bakes any NURBS / Bezier curves to flat
point arrays in `extras` (glTF doesn't carry curves natively), so
the runtime loader sees the racing line as a polyline.

---

## Bike-mode operators

| Operator | What it does |
|---|---|
| **Export Bike to Game** | Validates the bike scene, writes `public/assets/bikes/<id>.glb`. On first export materialises a starter `specs/bikes/<id>.json` from `bike_root` extras + authored materials. Shift-click to force-rewrite the spec. |
| **Copy Play URL** | Copies `http://localhost:5191/?bike=<id>`. |
| **Copy Viewer URL** | Copies `http://localhost:5191/?viewer=<id>` — the stand-alone bike viewer (turntable, sockets, collider gizmos). |

Subsequent exports preserve `specs/bikes/<id>.json` so JSON-side
tuning isn't blown away by a re-export. Shift-click **Export Bike
to Game** to overwrite.

For everything bike-specific, see [Modding → Authoring bikes](/modding/bikes).

---

## Live previews and auto-rebuild

The addon registers a persistent `depsgraph_update_post` handler
that watches `ai_spline_main`, `start_00`, and `water_volume_main`.
Edits to any of them schedule a debounced (~200 ms) rebuild of the
matching preview collections.

The `update=` callbacks on the spacing / curb / wave-time scene
props go through the same scheduler, so scrub interactions update
live without manual rebuilds.

Preview collections (`_hoverbike_gate_preview`,
`_hoverbike_racer_preview`, `_hoverbike_water_preview`,
`_hoverbike_turn_preview`, `_hoverbike_boost_pad_preview`,
`_hoverbike_ghost_lap_preview`, `_hoverbike_tunnel_cutters`) are
hidden from render and scrubbed at export — they never ship in the
GLB.

The `load_post` handler auto-runs **Reload from JSON** when you
open a track `.blend`, so the editor-saves-then-reopen-in-Blender
loop is seamless.

---

## Headless builders

Three Python scripts run via `blender --background` produce GLBs
without opening Blender's GUI. They share the validation / extras
code with the addon (`hoverbike_addon/_legacy.py`), so what passes
the addon's lint passes the headless builder.

### `build_bike.py`

```bash
HOVERBIKE_SPEC=specs/bikes/scout.json \
HOVERBIKE_OUTPUT=public/assets/bikes/scout.glb \
  "$BLENDER_EXE" --background --python tools/blender/build_bike.py
```

Opens `bikes-src/<id>.blend` (the variant's standalone scene),
applies any `appearance` recolour + `physics` extras from the
spec, validates the scene, exports. The script ignores the spec's
`geometry` and `rider` blocks (legacy fields).

Driven by `pnpm gen:bikes` for all bikes.

### `build_track.py`

```bash
HOVERBIKE_SPEC=specs/tracks/calibration.json \
HOVERBIKE_OUTPUT=public/assets/tracks/calibration.glb \
  "$BLENDER_EXE" --background --python tools/blender/build_track.py
```

For **spec-driven** tracks. Reads the JSON spec, constructs the
scene programmatically (drivable slab, water volume, checkpoints,
AI spline, starts, pickups), saves a `.blend` to
`tracks-src/<id>.blend` for follow-up authoring, then invokes the
exporter for the GLB.

Use `HOVERBIKE_SKIP_BLEND_SAVE=1` for GLB-only mode (CI), or
`HOVERBIKE_BLEND=/some/other/path.blend` to override the `.blend`
save path.

Driven by `pnpm gen:tracks` for all spec-driven tracks. **Editor-driven
tracks** (everything authored in `.blend`s by hand) bypass this
script entirely — the addon's Export Track to Game writes the GLB
directly.

### `build_prop.py`

```bash
HOVERBIKE_SPEC=specs/props/palm.json \
HOVERBIKE_OUTPUT=public/assets/props/palm.glb \
  "$BLENDER_EXE" --background --python tools/blender/build_prop.py
```

Assembles a prop GLB from `tools/blender/lib/prop_kit.blend`'s
kit parts per the spec — scale, tint, primitive collider.

Driven by `pnpm gen:props`.

### `run.mjs` — Node wrapper

```bash
node tools/blender/run.mjs build_track specs/tracks
```

Cross-platform wrapper. Discovers specs in the directory,
ajv-validates each against `specs/_schema/<category>.json`, spawns
Blender once per spec with the right env vars, then writes
`public/assets/manifest.json` with every category re-merged.

The `pnpm gen:bikes` / `gen:props` / `gen:tracks` scripts call
this with the appropriate builder + dir. `pnpm gen:all` runs all
three sequentially.

### `inspect_glb.mjs` — quick GLB inspection

```bash
node -e 'import("./tools/blender/inspect_glb.mjs").then((m) =>
  m.inspect("public/assets/tracks/test-ring.glb"))'
```

Prints the GLB's `extensionsUsed`, node count, kind distribution,
and a few sanity checks. Useful when something's missing from the
runtime — confirm the GLB actually has what you expect.

---

## Seed scripts

One-shot Python scripts that materialise canonical `.blend` files
from code. Run with:

```bash
"$BLENDER_EXE" --background --python tools/blender/seed_<name>.py
```

| Script | Produces | Purpose |
|---|---|---|
| `seed_template_island.py` | `tracks-src/template-island.blend` | Procedural island reference scene with the `HV_Island` GN graph. |
| `seed_template_alpine.py` | `tracks-src/template-alpine.blend` | Alpine peaks template. |
| `seed_template_dunes.py` | `tracks-src/template-dunes.blend` | Dunes template. |
| `seed_template_mesa.py` | `tracks-src/template-mesa.blend` | Mesa / canyon template. |
| `seed_template_downtown.py` | `tracks-src/template-downtown.blend` | Procedural downtown reference scene with multiple terrain grades. |
| `seed_template_tunnels.py` | `tracks-src/template-tunnels.blend` | Three mountains, one hand-authored tunnel through each, AI spline threading all three. |
| `seed_template_tunnel_island.py` | `tracks-src/template-tunnel-island.blend` | Older tunnel-through-island reference. |
| `seed_track_alpine_sprint.py` / `_canyon_run.py` / `_dune_rally.py` | `tracks-src/<id>.blend` | Specific seeded tracks from the alpine / mesa / dunes templates. |
| `seed_props_library.py` | `tracks-src/props-library.blend` | The shared prop library — `prop_gate_mesh`, etc. Linked (not appended) from track `.blend`s, so re-running this re-flows every track. |
| `seed_prop_kit.py` | `tools/blender/lib/prop_kit.blend` | Placeholder kit parts for `build_prop.py`. |
| `seed_bike_kit.py` | (legacy) `tools/blender/lib/bike_parts.blend` | Pre-M9.38 bike kit — no longer wired up; bikes are now standalone `.blend`s. |

Seed scripts are committed source-art generators: their outputs
are `.blend` files that **do** get committed (for tracks /
libraries that humans then hand-edit). Re-running a seed
overwrites the file, so use them as starting points, not
roundtrip-tools.

---

## Validation rules

Both the addon's pre-export check and the headless builders run
the same validator. It rejects the export if:

- An object whose name matches a recognised pattern (`cp_NN`,
  `pickup_*`, `start_NN`, `boost_NN`, `water_volume_*`,
  `ai_spline_*`) doesn't have a `kind` extra, or its `kind`
  disagrees with the name.
- Checkpoints aren't contiguous from 0 (`cp_00`, `cp_02` with no
  `cp_01`).
- A checkpoint is missing `half_width` or `height`.
- There's no `ai_spline_main`, or its baked points array is empty.
- A bike `.blend` is missing any of the five required sockets
  (`socket_seat`, `socket_nose_cam`, `socket_fx_thruster_l`,
  `socket_fx_thruster_r`, `socket_fx_exhaust`), or has no
  collider empty.

For the full naming + kinds matrix see [Scene conventions](./scene-conventions).

---

## Troubleshooting

**Sidebar panel disappeared / operator missing.** The installed
addon has drifted from the repo. Re-run `pnpm install:blender-addon`
and `F3 → Reload Scripts` in Blender.

**`pnpm test:blender` fails with "could not locate Blender".**
Set `BLENDER_EXE` to the absolute path of the Blender 5.1
executable. The smoke test, headless builders, and `pnpm gen:*`
all use the same env var.

**Active modifiers blocking the road tool.** Toggle **Apply
modifiers first** in the Build Road redo panel — the procedural
GN graph (e.g. `HV_Island`) gets baked into vertex data so the
road's flatten isn't overridden. One-way; save first.

**Spline auto-snap drags a point onto the seafloor.** The snapper
clamps to whichever is higher: terrain Z or water surface Z. If
your `water_volume_main` is below the seafloor at that x/y, no
clamp applies. Lift the water volume or accept that point will
sit on the seabed.

**Track exports cleanly but renders sideways.** The Blender → glTF
Y-up conversion swaps axes. The builders compensate by authoring
with the bike's nose at Blender +Y / `start_00`'s +Y forward, so
they land at three.js +Z. If you've custom-rotated objects after
adding them, double-check via the bike viewer (`?viewer=<id>`).

**Lint warns about "spline points below water surface".** Re-run
**Snap Spline to Terrain** with a hover height that lifts above
the water plane, or lift the racing line manually. Lint clamps
the threshold at `water_z - 0.5 m` so a few cm below is fine.

**Boost pad gizmo doesn't update when I rotate the pad.** Trigger
the depsgraph by clicking elsewhere then back, or click **Refresh
Boost Pads** in the Gameplay sub-panel.

For more — and the underlying object kinds reference — see
[Scene conventions](./scene-conventions).
