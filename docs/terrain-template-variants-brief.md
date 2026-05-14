# Brief — Terrain template variants & maps

> Prompt for a fresh Claude session. Paste from "Goal" onward.

---

## Goal

Add **three to five new terrain templates** to the Hoverbike track pipeline,
then build at least one finished, playable race track on each. The existing
template (`tracks-src/template-island.blend`) is a single tropical-island
biome — every map looks like a variation of the same island. We want
visually distinct biomes so the level-select carousel doesn't read as a
single track in six skins.

The hoverbike rides water natively, so biomes that put more water in play
(archipelagos, fjords, river canyons) are interesting; biomes that put more
land in play (mesa, alpine, desert dunes, lava plains) are also interesting.
You have wide discretion on what to ship.

## Hard constraints

1. **Each template ships as a deterministic seed script.** Pattern:
   `tools/blender/seed_template_<name>.py`. Re-running the script produces
   the same `.blend`. The existing tropical-island seed is the reference
   (~1300 lines): [`tools/blender/seed_template_island.py`](../tools/blender/seed_template_island.py).
2. **Each template uses Geometry Nodes for terrain**, not hand-sculpted
   meshes. This keeps authoring tunable post-seed. The HV_Island graph
   is the prior art — you can copy/adapt its `_add_node` / `_new_socket`
   helpers or write your own.
3. **Each template must produce a working track when run through the
   Hoverbike addon's pipeline:** road build → spline snap → ramps →
   lint → export. The lint must come back clean (or warnings-only).
   See [`docs/blender-pipeline-guide.md`](./blender-pipeline-guide.md)
   for the authoring loop.
4. **Each track must measure at least 256 × 256 m.** The terrain grids
   themselves are 1024 × 1024 m (matching the tropical-island template);
   that's fine but the racing surface needs to use the central area.
5. **No new track may break the existing two** (`oval-loop`,
   `figure-eight`) or the legacy reference tracks (`template-island`,
   `calibration`, `test-ring`).

## Suggested biomes (pick at least three)

| Biome | Terrain feel | Water role | Hook |
|---|---|---|---|
| **Desert dunes** | Rolling sand drifts, low overall altitude, sparse rock outcrops | Optional oasis pools | Soft bumps make the bike skip; long visual sight lines |
| **Alpine valley** | Steep parallel ridges, narrow valley floor between them, snow caps | River along the valley floor | Tight corridor racing with vertical walls |
| **Archipelago** | Many small islands with shallow channels between them | Half the map is water | Multi-island figure-8s that cross open water; hover wave riding |
| **Mesa / canyon** | Flat tops at three altitudes (low, mid, high) with steep cliff drops between | Optional river at the bottom | Cliff drops + jumps; cliffside.ts gameplay vibe scaled up |
| **Lava plains** | Mostly flat dark rock, sparse jagged spires, glow patches | "Water" is lava — same physics, different shader | Different colour palette, hot-and-cold contrast |
| **Glacial fjord** | Long parallel inlets, ice cliffs at the edges | Cold-grey water filling the inlets | Linear racing with cliff-flanked straights |
| **Urban platforms** | Geometric stepped blocks of different heights, "rooftops" as racing surfaces | "Water" between buildings as the void below | F-Zero / Tron vibe; ramps between blocks |

Mix and match. Aim for biomes that look obviously different from above
*and* drive differently. Avoid biomes that are "tropical island with
different colours" — change the silhouette, the water:land ratio, and
the racing-line constraint pattern.

## What "good" looks like

For each biome you ship:

- **`tools/blender/seed_template_<biome>.py`** — deterministic seeder.
  Builds the GN graph + scene from scratch, writes
  `tracks-src/template-<biome>.blend`, attaches a configured material,
  and prints a one-line summary. Headless-runnable:
  `blender --background --python tools/blender/seed_template_<biome>.py`.
- **`tracks-src/template-<biome>.blend`** — the seed's output. The
  `.blend` is the source of truth after the first seed; re-running the
  seed nukes hand-edits.
- **`tracks-src/<track-name>.blend`** — at least one race track sitting
  on top of the template. Pick a track shape that fits the biome
  (linear sprint for fjords, multi-loop for archipelago, mesa
  hairpins for canyons). The shape should be authored with the addon's
  road tool, not hand-modelled.
- **`public/assets/tracks/<track-name>.glb`** + **`public/tracks/<track-name>.json`**
  — exported via the addon's *Export Track to Game*. Manifest is
  upserted automatically.
