# Blender automation roadmap

Open items for Blender-side automation. Each item below was scoped during
the design phase with a realism assessment; the **Shipped so far** section
tracks what's landed and the rest is open for contribution.

**Contributors:** pick an item and open a draft PR or an issue to claim
it. The items are roughly independent — start anywhere. Items 1–7 are
sequenced by historical interest; later additions are not.

The connector documented in the top-level
[CLAUDE.md](../CLAUDE.md#blender-connector--optional) is one way to drive
Blender from a Claude session, but every item here can also be built
with the headless `pnpm gen:*` pipeline. The existing pipeline is in
[blender-pipeline-guide.md](./blender-pipeline-guide.md).


## Shipped so far

- **Five authoring tools to round out the iteration loop (2026-05-13).**
  Five additions covering visible features authors couldn't easily
  reach from the addon:
  - **Sea level slider.** New *Sea level (m)* row in the Water box —
    proxies `water_volume_main.location.z`, lazily creates the empty
    on first scrub. Drag the empty in the viewport or scrub the
    slider; both write to `water.height` on export.
  - **Boost pads.** New `boost_NN` empty pattern with custom props
    `half_width` / `half_depth` / `strength` (defaults match the
    in-app editor's placement.ts). *Add Boost Pad* drops one at the
    3D cursor with a cyan-emissive slab gizmo parented under it
    (lives in `_hoverbike_boost_pad_preview` so the export scrubs
    the visual). Empty's local +Y is the boost direction; rotate the
    empty around Z to aim. Round-trips through `boostPads[]` in the
    JSON; the merge respects opt-in (no `boost_NN` empties → editor
    keeps its placements).
  - **Road banking.** Two new road-tool sliders (*Bank* + *Max°*)
    auto-tilt the cross-section based on per-sample signed
    curvature, with smoothing so the bank eases in/out of corners.
    Bezier control-point `tilt` (N-panel → Curve → Tilt) is added on
    top, so authors can hand-tune a specific corner. Open curves
    don't get spurious endpoint banks; cyclic curves wrap cleanly.
    25° default cap, ~1.7° auto-bank on a 50 m radius corner.
  - **Terrain sculpt panel.** New section with five operators:
    *Apply Terrain Modifiers* (bake HV_Island into editable verts),
    *Subdivide Terrain*, *Sculpt Terrain* (one-click into Sculpt
    Mode with proper active-object setup), *Raise / Lower @ cursor*
    (smoothstep falloff, Δz + radius sliders), *Smooth Terrain*
    (global Laplacian pass with iter / weight knobs).
  - **Turn indicator visibility fix.** The wireframe-chevron gizmo
    was 2.5 m of edges lying flat on a 1 km terrain — invisible at
    track scale, leaving the *Rebuild Turn Indicators* button feeling
    broken. Replaced with a 12 m × 6 m × 2.5 m solid upright pylon in
    bright orange (emissive `mat_turn_indicator_preview`). Default
    |κ| threshold lowered from 0.02 to 0.01 1/m so gentler
    JetMoto-style sweeps register. The *zero peaks* case now reports
    a WARNING with the strongest curvature on the spline, so authors
    know whether to lower the threshold or sharpen the bends.

  Reinstall `tools/blender/hoverbike_addon.py` in Blender to pick
  these up.

- **Road + ramp authoring tools (2026-05-12).** Two new operators that
  cover the "I want to author a real track feature, not just place a
  prop" use case:
  - **Road tool.** *Add Road Curve* drops a 4-point Bezier named
    `road_curve_main`. The author edits it to draw the racing line
    they want; *Build Road* samples the curve along its arc length,
    raycasts each sample onto the terrain, smooths the resulting
    height profile (1-2-1 binomial, default 4 passes), builds a road
    strip mesh tagged `kind=track` with the new `mat_track_road`
    asphalt-grey material, *and* deforms the terrain in a
    `width/2 + blend_radius` band so it conforms to the road's
    altitude. Inner band flattens fully; outer band smoothsteps. The
    operator warns if the terrain still has active modifiers (GN
    output would overwrite the deformation — apply first). Re-runs
    replace the prior road; Ctrl+Z restores the prior terrain.
  - **Ramp tool.** *Add Ramp* drops a parametric stunt-ramp wedge at
    the 3D cursor, tagged `kind=track` (collidable on export) with
    the new `mat_track_ramp` saturated-orange material. Length /
    width / peak height / approach run-up are scene props; *Curved
    kicker* toggles between a smoothstep launch profile (default,
    natural launch tangent) and a flat linear wedge. Ramps get
    sequential `ramp_NN` names so repeated placement doesn't stomp.

- **Authoring loop overhaul (2026-05-12).** Six follow-ups on top of
  the live-preview pass:
  - **Real prop-mesh gate gizmos.** The gate preview now links
    `prop_gate_mesh` from `tracks-src/props-library.blend` and
    instances it at each placement (with a fix-up Rx(-90°) so the
    author's Z-up posts land on the gizmo's local +Y up axis). Scales
    linearly with the scene's gate half-width / height. Falls back to
    the wireframe gizmo if the library isn't present so empty repos
    still preview.
  - **Snap spline to terrain.** New *Snap Spline to Terrain* button
    raycasts every NURBS / Bezier control point on `ai_spline_main`
    straight down and lifts it by the configured hover height
    (default 3 m). Preview collections are excluded from the cast so
    the gate / racer / water gizmos can't catch the ray. Pairs with
    the live gate preview — re-snap after a terrain edit and the
    gates slide back into place automatically.
  - **Heightmap importer.** New *Import Heightmap* button reads a
    greyscale PNG/EXR, samples luminance bilinearly, and emits a
    subdivided plane tagged `kind=track` so it exports as collidable
    terrain. Size / Δz / base elevation / subdivisions are scene
    props; the file path is remembered between imports.
  - **Ghost lap + chase cam.** New *Rebuild Ghost Lap* button drops a
    bike silhouette bound to `ai_spline_main` via a Follow Path
    constraint, plus a chase camera parented to the bike with a
    Track-To constraint pointing back at the racer. Sets the scene
    frame range to `arc_length / target_speed * fps` so Spacebar plays
    exactly one lap at the configured speed (default 25 m/s, 30 fps).
    The chase cam becomes the scene's active camera so view-from-camera
    frames the lap immediately.
  - **JSON ↔ .blend round-trip.** New *Reload from JSON* button + a
    `load_post` handler pull scalar / parametric fields from
    `public/tracks/<id>.json` into the .blend on every open (gate
    spacing, terrain shader, water, start pose). Export always writes
    the JSON now, merging Blender-owned keys onto whatever the editor
    last saved — the *Shift-click to overwrite* mode is gone since
    the merge is non-destructive by default (hybrid-pipeline `cp_NN`
    empties still win when present, so the legacy flow keeps working).
  - **`gateSpacing` round-trips.** `derive_track_json` now writes
    `gateSpacing` from the scene prop; reload pulls it back. Editing
    spacing in either Blender or the in-app editor flows through one
    place.

- **Live preview auto-rebuild + racer orientation fix (2026-05-12).**
  Three correctness + UX fixes to the preview gizmos:
  - **Racer preview no longer appears vertical.** `_bike_silhouette_mesh`
    was built in runtime axes (length along +Z, height along +Y) and
    dropped into Blender's Z-up world without any conversion, so each
    bike stood on its tail. The mesh is now Blender-native (length
    along ±Y, height along +Z); inheriting the `start_NN` empty's
    yaw rotation around world-Z rotates each bike in the horizontal
    plane while keeping it upright. The AI grid was stacking AI bikes
    *vertically* (adding `slot.dz` to Blender's Z) — fixed to translate
    along Blender −Y, matching three.js +Z forward.
  - **Spline-driven previews now follow edits.** A `@persistent`
    `depsgraph_update_post` handler watches `ai_spline_main`,
    `start_00`, and `water_volume_main`, debounces (~0.2 s), and
    rebuilds whichever preview collections (`_hoverbike_gate_preview`,
    `_hoverbike_turn_preview`, `_hoverbike_racer_preview`,
    `_hoverbike_water_preview`) exist. Editing a NURBS control point
    on the AI spline now slides the gates and chevrons along with
    it — no more click-Rebuild round-trips.
  - **Gate / turn / water scene props now live-update.** The
    `FloatProperty` registrations gained `update=` callbacks that
    funnel through the same debounce, so scrubbing gate spacing, gate
    half-width/height, turn |κ|, or wave time live-refreshes the
    preview as you drag. The N-panel shows a "Live: follows spline
    edits" hint once the gate collection exists.

- **Template-island polish + preview-export scrub (2026-05-11).** Five
  small follow-ups on top of Item 1:
  - **Billowy ocean floor.** New `Seafloor Billow` (default 10 m)
    + `Billow Scale` (0.004) sockets on `HV_TemplateIsland`. A
    distorted FBM noise gated by a smoothstep mask (full at
    z=-8 m, zero at z=-1 m) carves the sub-shelf floor into ridged
    silt rather than a flat plateau. Live-verified on
    `tracks-src/template-island.blend`: underwater verts span
    roughly z∈[-55, -10] m with σ≈10 m of relief, while the
    shoreline mask keeps billows from poking through the waterline.
  - **Billowy above-water terrain.** Mirror pass — `Land Billow`
    (default 6 m) + `Land Scale` (0.012). Symmetric signed noise
    (no bias) gated above z=+2 m so cones gain craggy outcrops /
    gulleys and beach plateaus pick up rolling-hill texture, without
    touching the shoreline. Cones now read as eroded volcanic peaks
    instead of smooth ice-cream silhouettes; the seafloor pass is
    unaffected because the masks meet around the waterline.
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

- **Item 3 — Procedural props library (2026-05-11).**
  `tracks-src/props-library.blend` built deterministically by
  [`tools/blender/seed_props_library.py`](../tools/blender/seed_props_library.py).
  Five prop collections — rocks, palms, buoys, gates, turn indicators
  — each marked as a Blender Asset under the `Hoverbike/Track Props`
  catalogue (catalogue file: `tracks-src/blender_assets.cats.txt`).
  Authors register `tracks-src/` as an asset library once, then drag
  props into any track .blend as Collection Instances. Rocks and palms
  carry GN modifiers (`HV_Prop_Rock`, `HV_Prop_Palm`) so size /
  jaggedness / scale stay tunable per-instance; buoys / gates /
  indicators ship as static mesh assets. Every mesh stamps `COLOR_0`
  per the Item 6 vertex-attribute spec; the palm uses the foliage
  channel (linear sway gradient `R=0` at trunk base → `R=1` at leaf
  tips) so the runtime sway shader animates the fronds via
  `mat_foliage_palm`. Every collection carries
  `scatter_source = True` so Item 4's scatter graphs can list them as
  Collection-Info sources. Headless seed verified — all 5 collections
  asset-marked with right metadata, all meshes carry `COLOR_0`, GN
  modifiers evaluate to expected bounds (rock ≈ ±1.3m, palm = 4.8m
  tall, gate = ±14.35m × 6m). Authoring guide:
  [`blender-pipeline-guide.md`](./blender-pipeline-guide.md#procedural-props-library-item-3).

  Earlier turn-indicator partial (2026-05-11): "Rebuild Turn
  Indicators" / "Hide Turn Indicators" buttons in the addon panel
  remain the canonical placement — they sample signed curvature along
  `ai_spline_main`, find local maxima above `|κ|` threshold
  (default 0.02 1/m ≈ 50m radius), collapse neighbours within 20m, and
  place chevrons pointing in the bend direction. The library's static
  chevron is for fixed-position author use.

  Deferred to in-Blender GUI iteration (same caveat as Item 1): real
  PBR materials, sculpted rock silhouettes, palm-leaf textures,
  per-prop preview thumbnails. Buoy bobbing is a runtime concern
  (water shader handles flotsam) — the buoy asset is intentionally
  static.

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

Today the hybrid pipeline retired `cp_NN` empties from the `.blend` — most
of the legacy in-glb object kinds are redundant now that the in-app editor
owns gameplay placement (gates, pickups, splines). So Blender shows zero
gates right now. Matt wants gates *visible* in Blender, computed from the
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

## Item 3 — Geometry-Nodes-based props ✅ Shipped 2026-05-11

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

## Next-wave wishlist (post-color-pass, 2026-05-11)

A revised set of items to chase next, ranked by how much they'd unlock
or fix in the current authoring loop:

1. **Vertex-attribute bakers — AO + path-worn.** The COLOR_0 stamp from
   the GN graph ships `G=1` (placeholder) and `B=0` (placeholder). Real
   values would let the runtime terrain shader darken cavities and
   visibly wear a racing line into the surface. Plan:
   - **AO bake.** A *Bake to Vertex Color* operator that runs Cycles'
     AO bake into COLOR_0.G. One-click, idempotent. Needed because the
     procedural-island heightfield has no UVs to bake an AO texture
     against, so vertex-attribute bake is the only path.
   - **Path-worn bake.** Sample the AI spline → for each terrain vertex
     within a falloff radius of the spline, scale COLOR_0.B by a
     distance-based mask. Reads as a worn dirt track in-game.
2. **Runtime terrain-shader sliders in the addon panel.** Right now the
   slope-mix range, altitude band, variation noise scale, and wet-band
   width are TS constants in `src/engine/render/terrain-shader.ts`.
   Exposing them as scene custom properties + an addon panel — and
   writing them into `public/tracks/<id>.json` at export — would let
   authors tune the in-game look without a code edit + reload.
3. **Track stats / sanity panel.** A read-only panel that shows: AI
   spline length, lap-time estimate at constant 25 m/s, count of gates
   / pickups / starts / boost pads, max & min terrain y, water
   coverage %. Catches authoring mistakes ("track is 87 m long")
   before the export.
4. **~~Item 3 props library — rocks + palms + buoys, finally.~~**
   Shipped 2026-05-11. `tracks-src/props-library.blend` produced by
   `tools/blender/seed_props_library.py`, five collections marked as
   Blender Assets under the `Hoverbike/Track Props` catalogue. The
   *aesthetic* polish (real PBR materials, sculpted silhouettes, palm
   leaf textures, preview thumbnails) is still the biggest visual
   upgrade left and benefits from in-Blender GUI iteration on the
   shipped scaffold rather than further scripting.
5. **Real-time runtime-shader-match in Blender preview.** The Blender
   `mat_terrain_main` shader was tuned to match the *intended* runtime
   look; the actual runtime shader I shipped today is close but not
   pixel-perfect (variation noise frequency, ramp interpolation method,
   wet-band tint). Bringing them into 1:1 alignment — either by porting
   the GLSL into Blender or vice versa — closes the
   what-you-see-is-what-you-get loop.
6. **~~Heightmap import.~~** Shipped 2026-05-12. *Import Heightmap*
   button reads a greyscale PNG/EXR and emits a subdivided
   `kind=track` plane luminance-displaced by the image. Re-import
   replaces any prior `terrain_heightmap` mesh.
7. **Spline curvature visualizer.** Item 3's turn-indicator chevrons
   are placed where |κ| > threshold but the threshold itself is opaque
   to the author. A small overlay that colours the AI spline by signed
   curvature (red = tight right, blue = tight left, neutral = straight)
   would make the threshold tunable by eye.

### Realism assessment

- **(1) AO + path-worn bakers** — *high*. Both are short Python operators
  using bpy's built-in baking API; the AO bake reuses Cycles' existing
  output to vertex colour. ~4 hours of work.
- **(2) Addon-panel runtime sliders** — *medium-high*. Needs three sides
  to agree: addon UI writes scene props → export writes them to
  `public/tracks/<id>.json` → runtime reads them as uniforms in
  `terrain-shader.ts`. Cleanest if we settle on a single schema first.
- **(3) Track stats panel** — *high*. Pure Python over data already in
  the scene.
- **(4) Props library** — *medium*. The structural work (GN groups,
  asset marking, build_props.py scaffold) is straightforward; the
  *visual* tuning of rock noise, palm leaf silhouettes, buoy
  proportions is the bulk of the time and benefits from in-Blender
  GUI iteration rather than scripting.
- **(5) Blender ↔ runtime parity** — *medium*. Mechanical port but
  benefits from one author owning both sides so the look stays in sync.
- **(6) Heightmap import** — *high*. ~50 lines of Python.
- **(7) Curvature visualizer** — *high*. The curvature math already
  exists for Item 3; just wire the per-sample κ into a per-vertex
  colour on a duplicate of the spline.

Recommend tackling **(1) + (3)** first — both small, both immediately
useful, both prerequisites for the bigger Items 3/4 push.

## Post-track-build assessment (2026-05-13)

Notes after using the addon to build two showcase tracks end-to-end
(`oval-loop.blend` and `figure-eight.blend`). Ranked by how much each
would have cut friction during the build, with realism estimates.

### 1. Make `ai_spline_main` and `road_curve_main` one curve

Today the racing line and the road centerline are two separate
NURBS objects that need to be authored to match. For both new tracks
I hand-wrote the same control points twice — error-prone and slow.

Fix: the road tool should default to `ai_spline_main` as its source
curve, with `road_curve_main` only used when explicitly set. The Add
Road Curve operator becomes optional ("I want a separate road shape
from the racing line"). Affects `_sample_road_path` and the operator's
curve-lookup. ~50 lines of Python. **High value, low effort.**

### 2. Place ramps along the spline at curvature peaks (or arbitrary t)

I had to compute the spline tangent in Python and place ramps with the
3D cursor for every ramp. Two operators would close this:

- **Add Ramp at Spline t** — pick a curve, pick a parameter t in [0, 1],
  drop a ramp tangent-aligned to that point. Uses the existing
  `_sample_curve_to_polyline` + arc-length math.
- **Auto-place Ramps on Spline** — reuse the turn-indicator's signed-
  curvature detector (`_signed_curvature_peaks`) to place a ramp at
  every detected apex. Honors a min-spacing knob so racers aren't
  jumping every 30 m.

~100 lines of Python total; both reuse code that already exists.
**High value, low effort.**

### 3. Variable road width (taper)

The road's width is uniform — the same value at every sample. F1
tracks widen at apex and narrow on straights. Authors want this for
visual variety and racing line interest.

Fix: store a per-sample width multiplier on each spline control point
(via the NURBS point's `radius` field — it's already there) and have
`_build_road_strip_mesh` scale `half_w` by the interpolated radius.
Curbs scale with the road. Same idea applies to lift (banked
corners). **Medium effort** — needs sampling-side interpolation, plus
a panel hint that radius drives width.

### 4. Active fail when terrain has no peaks under the road

In oval-loop, the terrain inside the oval was completely flat (z=0)
because HV_Island only contributes height where peaks are authored.
The racing surface ended up featureless. Two angles:

- **Terrain detail layer**: add a low-amplitude rolling-bump pass to
  the HV_Island GN graph that's always on (not gated by peaks),
  governed by a new "Surface noise" knob (default 0.5 m). Authors
  who want pancake-flat dial it to zero.
- **A second template** — `seed_template_<style>.py` variants for
  desert / valley / archipelago, picking different terrain colours
  and base heightfields. The current "tropical island" template is
  one of N, not the only.

**Medium-high effort.** Mostly aesthetic but matters for "the new
tracks look different from each other".

### 5. Track lint before export

I almost shipped tracks where the racing line dipped underwater on
short bridges, and one where the start position had no road
underneath. A pre-export lint pass would catch these:

- Each AI spline point: raycast down, confirm we hit `kind=track` (not
  water, not nothing).
- `start_00` / `start_01`: raycast down, confirm a track surface
  exists below within hover range.
- `road_main` exists if a road curve was authored.
- Lap-length sanity: AI spline arc length ≥ 60 m (avoid the
  "87 m track" gag).
- `gateSpacing` × N gates ≈ arc length (warn on extreme densities).

Show as ERROR (refuse export) for fatal issues, WARNING (allow but
report) for soft ones. **High value, ~150 lines.**

### 6. Playtest button → opens the browser at the track

I closed Blender and typed the URL multiple times. The addon already
has *Copy Play URL*; add a sibling *Open in Browser* that calls
`webbrowser.open(url)` from the Python stdlib. **Trivial. ~5 lines.**

### 7. Manifest authority handoff

The addon's export now upserts `public/assets/manifest.json`, but
`pnpm gen:tracks` rewrites the file from scratch using only
`specs/tracks/*.json`. If you run `pnpm gen:tracks` after exporting
addon-built tracks, those entries vanish. Two options:

- Make `gen:tracks` *merge* into the existing manifest's track list
  rather than replace. Preserves addon-built entries.
- Or: have the addon also write a `specs/tracks/<id>.json` stub when
  exporting, so `gen:tracks` rediscovers the track. Heavier — adds a
  fake spec file per addon-built track.

The merge path is cleaner. **Medium effort, important for stability.**

### 8. Tangent-aligned cursor

The 3D cursor's rotation is what drives ramp orientation, but
Blender's stock cursor controls don't let you snap rotation to a
spline tangent. An operator *Cursor → Snap to Spline Tangent at t*
would unify all the manual `math.atan2` work that ramp / prop / start
placement currently needs. **Low effort, ~30 lines, used everywhere.**

### 9. Road texture (the asphalt looks like a tablet)

`mat_track_road` is a flat dark-grey BSDF. Real roads have a noise
texture, tire grooves, faint centerlines. The artistic value is huge
but it benefits from in-Blender material iteration — scaffold an
asphalt node group, then let the user hand-tune. The shipped material
should at minimum have a value-noise pattern so the surface doesn't
read as a pure painted shape from a distance. **Medium effort —
material work, not code.**

### 10. Mirror the road on the underside

The slab fix made the road look like a real structure, but only from
above. The road's underside (when crossing a valley or chasm) is a
flat dark face that reads cheap. A simple fix: the bottom of the slab
gets a separate `mat_track_road_underside` (concrete grey, slight
ribbing) so cross-valley shots read as bridge-like. **Trivial — one
material assignment + face winding tweak.**

### Pain points worth surfacing even if we don't fix them yet

- **The cursor's rotation_euler is read on add_ramp but lost on
  re-add.** Re-rotating the cursor between placements is finicky.
  Operator-level rotation arg would help.
- **No undo for the road build.** A bad spline tweak → Build Road →
  the terrain gets re-conformed cumulatively. Ctrl+Z reverses ONE
  vertex pass; the iterations remain. A pre-build snapshot would let
  the operator unwind cleanly.
- **Snap-to-terrain hits anything with `kind=track`.** Including the
  road itself if it's already been built. Workaround is currently to
  hide road_main before snapping. The snap operator should know to
  exclude road_main from its cast.
- **No way to set per-track lap count from Blender.** `lapsToFinish`
  defaults to 3 and lives only in the JSON — Blender export preserves
  whatever's there but the addon offers no UI to change it.
- **Race direction is implicit.** The first AI spline control point
  becomes the start of the lap. There's no visual indicator in
  Blender showing which way the racing line flows; you find out by
  testing.

### Recommended order

1. **(1)** Single-curve mode — unblocks every future track build.
2. **(7)** Manifest merge — prevents silent data loss.
3. **(5)** Track lint — catches the 80% of "why doesn't my track
   work" before they hit the runtime.
4. **(2)** Ramp placement helpers — reuses code already shipped.
5. **(6) + (8)** — tiny, immediately useful ergonomic wins.
6. **(3)** Variable road width — visual variety on demand.
7. **(4)** Terrain detail / template variants — biggest aesthetic
   upgrade for new tracks.
8. **(9) + (10)** — material polish, hand-tuning territory.

## Post-biome-build assessment (2026-05-13)

Notes from shipping the desert-dunes / mesa-canyon / alpine-valley
templates and one playable track on each. The first three are
shipped; the fourth was a known asymmetry in an existing template
worth flagging so the next biome author doesn't repeat the diagnosis.

### 1. `ShaderNodeTexNoise` with `normalize=False` is heavily skewed below 0.5 ✅ Shipped 2026-05-13

The dunes template's first build had a symmetric `[0,1] → [-1,+1]`
remap on every noise layer (`MULTIPLY_ADD` with multiplier 2 + offset
-1). Result: a ~-19 m downward bias on the supposed-mean-zero dune
displacement, dropping the entire racing-line ring below the
waterline so every spline snap clamped to water. Fix was switching to
`normalize=True`, which clamps the noise to `[0, 1]` and restores the
symmetric remap's intended zero-mean output.

The island template's `HV_TemplateIsland` graph uses `normalize=False`
deliberately + an asymmetric `[0,1] → [-1.4, +0.6]` remap — the
docstring there explicitly wants "rare extremes" carving dramatic
silt trenches. Both patterns are correct in their own contexts.

**Rule of thumb for new template authors:**
- Want symmetric, zero-mean noise (FBM dunes, hill displacement,
  bedrock ripple)? Set `normalize=True` and use `[0,1] → [-1,+1]`.
- Want rare downward extremes for dramatic-erosion silhouettes? Set
  `normalize=False` and bias the negative half (e.g. `[0,1] → [-1.4, +0.6]`).
- Never `normalize=False` + symmetric remap — you'll get the
  silent-downward-bias trap.

Three new templates (dunes, mesa, alpine) all follow the first
pattern. The island template still uses the second. The fix here is
purely a doc; no code changes wanted on the island template (its
artistic intent is correct).

### 2. Mesa / ridge sub-groups need to know the baseline to lerp to ✅ Shipped 2026-05-13

The first mesa template attempt had each per-mesa sub-group return
`0` for vertices outside the cliff band, with the main group then
applying `MAX(mesa_max, canyon_floor)`. Broke at the cliff foot:
`MAX(0, -8) = 0`, so vertices outside any cliff stuck at z=0 instead
of dropping to the -8 m canyon floor. Min z across the whole map
came out to exactly 0.0 — diagnostic gold.

Fix: pass `Valley Floor` (or `Canyon Floor`) as a scalar into the
sub-group and lerp from baseline → mesa-top inside the smoothstep
band. Outside the cliff returns exactly the baseline, so the parent's
MAX cascade cleanly picks up the floor for vertices not under any
mesa. Applied to both the mesa profile and the alpine ridge profile.

The island peak profile's per-peak output is "height above
seafloor" not "absolute altitude" — its baseline is implicitly 0,
and the main graph's combine treats the cone contribution as
additive to the global heightfield. That's *correct for the island
biome* (peaks always rise above whatever's underneath), but the
contract is non-obvious. Worth a one-line comment in
`HV_PeakProfile`'s docstring next time someone copy-pastes from it
for a new biome.

### 3. No first-class headless track-build entrypoint ✅ Shipped 2026-05-13

For each new biome I needed a per-track Python script that loads the
template, reshapes the spline, applies the modifier, builds the road,
snaps the spline, lints, exports. The original three were ~200 lines
each with ~80% common logic. Extracted the shared logic into
`tools/blender/track_build_lib.py`; each `seed_track_<id>.py` is now
~50 lines of config + one function call.

Future biome authors should write a new track script by copying
`seed_track_dune_rally.py` (shortest of the three), updating the
constants, and re-running. The library exposes `build_track_from_spec()`
which takes a small `TrackSpec` dataclass.

### 4. `snap_starts_to_spline` operator ✅ Shipped 2026-05-13

Every per-track script re-implemented the same "place start_00 and
start_01 perpendicular to the spline tangent at parameter t along
ai_spline_main" logic. Now an addon operator (Spline tools section
of the Hoverbike panel) does it from the viewport: pick `Spline t`
on the panel, click *Snap Starts to Spline*. Reuses the existing
`_sample_curve_at_t` helper. Available headlessly as
`bpy.ops.hoverbike.snap_starts_to_spline()`.
