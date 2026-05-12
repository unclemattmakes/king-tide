# Blender automation wishlist

Captured from a conversation on 2026-05-11, the day the Blender MCP connector
went live in Matt's setup. This file enumerates the things Matt wants Claude to
help build *on top of* the connector, and Claude's realism assessment of each.

The connector itself is documented in the top-level
[CLAUDE.md](../CLAUDE.md#blender-connector--installed-and-ready). The existing
pipeline it builds on is in [blender-pipeline-guide.md](./blender-pipeline-guide.md)
and [blender-conventions.md](./blender-conventions.md).


## Shipped so far

- **Template-island polish + preview-export scrub (2026-05-11).** Four
  small follow-ups on top of Item 1:
  - **Billowy ocean floor.** New `Seafloor Billow` (default 10 m)
    + `Billow Scale` (0.004) sockets on `HV_TemplateIsland`. A
    distorted FBM noise gated by a smoothstep mask (full at
    z=-8 m, zero at z=-1 m) carves the sub-shelf floor into ridged
    silt rather than a flat plateau. Live-verified on
    `tracks-src/template-island.blend`: underwater verts span
    roughly z∈[-55, -10] m with σ≈10 m of relief, while the
    shoreline mask keeps billows from poking through the waterline.
  - **Slope-aware terrain shader.** `mat_terrain_main` rebuilt to
    mix a *flat* altitude ramp (deep blue → blue-sand → bright
    sand → wet beach → grass → forest → alpine stone → volcanic top)
    against a *cliff* ramp (dark abyssal rock → wet rock → sea cliff
    → grey rock → warmer rock → volcanic), blended by the surface
    normal's tilt (smoothstep from cos 30° to cos 55°). A
    low-frequency variation noise drives `BrightContrast` for
    ±0.10 unbanding without ColorRamp clamping, and a triangular
    |z|-mask around the waterline tints damp sand / wet rock. Eevee
    preview now reads as volcanic tropical island rather than a flat
    vertex-colour ramp.
  - **Preview collections excluded from export.** New
    `_PreviewCollectionsHidden` context manager scrubs every
    `_hoverbike_*_preview` layer-collection during glTF export in
    both the addon's *Export Track to Game* and the headless
    `tools/export_track.py`. The wave-displaced water plane, gate
    gizmos, racer silhouettes, and turn indicators are now
    guaranteed not to ride into `<id>.glb` even with the addon's
    visibility toggles flipped on.
  - **Gate-preview button regression fix.** `HOVERBIKE_PT_panel`'s
    `_draw_track` / `_draw_bike` / `_draw_unknown` were referencing
    `context.scene.*` without `context` in scope — a NameError
    aborted panel draw partway through, leaving the Gate Preview
    box visible without its spacing knob or Rebuild/Hide buttons
    (the "dark grey thing" Matt couldn't click). Methods now
    receive `context` from `draw()`.

- **Item 2 — Gate placement link (2026-05-11).** `gateSpacing` field on
  the track JSON, shared `resampleByArcLength()` in
  [`src/game/tracks/gate-placement.ts`](../src/game/tracks/gate-placement.ts),
  Python mirror in [`tools/blender/gate_placement.py`](../tools/blender/gate_placement.py),
  Blender addon panel toggle ("Rebuild Gate Preview" / "Hide Gate
  Preview" in the N-key Hoverbike tab), and editor button ("Auto-place
  gates from spline"). Vitest case + Python self-test pin both sides to
  the same algorithm. Default spacing is **60m** (preserves Lagoon
  Loop's ~9-gate density while fixing its 42–100m uniform-T variance).

  Outstanding before this counts as fully closed: Matt needs to
  reinstall `tools/blender/hoverbike_addon.py` in Blender to pick up the
  new operators (Edit → Preferences → Add-ons → Install…, then re-tick
  the box). The live MCP-side demo of the gate gizmo in
  `tracks-src/test-custom-track.blend` is already visible in the
  viewport.

- **Item 7 — Racer-at-start preview (2026-05-11).** New "Rebuild Racer Preview" / "Hide Racer Preview" buttons in the addon's N-key Hoverbike panel. Drops a bike-silhouette wireframe at `start_00` (with rider-hump so the player reads as distinct from the AI) plus one per AI slot loaded from [`specs/grid-offsets.json`](../specs/grid-offsets.json) — the *same* file `src/boot/spawn-bikes.ts` now reads, so the in-Blender preview matches the actual race spawn 1:1.

- **Item 6 — Vertex attribute spec (2026-05-11).** Canonical `COLOR_0`
  contract for procedural assets. Spec lives in
  [`docs/vertex-attribute-spec.md`](./vertex-attribute-spec.md):
  foliage uses R=sway, G=AO, B=phase, A=free; terrain reuses the
  same attribute with B=path-worn, A=biome. Shared sway shader
  hook scaffolded in
  [`src/engine/render/foliage-sway.ts`](../src/engine/render/foliage-sway.ts);
  Blender authoring helper in
  [`tools/blender/vertex_attrs.py`](../tools/blender/vertex_attrs.py)
  with a live-verified `set_linear_sway_z` preset. Nothing in the
  game uses the hook yet — it's ready for Items 3 and 4 to plug
  into.

- **Item 5 — Blender-side water preview (2026-05-11).** New "Rebuild Water Preview" / "Hide Water Preview" buttons in the addon panel build a vertex-displaced water plane around `water_volume_main`. The Gerstner wave parameters mirror `defaultWaves()` in [`src/engine/sim/water/wave-field.ts`](../src/engine/sim/water/wave-field.ts) — same 6-wave swell+chop preset the runtime uses. Scene properties expose plane size (default 300m), subdivisions (default 80), and sample time (scrub to see different wave snapshots). Per-bike wakes are intentionally omitted — they need live bike sources and don't add value at author time. Live-verified on test-custom-track.blend: ±2.4m peak displacement matches the configured amplitudes.

- **Item 4 — Scatter pipeline V1 (2026-05-11).** Geometry-Nodes
  scatter now round-trips through the export pipeline as
  `EXT_mesh_gpu_instancing` glTF instancing. Both `export_gn_mesh`
  and `export_gpu_instances` are flipped on at all four export
  call sites (`tools/export_track.py`, `tools/blender/common.py`,
  and the two Hoverbike-addon operators). Three.js's stock
  `GLTFLoader` produces `THREE.InstancedMesh` at the receiving
  end with zero client-side plumbing. `attachTrackColliders` skips
  `InstancedMesh` so scatter is render-only by default — the wishlist's
  documented stance. Authoring convention written up in
  [`docs/blender-pipeline-guide.md`](./blender-pipeline-guide.md#scattered-props-item-4).

  Deferred to V2: collidable scatter (e.g. `kind = "collidable_scatter"`
  walking `instanceMatrix` and registering N per-instance trimeshes),
  an addon UX picker that wires `Collection Info → Instance on Points`
  templates, and a vitest fixture .glb that pins the round-trip.

- **Item 3 partial — Turn-indicator preview (2026-05-11).** New
  "Rebuild Turn Indicators" / "Hide Turn Indicators" buttons in the
  addon panel. Samples signed curvature along `ai_spline_main`,
  finds local maxima above `|κ|` threshold (default 0.02 1/m ≈ 50m
  radius — matches the stadium-track corner radius), collapses
  neighbours within 20m, and places chevron-shaped arrow gizmos
  pointing in the bend direction. Live-verified on test-custom-
  track: 3 indicators at the canonical tight corners.

  This is the fully-scriptable sub-piece of Item 3. The remaining
  props (rocks, palms, buoys, gates as real meshes) all require
  in-Blender GUI work for aesthetics and are left as a fresh-
  session deliberate piece — scaffolding (Items 4 + 6) is ready.

- **Water-preview orientation fix (2026-05-11).** Caught the day
  Item 5 shipped: the runtime wave-field uses Y-up (Three.js)
  convention, but Blender authors Z-up. The first version built
  the plane vertically. The addon now samples wave height into
  Blender's Z axis with the horizontal XY plane carrying the
  spatial coords — water sits flat as expected. Live-verified.

## Reference scale

`tracks-src/test-custom-track.blend` is the scale reference. Bikes are ~2.5 m
long; gates default to 28 m wide (`half_width = 14`) and 6 m tall; 1 Blender
unit = 1 metre. The hybrid pipeline (M9.19+) keeps environment geometry in the
`.blend` and gameplay placement in `public/tracks/<id>.json`, joined at runtime
via `environmentGlb`.

## Item 1 — Geometry-Nodes level template ✅ Shipped 2026-05-11

`tracks-src/template-island.blend` ships with a live Geometry Nodes
modifier (`HV_Island`) that procedurally generates a volcanic-tropical
heightfield — inspired by St. Lucia. The terrain is a single 1024 × 1024
m subdivided plane (~150 k verts) carrying both above-water and
below-water geometry: cone-shaped peaks with optional craters,
continental shelves descending to a deep-water floor, fringing reef
rings around each island, multi-octave noise modulated by altitude.

Authoring is GUI-driven via **paired empties** — drag
`peak_NN_base` (CIRCLE footprint) to move the entire island, drag
`peak_NN_top` (SPHERE apex) to retune height, lopsided offset, and
crater flag. The top empty is wired to the base via a *Copy Location*
constraint, so moving the base drags the top along. The modifier
panel exposes 11 global knobs: shelf depth/radius, reef
inset/height/width (reef defaults off), cone erosion + erosion scale,
roughness above/below, noise scale/seed.

The graph supports **up to 8 peak pairs** by design — unused slots
contribute a sentinel that loses the max-combine, so empty slots are
free. The default seeded scene has 1 central peak with crater (apex
shifted ~25 m NE for a lopsided silhouette), 2 flanking medium peaks
(one straight, one lopsided E), and 1 submerged shoal. COLOR_0 is
stamped per the [vertex-attribute spec](./vertex-attribute-spec.md)
(R=0 sway, G=1 AO placeholder, B=0 path-worn, A=biome). Biome bands
are tuned so most underwater reads as sandy seafloor, with deep-blue
appearing only at the deepest shelf floor.

The seed script also invokes the addon's *Rebuild Water Preview*
helper so the seeded `.blend` opens with a visible wave-displaced
water surface — useful when sizing islands against the water plane.

Build script: [`tools/blender/seed_template_island.py`](../tools/blender/seed_template_island.py) —
one-shot scaffolder analogous to `seed_bike_kit.py`. Authoring guide:
[`blender-pipeline-guide.md`](./blender-pipeline-guide.md#procedural-island-template-item-1).

Realism note from the original brief — that a *real* procedural island
generator (Voronoi shorelines, biome falloffs, shoreline foam) would
be a several-hundred-node GN graph painful to author through `bpy` —
held up. The shipped graph is ~67 nodes across two groups; aesthetic
polish (real materials, foliage scatter, AO bake) is left as in-GUI
follow-up.

Deferred: real PBR terrain material (the seed ships a placeholder
vertex-color ramp), AO baking, racing-line painting of the `COLOR_0.B`
path-worn channel.

## Item 2 — Tighter Blender ↔ in-app editor link for gate placement ✅ Shipped 2026-05-11

Today the hybrid pipeline retired `cp_NN` empties from the `.blend`
(see [blender-conventions.md](./blender-conventions.md): "*Most of the object
kinds below … are now redundant — the editor owns those*"). So Blender shows
zero gates right now. Matt wants gates *visible* in Blender, computed from the
AI spline + a spacing parameter, so he can sanity-check track flow without
exporting and loading in the game.

Design:

- Add a `gateSpacing` (metres) field to the `public/tracks/<id>.json`
  schema.
- **Blender side:** extend `tools/blender/hoverbike_addon.py` with a
  "Show gate preview" toggle in its N-key panel. A small GN node group
  resamples `ai_spline_main` by length and instances a gate gizmo
  (transparent quad at `half_width × height`, oriented to the spline
  tangent) every `gateSpacing` metres. Pure preview — gates stay
  JSON-owned, exporter unchanged.
- **In-app editor side:** an "Auto-place gates from spline" button that
  runs the *identical* algorithm and writes the resulting gate positions
  into the JSON. Reuses the spline-sampler that the runtime already uses
  to bake AI spline points.

### Realism: high

Cleanest scope, biggest iteration-loop improvement. Each side is a
self-contained change; the algorithm is small enough to live in one
shared spec doc. Claude is confident here.

## Item 3 — Geometry-Nodes-based props

A `tracks-src/props-library.blend` that registers reusable props as Blender
Assets, browsable from any track `.blend` via the Asset Browser. Wanted
props:

- Rocks.
- Palm trees.
- Buoys (water-aware, optional bobbing animation).
- Gates — the race gate as a *real* prop mesh, distinct from the
  spline-driven gate *gizmo* from Item 2. Useful for decorative gates,
  fixed-position gates that exist outside the AI-spline cadence, and
  giving Item 2's gizmos a non-placeholder appearance once they're
  baked.
- Turn indicators — arrows that show up automatically on sharp turns,
  oriented tangent to the track curve.

### Realism: high for the structural work, partial for the visual tuning

Each prop is a small GN node group. The turn-indicator one is the most
uniquely valuable and reuses spline-sampling math from Item 2:
sample curvature along the AI spline, instance arrows where |κ| > threshold,
orient them tangent to the curve.

What's straightforward for Claude: assembling the `.blend` deterministically
via `tools/blender/build_props.py`, wiring each GN group's inputs / outputs,
marking groups as Assets with sensible catalogues and preview thumbnails,
and the spline-curvature logic for turn indicators.

What's *not* straightforward without in-Blender visual iteration: aesthetic
tuning (rock noise scales, palm leaf silhouettes, buoy bob frequency).
Plan to scaffold + hand off to a human GUI pass.

## Item 4 — GN-based prop scattering tool ✅ Shipped V1 2026-05-11

A Blender-side scatter system that distributes prop instances across the
terrain (or along the curve, or in tagged regions), so authors can paint
"rocks here, palms there, buoys offshore" without placing every prop by
hand. **Hard requirement:** scattered props must arrive at runtime as
*instanced* meshes, not unique mesh copies. A track with 800 palms must
cost roughly what 1 palm costs in vertex / draw memory, plus the
per-instance transform.

Plan:

- Authoring side: a `scatter_zone = "<zone_name>"` custom property on
  track surface meshes tags them as scatter targets. A
  `tracks-src/scatter-rules.blend` (or per-track) defines, per zone,
  density / source prop set / slope filter / elevation filter, wired
  through a Geometry Nodes group on a scatter modifier.
- Export side: the GN graph must use Blender's *instance* outputs
  (`Instance on Points`, `Collection Info` in Instance mode), and the
  exporter must preserve the instance hierarchy. glTF carries this via
  the `EXT_mesh_gpu_instancing` extension. Verify (a) Blender's glTF
  exporter emits the extension when scattered output is present, and
  (b) `tools/export_track.py` doesn't strip or flatten it.
- Runtime side: Three.js's `GLTFLoader` supports
  `EXT_mesh_gpu_instancing` natively and produces `InstancedMesh`
  nodes. Glb-loader needs to recognise these and wire collider /
  visibility behaviour appropriately. Decoration scatter is render-only
  by default.

### Realism: high once the runtime instancing path is verified

The GN-side authoring is standard. The integration risk is entirely in
the export → load round-trip; if `EXT_mesh_gpu_instancing` doesn't
survive `tools/export_track.py` today, that's the first thing to fix.

Open questions:

- Confirm `EXT_mesh_gpu_instancing` survives the current export.
- Per-zone instance count budgets (e.g. cap dense palm zones at ~500
  instances each to keep frustum-cull cost bounded).
- Should scatter results be *baked* at export time (deterministic, seed
  in JSON) or re-rolled each time the GN graph evaluates? Baked is
  better for reproducible playtests.

## Item 5 — Blender-side water preview ✅ Shipped 2026-05-11

Make Blender's water plane look enough like the in-game water that Matt
can eyeball gameplay implications (will this jump clear the wave crest?)
without launching the build.

Plan: a Geometry Nodes group on a water plane that vertex-displaces
using the same wave function the runtime uses, with amplitude / frequency
driven by `water_volume_main`'s `wave_height` / `wave_freq` custom
properties. Paired with a Principled BSDF shader configured for the
water look (tinted blue, low roughness, light subsurface) so Eevee
preview is in the right visual ballpark. Lives in the template `.blend`s
(Item 1) and any new track template; can be retro-fitted onto existing
`tracks-src/*.blend` via the addon.

### Realism: medium-high

The wave math is small. The *visual* match is the tricky part — Eevee
won't render WebGPU's exact shader, and we shouldn't chase pixel parity.
Target is "geometry shape matches; colour is in the right family".

Open questions:

- Source of truth for the wave function. Today it lives inside the
  in-game water shader. Worth extracting the formula into a shared
  spec (e.g. `docs/water-spec.md`, complementing
  [docs/water-deep-dive.md](./water-deep-dive.md)) so both sides
  reference one definition rather than drifting.

## Item 6 — Vertex color + texture authoring rules for procedural assets ✅ Shipped 2026-05-11

A cross-cutting constraint, not a deliverable on its own: every
procedurally-built asset (Item 1's terrain template, Item 3's props,
Item 4's scatter sources, and `tools/blender/build_bike.py`'s bikes)
must carry vertex colours, and ideally textured materials whose visible
colour comes from the texture *with vertex colours reserved for
parameters*.

Channel proposal — to be confirmed before first use:

- `R`: sway / wind strength. `0.0` = rigid, `1.0` = full sway. Palm
  leaf tips get `1.0`, palm trunk base gets `0.0`.
- `G`: AO / shadow multiplier.
- `B`: per-instance animation phase offset, so a cluster of palms
  doesn't sway in lockstep.
- `A`: reserved for per-prop semantics (e.g. emissive multiplier on
  buoys, wear mask on gates).

Authoring side: prefer GN's `Store Named Attribute` over manual vertex
paint so the colours regenerate when the underlying graph changes.

Runtime side: Three.js needs `vertexColors: true` on the material, and
foliage / animated props need a shared sway shader that reads
`COLOR_0.r` × time × wind-direction-uniform and applies a vertex
displacement (cheap, no per-vertex animation memory). Same shader works
for palms, grass tufts, and any future flexible prop.

### Realism: medium

Authoring is straightforward. The runtime side is real engineering —
one shared sway shader, glTF material setup that preserves vertex
colours through the loader, and a wind uniform plumbed through the
render layer. Decide channel meanings *first* so downstream items
(rocks, palms, gates, turn indicators) author against a settled spec.

Open questions:

- Are foliage props going to share one sway shader, or per-prop?
  Shared is much cheaper and easier to tune globally.
- Do we extend the same channel scheme to terrain (grass density mask,
  path-worn mask)?

## Item 7 — Visible racer instances at start positions ✅ Shipped 2026-05-11

The current `start_NN` empties are arrow gizmos. Show actual bike
meshes parked at each start position in the Blender viewport so Matt
can eyeball grid spacing, confirm nothing overlaps geometry, and see
roughly what view the player will have at race-start.

Plan: an addon panel toggle "Show racers at starts". For each `start_NN`
empty, place a `Collection Instance` of a canonical bike (link from
`bikes-src/cruiser.blend` by default) at the empty's transform. Use
Blender's instance system so memory cost is trivial. Put the instances
in a dedicated collection that is hidden from the export so they never
ride into the `.glb`.

### Realism: high

A few dozen lines of `bpy` once the bike collection link is set up.
Main decisions are scope (just the player, or all racers including the
AI grid), and how to source the AI grid offsets (currently hardcoded in
`src/main.ts`).

Open questions:

- Show only `start_00` (the player), or all `start_NN` plus the
  hardcoded AI grid?
- If the AI grid is going to be previewed, the offsets should probably
  move out of `src/main.ts` into a `specs/grid-offsets.json` so Blender
  and the runtime share one definition.

## Recommended order

1. **Item 2** — entry point, highest leverage, cleanest scope.
2. **Item 7** — small, immediate visual win; uses no new infrastructure.
3. **Item 6** — settle the vertex-colour channel spec *before* any
   serious prop work, so Items 3/4 author against a stable target.
4. **Item 5** — independent visual improvement; benefits track design
   intuition immediately.
5. **Item 4** — depends on Item 6 being settled (so scatter sources
   carry the right vertex attributes) and on the runtime instancing
   path being verified.
6. **Item 3** — individual props (gates, turn indicators, rocks, palms,
   buoys). Best done after Items 4 and 6 land, so each prop slots
   straight into the scatter pipeline.
7. **Item 1** — last. The hand-placed island workflow stays viable
   for as long as we want; procedural island generation is a "nice
   to have" rather than blocking anything.

## Things to confirm before starting Item 2

- Where in the JSON schema does `gateSpacing` live? Top level alongside
  `environmentGlb`, or inside a new `gates: { spacing, ... }` object?
- Default value: probably **120 m** based on Lagoon Loop's existing gate
  cadence, but worth measuring before committing.
- Should the in-app editor's "Auto-place" be a one-shot button (writes the
  JSON once, gates are then individually editable) or a live mode (gates
  are derived on every spline edit, can't be manually moved)? The
  one-shot path matches the editor's existing UX.