- The track must appear in the level-select carousel
  (`START → SINGLE-PLAYER → SELECT TRACK`) and load without errors.

## Recipe for one biome

End-to-end, you should be doing roughly this for each biome:

1. **Plan the terrain.** Sketch the silhouette in 2D — where's the
   water, where's the land, what's the altitude band? The
   tropical-island template uses ±150 m altitude range; a desert might
   compress to ±20 m, a canyon might span ±80 m.
2. **Write the seeder.** Pattern after `seed_template_island.py`. Keep
   the same outer shape:
   - `reset_scene()` — clear the default scene
   - `build_terrain_mesh()` — a subdivided plane, 1024 m × 1024 m, ~384²
     verts. (Don't change the size — the addon's road tool, water
     preview, etc. assume this scale.)
   - `build_<biome>_group()` — your GN graph
   - `attach_modifier()` — bind the graph to the terrain
   - `bind_<biome>_inputs()` — wire scene parameters into the modifier
   - `add_<biome>_features()` — peak empties, river curves, etc.
   - `add_water_volume()` — `water_volume_main` empty at the chosen
     sea level (Z-up; `water.location.z` becomes `water.height` in JSON)
   - `add_ai_spline()` — a starter `ai_spline_main` NURBS (16+ points,
     cyclic) tracing a sensible racing line
   - `add_player_starts()` — `start_00`, `start_01`
   - `add_checkpoints()` — `cp_00`..`cp_03` empties (the in-app editor's
     auto-place will refine these)
   - `add_sun()` — sun light
   - `build_<biome>_material()` — terrain material with COLOR_0 reading
     per [docs/vertex-attribute-spec.md](./vertex-attribute-spec.md)
   - `organize_collections()` — group objects into named collections
   - `bpy.ops.wm.save_as_mainfile(filepath=...)` — emit
     `tracks-src/template-<biome>.blend`
3. **Run the seed headlessly.** Then open the result in Blender via
   the MCP to inspect.
4. **Author a track on top.** Save-as a new `.blend`. Reshape
   `ai_spline_main` to the racing line you want. If the biome needs
   peaks repositioned to match the racing line, do that. Use the
   addon's *Snap Spline to Terrain* (water-aware as of 2026-05-13),
   *Add Road Curve* + *Build Road* (with curbs), *Auto-place Ramps*
   (or hand-place via *Add Ramp at t*), then *Lint Track*.
5. **Export** via the addon. The GLB + JSON + manifest entry are all
   written in one click.
6. **Verify in browser.** Start the dev server (`pnpm dev`),
   navigate to `?track=<your-id>` or pick it from the level select.
   The hoverbike should spawn, race the line, and complete a lap.

## Tools you'll be using

You have full access to:
- **Read / Edit / Write** on any file in the repo.
- **Bash** for running `blender --background`, `pnpm typecheck`, `git`.
- **Blender MCP** (`mcp__Blender__*` tools) for interactive Blender
  sessions. Use this to verify each seed and to do the actual track
  authoring. The MCP can load files, run Python in the active Blender,
  take viewport screenshots.
- **Claude Preview MCP** (`mcp__Claude_Preview__*`) for the browser
  preview — start the dev server, drive the page, capture state.

Useful Blender API discovery: `mcp__Blender__get_python_api_docs` and
`mcp__Blender__search_api_docs` are your friends for finding
unfamiliar `bpy` calls.

## Reference reading (start here)

The addon and the existing seed are the most important. Read in this
order:

1. **[`docs/blender-pipeline-guide.md`](./blender-pipeline-guide.md)** —
   end-to-end track-authoring flow. The "Authoring tools" section
   walks through every operator the addon surfaces.
2. **[`tools/blender/seed_template_island.py`](../tools/blender/seed_template_island.py)** —
   the only existing template seed. Copy/adapt its structure.
3. **[`tools/blender/hoverbike_addon.py`](../tools/blender/hoverbike_addon.py)** —
   the addon. You don't need to modify it; you need to know what its
   operators do. Key functions:
   - `_resolve_road_curve()` / `_sample_road_path()` / `_build_road_strip_mesh()` / `_conform_terrain_to_road()` — road tool internals.
   - `_snap_spline_to_terrain()` — water-aware spline snap (clamps to `water_volume_main.location.z` when terrain is underwater).
   - `_sample_curve_at_t()` / `HOVERBIKE_OT_cursor_snap_to_spline` /
     `HOVERBIKE_OT_add_ramp_at_spline_t` / `HOVERBIKE_OT_auto_place_ramps` — placement helpers.
   - `_lint_track()` — pre-export sanity checks.
   - `derive_track_json()` / `reload_track_from_json()` / `_upsert_manifest_track()` — JSON ↔ .blend round-trip + manifest upsert.
4. **[`docs/blender-wishlist.md`](./blender-wishlist.md)** — has the
   "Post-track-build assessment" section. Don't redo work that's
   already shipped, but the section explains what was painful and how
   the tools evolved. Read it for context, not as a TODO list.
5. **[`docs/vertex-attribute-spec.md`](./vertex-attribute-spec.md)** —
   the COLOR_0 contract. Foliage uses R for sway, G for AO, B for
   phase, A for free; terrain reuses with B = path-worn, A = biome.
   Your terrain shaders need to stamp the right attribute or the
   runtime sway / AO won't work.

## File layout reminder

```
hoverbike/
├── tools/blender/
│   ├── hoverbike_addon.py          ← the addon (don't modify for this task)
│   ├── seed_template_island.py     ← reference seed
│   ├── seed_template_<biome>.py    ← new — one per biome you ship
│   └── run.mjs                     ← the gen:* pipeline (you'll only run, not edit)
├── tracks-src/
│   ├── template-island.blend       ← existing template
│   ├── template-<biome>.blend      ← new — one per biome
│   ├── <track-name>.blend          ← new — one track per biome at minimum
│   ├── oval-loop.blend             ← keep working
│   └── figure-eight.blend          ← keep working
├── public/tracks/                  ← JSON per track (addon writes these)
├── public/assets/tracks/           ← GLB per track (addon writes these)
└── public/assets/manifest.json     ← addon upserts each track's entry
```

## Things that will trip you up if you don't watch for them

- **Apply the modifier before building the road.** The road tool
  refuses to conform a terrain with active modifiers (GN would stack
  its displacement on top of the road's vertex edits). The operator
  has an *Apply modifiers first* toggle (`apply_modifiers=True` in
  Python). Once you apply, you lose parametric tunability of the GN
  graph — author the seed knobs the way you want first.
- **The road tool reads `road_curve_main` if present, otherwise falls
  back to `ai_spline_main`.** Author one curve unless you genuinely
  need two different shapes.
- **`derive_track_json` writes from the .blend on every export and
  merges into the existing JSON.** Hand-tuned gates and props in the
  in-app editor's saved JSON survive your Blender exports; the
  Blender-owned fields (`gateSpacing`, `lapsToFinish`, `water`,
  `terrainShader`, `aiSplines`, `start`, `environmentGlb`) get
  overwritten from the .blend.
- **The terrain mesh must have `kind = "track"` custom property** or
  the runtime won't register it as collidable. The seeded terrain
  in `seed_template_island.py` sets this — make sure yours does too.
- **Water height comes from `water_volume_main.location.z`.** Don't
  hardcode `water.height = 0` in the JSON; let the export pull from
  the empty.
- **HMR can confuse browser verification.** If the loading screen
  stays stuck, hard-refresh (the addon's *Open in Browser* button gives
  a fresh URL each click).

## Definition of done

For each biome:

- [ ] Seed script runs headlessly and produces the .blend deterministically.
- [ ] `template-<biome>.blend` opens in Blender, has the expected
      terrain silhouette, water at the chosen level, peaks/features in
      sensible positions.
- [ ] At least one track on top of the template ships GLB + JSON +
      manifest entry, lints clean.
- [ ] Track loads at `?track=<id>`, the bike spawns, the player can
      complete a lap.

For the work overall:

- [ ] At least three biomes shipped.
- [ ] Each biome looks obviously different from above (post a
      top-down screenshot of each in your final report).
- [ ] One commit per biome (or one big commit at the end with the
      lot — your call). Conventional-commit style.
- [ ] Brief writeup in your final response covering: which biomes
      you shipped, which you rejected and why, anything the pipeline
      still doesn't support that you needed.

## What to skip

- Don't modify the addon (`hoverbike_addon.py`) unless something is
  genuinely broken for your use case. If you find a real bug or
  missing capability, flag it in your final writeup rather than
  patching it yourself.
- Don't try to ship visual polish (PBR rock textures, photogrammetric
  cliff materials, palm-leaf textures). The seed-level placeholder
  materials are fine for this pass; aesthetic polish is a separate
  follow-up.
- Don't break the existing tracks. Re-run them in the browser as a
  smoke test after your changes.

Good hunting. If the path forward is unclear at any point, prefer
shipping fewer biomes that work end-to-end over more biomes that
half-work.
