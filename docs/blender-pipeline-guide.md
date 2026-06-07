# Track authoring pipeline

> Authoring **bikes**? See the bike section in
> [asset-pipeline-guide.md](./asset-pipeline-guide.md#bikes-bikes-srcidblend--specsbikesidjson)
> — same one-click flow, but the .blend is the source of truth for
> geometry instead of a JSON spec.

A track has two sources, edited in two different tools, joined at runtime:

- **`public/tracks/<id>.json`** — gameplay data (gates, AI spline, pickup
  spawns, boost pads, start pose, water tuning). Authored in the **in-app
  editor** (`?track=<id>&edit=1`); saved by clicking *Save*. Hand-editable
  if you prefer.
- **`public/assets/tracks/<id>.glb`** *(optional)* — environment geometry
  the bike collides with. Authored in **Blender**, exported with the
  one-click "Export to Game" addon (recommended) or the legacy
  `tools/export_track.py` script.

The JSON references the .glb via `environmentGlb`; at boot the runtime
fetches both, registers the .glb's meshes as collidable terrain, and
spawns the bike using the JSON's `start`. **Edit gameplay placement in
the editor; build geometry in Blender.** Iterate the gameplay loop
without ever opening Blender.

This page covers the Blender side. For the in-app editor see
[track-editor-guide.md](./track-editor-guide.md).

If you're just trying to add a metadata kind to an existing legacy
all-in-glb track, jump to the [Object kinds reference](#object-kinds-reference).
If something errored mid-export, jump to [Troubleshooting](#troubleshooting).

## TL;DR — the 15-second workflow (with the addon)

1. Install the addon **once**:
   *Edit → Preferences → Add-ons → Install…* and pick
   [`tools/blender/hoverbike_addon.py`](../tools/blender/hoverbike_addon.py).
   Tick the checkbox to enable.
2. Open or save your track as `tracks-src/<id>.blend` (the basename of
   the file becomes the in-game track id).
3. In the 3D viewport, press **N** → **Hoverbike** tab → **Export
   Track to Game**. The addon validates the scene, writes
   `public/assets/tracks/<id>.glb`, and on first export creates a
   starter `public/tracks/<id>.json` from the .blend's checkpoints,
   spline, pickups, and start. (The same panel offers
   **Export Bike to Game** when the open .blend is in `bikes-src/`.)
4. Playtest: in your browser, open
   `http://localhost:5191/?track=<id>` (or use the **Copy Play URL**
   button in the addon panel). The dev server is already aware of the
   new track — no code change needed; the in-app editor's File menu
   will list it on next reload.

**JSON ↔ .blend round-trip.** Opening a track `.blend` auto-pulls the
parametric fields from `public/tracks/<id>.json` into the scene — gate
spacing, terrain shader knobs, water wave height/freq, and the
`start_00` pose all reflect whatever the in-app editor last saved.
Editing those knobs in Blender and clicking *Export Track to Game*
merges them back onto the JSON; the in-app editor's hand-placed gates,
pickups, props, and sky stay intact. The *Reload from JSON* button in
the Hoverbike sidebar re-runs the auto-sync on demand, so changes made
in the editor while Blender is already open can be picked up without
closing the file.

Hybrid-pipeline rule of thumb: if the .blend has `cp_NN` / `pickup_*`
empties, Blender wins for that track (those positions overwrite the
JSON on export). If it doesn't, the editor wins for hand-placed
gameplay objects. The Blender-owned fields — `environmentGlb`, `water`,
`terrainShader`, `aiSplines`, `gateSpacing`, `start` — always come from
the .blend.

## Headless / CI fallback

The legacy script still works for scripted runs (CI, batch builds,
no GUI):

```bash
HOVERBIKE_OUTPUT=public/assets/tracks/my-track.glb \
  "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \
  --background tracks-src/my-track.blend --python tools/export_track.py
```

The script does **not** create a starter JSON — that's an addon-only
convenience. For batch builds the spec-driven pipeline
(`pnpm gen:tracks`) is the right tool; it derives both the .blend and
the JSON from `specs/tracks/<id>.json`.

## One-time setup

- **Blender 5.1+**. Windows install path is typically
  `C:\Program Files\Blender Foundation\Blender 5.1\blender.exe`. macOS:
  `/Applications/Blender.app/Contents/MacOS/Blender`. Add it to PATH if
  you don't want to type the full path every time.
- **Repo cloned**. `pnpm install` for the runtime side.
- **Familiarity with Blender's Object Properties → Custom Properties panel.**
  That's where every metadata field lives. Custom Properties is collapsed
  by default — expand it on each object you create.

## Mental model

Three layers, with a deliberately narrow contract between them.

1. **Authoring (Blender).** You build a scene of empties, meshes, and
   curves. Each object has a `kind` custom property declaring what it is
   (`track`, `checkpoint`, `ai_spline`, etc.). The naming pattern of the
   object (`cp_00`, `ai_spline_main`, …) must match its kind.
2. **Export (`tools/export_track.py`).** Validates the scene against the
   conventions, bakes any NURBS curves to flat point arrays in `extras`
   (glTF doesn't carry curves natively), and emits a single `.glb` with
   per-node `extras` populated.
3. **Runtime (`src/game/tracks/glb-loader.ts`).** Walks the .glb's nodes,
   reads each `extras.kind`, and builds a `Track` object that the sim
   layer consumes. The render-side loader (`engine/render/glb-track.ts`)
   uses Three's GLTFLoader to also pull the meshes into the scene.

The contract is `extras`. Anything that needs to round-trip from Blender
to the runtime — a checkpoint's gate width, a water volume's wave
frequency — lives in `extras`. The Track type can't read meshes or
materials directly.

## Authoring a new track

Easiest path: start from `tracks-src/calibration.blend`, which already
contains exactly one of every metadata kind set up correctly. Save-as a
new file, edit, export.

### 1. Open the calibration scene

```bash
"C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" tracks-src/calibration.blend
```

You'll see:

- A **flat plane** named `track_surface` at the origin — the drivable
  ground.
- A **water volume empty** (cube wireframe) named `water_volume_main`
  hovering above. Only useful for `wave_height` / `wave_freq` custom-prop
  overrides — sea level itself comes from the scene-wide *Sea level (m)*
  slider (`hoverbike_water_height`), not from this empty's Z.
- **Four checkpoint empties** (`cp_00`..`cp_03`) along the +Y axis.
- An **AI spline** (NURBS curve) named `ai_spline_main` running
  through the middle.
- A **pickup spawn** (sphere empty) named `pickup_main` at the origin.
- **Two player starts** (arrow empties) `start_00` / `start_01` at the
  south end of the plane.
- A sun light.

Inspect each one — Object Properties → Custom Properties — to see how
its `kind` and other props are set. That's the template.

### 2. Save as your track

`File → Save As… → tracks-src/<your-track>.blend`. Don't save into the
repo as `calibration.blend` — that's reserved for the smoke-test fixture
and is rebuilt from `specs/tracks/calibration.json` by `pnpm gen:tracks`
(driven by [`tools/blender/build_track.py`](../tools/blender/build_track.py)).

### 3. Build your layout

A real track typically needs:

- **Track surfaces / collidable geometry.** Every mesh in the .glb gets
  a static Rapier trimesh collider by default. To make a mesh
  render-only (decorative — banners, distant scenery), set custom
  property `kind = "decoration"` on it. Material name should start with
  `mat_track_*` for primary track surfaces (authoring convention; the
  runtime doesn't key off it yet). See [Limitations](#known-limitations)
  for the broadphase caveat.
- **A water sea level.** Set it on the *Sea level (m)* slider in the
  Hoverbike → Water sub-panel (scene prop `hoverbike_water_height`).
  Round-trips through `water.height` in the JSON. **Optional:** drop a
  `water_volume_main` empty (Add → Empty → Cube) only if you want to
  override `wave_height` / `wave_freq` custom-prop values per track
  (the empty's transform is no longer load-bearing for sea level).
- **Checkpoints.** One empty per gate, named `cp_00`..`cp_NN` (zero-padded,
  contiguous from 0). Place each at the gate centre, with the empty's
  forward axis (+Z in Blender, becomes +Z in three) pointing in the
  *direction the racer crosses the gate*. Custom props:
  - `kind = "checkpoint"`
  - `index = N` (must match the trailing digits of the name)
  - `half_width = 14` (gate width in metres on each side)
  - `height = 6` (vertical clearance)
- **An AI spline.** A NURBS curve named `ai_spline_main`. Trace the
  racing line you want the AI to follow — the runtime drives AI bikes
  along this. Custom props: `kind = "ai_spline"`, `branch = "main"`.
  The exporter samples the curve into points using Blender's `resolution_u`
  setting; bump `resolution_u` (Object Data → Active Spline) for a
  smoother spline.
- **Pickup spawns.** Empties anywhere along the track, named
  `pickup_*`. Custom prop: `kind = "pickup_spawn"`. The runtime
  rotates through pickup types at each spawn.
- **Player starts.** One or more empties named `start_00`, `start_01`,
  …. Place at grid positions, with the +Z axis pointing in the
  direction of travel. Custom props: `kind = "start"`, `index = N`.
  `start_00` is where the player spawns; AI bikes are placed in a grid
  behind it (offsets are hard-coded in `src/main.ts`).

See the [Object kinds reference](#object-kinds-reference) for the
complete name-pattern + extras matrix.

### 4. Export

In Blender, click **Hoverbike → Export Track to Game** in the View3D
header menu bar (next to View / Select / Add / Object), or press **N**
to open the sidebar's *Hoverbike* tab and click **Export to Game** in
the header. Either way prints to Blender's info bar:

```
Exported → public/assets/tracks/my-track.glb (created public/tracks/my-track.json)
```

If validation fails, each error appears as a red toast in Blender's
status bar — fix the offending object and click again.

The first export writes BOTH the GLB and a starter JSON. Subsequent
exports rewrite only the GLB and preserve the JSON (so the in-app
editor's saves are never blown away by a Blender re-export). To
force-rewrite the JSON, **Shift-click** the Export button.

### 5. Playtest

The track is automatically discoverable — `src/main.ts` resolves any
unknown `?track=<id>` against `public/tracks/<id>.json` first and
`public/assets/tracks/<id>.glb` as a fallback. **No code change
needed.**

```
pnpm dev    # already running
http://localhost:5191/?track=my-track
```

Or click **Copy Play URL** in the addon panel and paste it into your
browser.

Hit `T` to enable autoplay and watch the AI follow your spline. Use
[Backspace] to respawn at start_00 if a bike gets stuck. To tune
gameplay placement (gates, pickup spawns) without re-opening Blender,
switch into edit mode: `?track=my-track&edit=1` (or click **Open…**
in the editor panel).

## Authoring tools (Hoverbike menu + sidebar)

Two complementary surfaces:

- **View3D header → Hoverbike menu.** Top-bar dropdown next to View /
  Select / Add / Object. Holds every operator — Export, Add (terrain
  templates, gameplay, environment), Build / Refresh, Spline, Terrain,
  Thumbnail, Utility — plus a *Quick Pie* entry on **Shift+W**. Always
  available regardless of selection; the right place to fish for any
  operator.

- **N-panel sidebar (Hoverbike tab).** Press **N**, switch to the
  *Hoverbike* tab. The header is always visible (track id, Export, lap
  stats, missing-essentials scaffold). The per-tool sub-panels below
  are **selection-driven** — Road tool appears when `road_curve_main`
  is active, Spline tools when `ai_spline_main` is active, Water when
  the volume or preview is active, etc. A small "Active: …" hint at
  the top of the panel calls out which kind the current selection
  matches. Scene-wide sub-panels (Sky, Shader, Stats, Hero, Ghost
  lap, Emitters) stay always-on but default-closed.

The panel re-renders based on whether the `.blend` lives in
`tracks-src/` (track mode) or `bikes-src/` (bike mode). This section
covers the track authoring tools, top to bottom.

### Spline tools

Surfaces when `ai_spline_main`, a `start_NN`, or a `cp_NN` empty is
the active selection. The panel is grouped into **Setup** (only
visible when essentials are missing — Add Spline / Add Starts),
**Shape** (curve-level edits), and **Place along the curve**
(anything anchored to a `t` value).

- **Add AI Spline** drops a cyclic 4-anchor Bezier *circle* (fitted
  to the terrain's XY bbox at ~70% if a terrain mesh exists, else a
  `radius`-metre loop around the cursor) and chains the standard
  sidekick scaffolding: add_starts → rebuild_gate_preview →
  rebuild_buoys. Re-clicking on a scene that already has the spline
  re-runs the sidekicks only.
- **Snap Spline to Terrain** raycasts each control point of
  `ai_spline_main` straight down onto the scene, then lifts each
  hit by *Hover (m)*. Pairs with the live gate preview — after a
  terrain edit, snap the spline back onto the new surface and the
  gates follow. Preview collections (`_hoverbike_*_preview`) are
  hidden during the cast so gizmos can't catch the ray.
- **Reverse Spline Direction** flips the racing direction in place:
  reverses control-point order, swaps Bezier handles, then re-anchors
  the start grid to the same physical gate (uses `nearest_t_on_curve`
  to find the new t for the pre-reverse start XY) so the bikes flip
  to the other side of the line facing the new forward. Triggers the
  full dependent-rebuild sweep (gates, turns, helper, road, buoys,
  racer) via the handler debounce timer.
- **Cursor → Spline** moves the 3D cursor to a parameter `t` ∈ [0,1]
  along the racing line, with rotation aligned to the tangent.
- **Snap Starts to Spline** repositions `start_00` / `start_01` on
  the racing line at parameter `t`, lined up perpendicular to the
  tangent at the configured *Start gap* and pushed back by
  *Back-off (m)* (default 8 m, scene prop `hoverbike_start_backoff_m`)
  along the negative tangent so the grid sits *behind* the line. Yaw
  uses `atan2(tx, -ty)` — the runtime convention with the
  Blender↔three.js Y/Z flip baked in.
- **Add Ramp at t** spawns a tangent-aligned ramp at the current
  *Spline t* slider value (pairs with **Cursor → Spline**).

### Placement helper

A persistent, curve-constrained empty (`placement_helper`) that the
author parks at any (`t`, lateral offset) and uses as a placement
anchor for ramps, boost pads, props, anything else that needs to
land on or beside the racing line. Sliders re-pose live; the helper
also follows curve edits via the existing debounce timer.

- *t* (0..1) — parameter along the source curve.
- *Offset (m)* (-200..+200) — lateral offset perpendicular to the
  tangent in XY. Positive = right of the tangent, matches the
  start-grid convention.
- **Add Placement Helper** spawns the singleton (or re-poses it).
- **Cursor → Helper** snaps the 3D cursor to the helper's transform.
- **Add Ramp at Helper** / **Add Boost at Helper** drop the matching
  asset at the helper's pose without needing a manual cursor snap.

### Road tool

Draw a curve, build a drivable road slab that conforms the terrain
to its altitude profile and decorates the edges with F1-style curbs.

1. **Add Road Curve** drops a 4-point Bezier named `road_curve_main`
   at the scene origin. Tab into edit mode to shape it.
2. Set the dimensions:
   - *Width* (default 8 m) — total road surface width.
   - *Lift* (0.15 m) — small Z offset so the road reads above terrain.
   - *Slab (m)* (0.6 m) — extrusion depth. Set to 0 for the legacy
     paper-thin ribbon; any positive value gives a real volumetric
     slab so the silhouette reads as road and the underside is well
     below the conformed terrain.
   - *Blend* radius (6 m) — outer falloff band; terrain smoothsteps
     back to natural beyond the road's footprint.
   - *Samples* (64) — arc-length sample count.
   - *Smooth* passes (4) — 1-2-1 binomial smoothing on the height
     profile so the road doesn't follow every terrain bump.
3. Banking (set *Bank* = 0 to disable):
   - *Bank* (0.6) — multiplier on the curvature-driven auto-bank.
     0 disables auto-bank; 1.0 is pronounced; >1 is aggressive.
   - *Max°* (25°) — hard cap on signed bank angle so steep corners
     don't exceed comfortable racing angles.
   - Per-control-point: edit a Bezier point's **Tilt** (N-panel →
     Curve → Tilt) to add a hand-tuned bank on top of the auto-bank.
4. F1 curbs (optional — set *Curb w* = 0 to disable):
   - *Curb w* (0.6 m) and *Curb h* (0.12 m) — width and rise of each
     side strip.
   - *Stripe (m)* (2.0) — length of each red / white stripe along the
     road.
5. **Snap Curve to Terrain** drops every control point of
   `road_curve_main` straight down onto the terrain surface — one-shot
   raycast, seeds sane Z values on the curve. Doesn't touch the
   terrain. Skip points marked Float (`weight_softbody > 0.5`) so
   bridges and ramps keep their authored height.
6. **Build Road** builds the road strip mesh tagged `kind=track`
   (materials: `mat_track_road` asphalt slot 0, `mat_track_curb_white`
   slot 1, `mat_track_curb_red` slot 2, `mat_track_road_underside`
   slot 3 when a slab thickness is set) AND auto-attaches the live
   `HV_RoadConform` Geometry Nodes modifier on the terrain. The
   modifier reshapes the terrain inside the conform band on every
   evaluation — no vertex mutation, no drift, repeatable as many
   times as you want.

   Tune the modifier sockets in Properties → Modifiers → HV_RoadConform:
   *Inner Radius* (full conform inside this XY band), *Blend Radius*
   (smoothstep falloff outside), *Lift*, *Clearance*, *Strength*
   (master 0–1), *Bank Strength* (per-CP tilt multiplier), *Water
   Level* + *Water Feather* (source-terrain verts below this Z are
   excluded from the conform — seeded from the scene's water height
   so bridges over open ocean don't pull the seafloor up; set
   Feather = 0 for a hard cliff at the waterline).

7. **Edit the curve — the road follows automatically.** After Build
   Road has run once, the depsgraph handler in `handlers.py` watches
   `road_curve_main` (or `ai_spline_main` when it's the fallback) and
   re-runs the road mesh build ~0.2s after the last edit. Drag
   handles in edit mode, Tab back to object mode, watch the road
   reshape with no manual re-click. The same debounced auto-rebuild
   fires when you tweak any of the road scene properties (width,
   lift, blend radius, curbs, bank — anything that affects geometry).

**Active terrain modifiers are fine.** Stack `HV_RoadConform` on top
of `HV_Island`, heightmap displace, hand sculpt — any combination
works. The conform pass is the last thing that runs before the mesh
is rendered, so the road carves through whatever procedural shape is
underneath. Export is unaffected: the glTF exporter applies
viewport-visible modifiers on the way out (`export_apply=True` in
`export.py`).

**Banked roads.** Set per-control-point tilt in N-panel → Curve →
Tilt (or Ctrl+T in edit mode on selected points). Positive tilt
lifts the road's right side and dips the left; the conform modifier
reads each CP's tilt at the nearest curve point and tilts the
target Z around the road tangent so terrain follows the banked
cross-section. Master *Bank Strength* slider scales every CP's
effect (set to 0 to disable banking without losing the authored
per-CP tilts).

#### Bake to mesh — destructive, for export polish only

For most tracks the non-destructive flow above is the full pipeline.
The destructive **Bake Terrain to Road** operator exists for the
rare export-time pass when you need one of these features baked into
the .blend mesh:

* Curvature-driven *auto-bank* added on top of per-CP tilt. The
  live conform reads CP tilt only.
* Per-CP float/conform weight — the destructive bake respects the
  full conform-weight blend. The live conform always conforms inside
  the band (Snap Curve respects float-mode for the seed pass but
  the modifier doesn't gate on it yet).
* "Always push down lowest segment" rule for overpasses or
  doubled-back roads.
* Downhill *fill shelf* embankment widening.

Use it like this: iterate to taste with **Build Road**; when the
layout is locked, click **Bake Terrain to Road** with *Apply
modifiers first* on (if you have a procedural terrain modifier you
need to flatten too). It auto-disables `HV_RoadConform` for its
duration and leaves it disabled so the bake's vertex edits aren't
double-counted. Toggle the modifier back on to resume live editing,
or leave it off and ship the baked mesh.

### Tunnels

Drill a tunnel through any terrain mesh. A tunnel is three things in
lockstep:

- `tunnel_curve_main` — user-edited Bezier through the hill.
- `tunnel_NN_cutter` — closed manifold cylinder swept along the
  curve, hidden inside the dedicated `_hoverbike_tunnel_cutters`
  collection.
- `tunnel_NN_interior` — inward-facing concrete liner along the
  same curve, `kind="track"` so the runtime trimesh collider catches
  the bike.

The terrain carries a single Boolean DIFFERENCE modifier
(`HV_Tunnel_Cut`) whose operand is the cutters *collection*, so a
second tunnel just drops another cutter in and the existing modifier
picks it up. `export_apply=True` on the glTF exporter bakes the cut
into the GLB so the runtime sees actually-carved geometry — the game
side needs no special tunnel handling, just the standard collider
attach.

Workflow:
1. **Add Tunnel Starter Curve** drops `tunnel_curve_main` near the
   scene origin. Tab into edit mode, drag handles into / out of a
   hillside. For a clean mouth, place endpoint anchors slightly
   *below* the terrain surface and middle anchors well below the
   peak — the cylinder cap should land buried in air past the
   hillside (use *End extend* to push it further out).
2. Set dimensions:
   - *Radius* (8 m) — interior radius. 16 m diameter is comfortably
     arcade-sized.
   - *Wall* (1 m) — extra radius on the cutter beyond the interior,
     i.e. the apparent thickness of the concrete liner at the mouth.
   - *Samples* (32) — arc-length subdivisions of the curve.
   - *Sides* (14) — radial segments per ring.
   - *End extend* (4 m) — distance the cutter pushes past the curve
     endpoints along the tangent. Ensures the cap clears the
     hillside surface.
3. **Build Tunnel** samples the curve, emits the cutter +
   interior shell, and ensures the terrain's Boolean modifier
   targets the cutters collection. Re-builds pick the next free
   `tunnel_NN` slot — to author multiple tunnels, manually rename
   `tunnel_curve_main` between builds.

`tracks-src/template-tunnel-island.blend` is the reference scene —
three mountains with a tunnel through each, AI-completable racing
line that threads all three.

### Anti-grav surfaces

Curve-driven anti-grav segments — corkscrew climbs, wall-rides,
caldera loops, Möbius torch arms, ceiling runs. Same authoring shape
as the Tunnel tool: shape a Bezier, hit Build, the surface mesh +
entry/exit zone empties materialise together.

Three cross-section profiles cover every v1 anti-grav case:

- **Tube** — closed cylinder along the curve. Corkscrews climbing a
  pillar, caldera loops, anything fully enclosed. Mirrors the tunnel
  tool's cylinder sweep — 8 m default radius matches the tunnel
  default so anti-grav tubes feel sibling-scale.
- **Ribbon** — flat strip (width × thickness). Wall-rides, the
  Liberty torch underside, half-pipe lips. The strip is geometry-only;
  authors rotate the curve to stand the ribbon up (wall) or hang it
  upside-down (ceiling).
- **Banked strip** — slab whose per-sample tilt comes from the curve's
  per-control-point `tilt` field (the same tilt the road tool reads
  for banking). Set tilt = ±π/2 for a wall, ±π for a ceiling, anything
  in between for a banked corner. Same Edit-Mode N-panel → Item →
  Tilt slider as the road tool, plus the Anti-Grav preset operators
  on the Gameplay sub-panel (Flat / Bank L / Wall R / Ceiling).

Workflow:

1. **Add Anti-Grav Curve** drops a 4-point `antigrav_curve_NN` Bezier
   at the 3D cursor (Z-up, AuthoringKind — never exported). Tab into
   edit mode to drag handles into the path you want.
2. Pick the **Profile** in the panel. For Tube, set *Radius* + *Sides*;
   for Ribbon / Banked strip, set *Width* + *Thick(ness)*. *Samples*
   controls arc-length density (48 reads smooth on single-loop curves;
   bump for long corkscrews).
3. **Build Anti-Grav Surface** sweeps the cross-section along the
   curve using a parallel-transport (rotation-minimising) frame so the
   cross-section doesn't flip mid-corkscrew. Output:
   - `antigrav_NN_surface` — swept mesh, `kind=track` so the runtime
     trimesh collider attaches. `anti_grav=true` extras flag it.
   - `antigrav_NN_zone_entry` + `antigrav_NN_zone_exit` — oriented
     box empties at the two curve endpoints, `kind=antigrav_zone`,
     local +Y pointing along the curve tangent so the bike enters
     the volume on approach. The existing anti-grav zone system in
     `antigrav.py` (and the runtime controller) handles the actual
     gravity flip when a bike crosses the zone.
4. Re-clicking Build on the same curve rebuilds the surface + zones
   in place — to add a second segment, click Add Anti-Grav Curve
   first. Each curve owns its outputs via `antigrav_surface_name` /
   `antigrav_zone_entry_name` / `antigrav_zone_exit_name` custom
   props on the curve, so a delete + re-build wipes the right ones.

`tracks-src/template-antigrav-showcase.blend` is the reference
scene — one tube corkscrew climbing a pillar, one ribbon wall-ride,
one banked-strip loop. Open it for a working example of all three
profiles together.

### Ramp tool

Drop a parametric stunt-ramp wedge at the 3D cursor, tagged
`kind=track` with `mat_track_ramp`. Curved (smoothstep) or linear
kicker profile. The mesh has a 30 cm foundation depth so the wedge
is always a closed solid — no degenerate top/bottom coplanar quads.

To align the ramp to the road's tangent at placement, set the 3D
cursor's rotation around Z before clicking **Add Ramp** (or move /
rotate after placement with G / R). Each ramp gets a fresh
`ramp_NN` name so repeated drops don't stomp prior ones.

### Downtown

Drops a procedural city block at the 3D cursor — a parented
`downtown_NN` empty + a flat plinth + a grid of placeholder
building boxes. Buildings carry `kind="track"` so the runtime
trimesh-collider attaches; the bike can rake through streets and
slap into towers.

Each building's four footprint corners are raycast onto the largest
visible `kind="track"` mesh. The base seats at the **highest**
corner; the mesh extends a downhill skirt below z=0 to bury the low
side in the slope. Result: SF-style "buildings step into the hill"
look, no floating stilts.

The plinth is a block-aligned subdivision grid with two material
slots — `mat_track_downtown_sidewalk` (light concrete, slot 0)
under building lots, `mat_track_downtown_road` (dark asphalt, slot
1) on the inter-block strips. Per-face material indices, single
mesh, no z-fight.

Knobs:
- *X / Y* (6 / 6) — block grid extent.
- *Block / Street* (30 / 8 m) — block edge length + inter-block gap.
- *Min h / Max h* (18 / 80 m) — per-building height range.
- *Seed* — deterministic layout.
- *Conform to terrain* (default on) — turn off for legacy flat
  behaviour (single-quad plinth, all buildings at z=0).

`tracks-src/template-downtown.blend` is the reference scene —
Miami-flat valley, Nob-Hill-style 56 m grade, Telegraph-Ridge
78 m grade with 31 m building skirts.

### Spawn terrain in an existing scene

A few operators drop a fresh terrain mesh into the current scene without
needing a fresh `.blend` template:

- **Add Multi-Biome Terrain (Style menu).** Hoverbike → Add → *Multi-Biome
  Terrain* (or Terrain submenu). Spawns the unified `HV_TemplateTerrain`
  modifier — the wrapper that bundles all four styles. A **Style** menu in
  the modifier panel (Properties → Modifier) swaps the heightfield between
  **Island / Alpine / Dunes / Mesa**; the scene gets every style's driver
  empties (4 peak pairs, 2 ridge pairs, 1 oasis, 4 mesas) so each style is
  ready to reshape. This is the in-app equivalent of
  [`tracks-src/template-terrain.blend`](../tracks-src/template-terrain.blend),
  layered into your existing scene. Refuses to overwrite an existing
  `terrain` object; reuses any style node groups already present (no
  `.001` duplicates). Mod zones work when Style = Island.

  > **Additive toggle.** The modifier's `Additive` checkbox is an
  > *only-raise* pass — it clamps each style's displacement to `max(0, z)`
  > so nothing dips below the input plane. It defaults **off**: leave it
  > off and the seafloor / canyon floor / oasis basin (all negative Z)
  > render normally. Turning it on flattens all sub-sea geometry to `z=0`
  > — it's a hook for a future style-stacking mode the wrapper doesn't do
  > yet (today the Style menu evaluates one style at a time). If your
  > seafloor looks squashed, this toggle is on.

- **Add Island Terrain (procedural).** Hoverbike → Add → *Island
  Terrain* (or Terrain submenu). The single-biome version: spawns a
  1024×1024 m subdivided plane (~150 k verts) with the `HV_Island`
  Geometry-Nodes modifier and four default peak control empties (one
  central volcano with crater, two flanking, one submerged shoal) — the
  same procedural setup
  [`tracks-src/template-island.blend`](../tracks-src/template-island.blend)
  ships with, but layered into your existing scene. Refuses to overwrite
  an existing `terrain` object; reuses any `HV_TemplateIsland` /
  `HV_PeakProfile` node groups already in the .blend (no `.001`
  duplicates). After it finishes, the new terrain is selected so the
  Terrain N-panel opens automatically. (Carries the same `Additive`
  toggle, same off-by-default behaviour.)

- **Import Heightmap.** Read a greyscale PNG/EXR and emit a subdivided
  plane whose verts are luminance-displaced. The output mesh
  `terrain_heightmap` is tagged `kind=track` and ships as collidable
  terrain at export. Configure *Size (m)*, *Subdiv*, *Δz (m)*, and
  *Base z* on the panel; the file picker remembers the last imported
  path. Re-import replaces the previous heightmap mesh idempotently.

### Terrain sculpt

A small toolset for shaping the terrain after the procedural template
has been baked. Workflow:

1. **Apply Terrain Modifiers** — bakes `HV_Island` (or any other
   active modifier) into vertex data. One-way: parametric tunability
   of the GN sliders is lost in exchange for sculptable verts. Save
   first.
2. **Subdivide Terrain** — one cut per click (each face → 4) for when
   the procedural mesh is too coarse to add detail.
3. **Sculpt Terrain** — selects the terrain and switches into Blender's
   Sculpt Mode. From there: Draw, Smooth, Flatten, Inflate, Grab,
   Crease — Blender's stock brushes work as expected once the
   modifier stack is empty.
4. **Raise / Lower @ cursor** — bulk-shape operator. Set *Radius (m)*
   and *Δz peak (m)*; click to apply with smoothstep falloff from
   the 3D cursor. Faster than brush strokes for large hills / basins.
5. **Smooth Terrain** — Laplacian-Z pass over every vertex. *Iters*
   and *Weight* control the bite; XY positions stay locked so the
   heightfield stays a heightfield.

### Vertex bakes (AO + path-worn)

The seeded `HV_*` Geometry-Nodes graphs sample two FLOAT attributes —
`baked_ao` and `baked_path` — and stamp them into `COLOR_0.G` (AO
multiplier) and `COLOR_0.B` (racing-line wear) on the evaluated
mesh. The runtime terrain shader reads both: AO darkens cavities;
path-worn mixes the diffuse toward the per-track `pathTint`, drawing
a visible groove along the AI spline. See
[vertex-attribute-spec.md](./vertex-attribute-spec.md) for the locked
channel contract.

Both are stamped by the *Vertex bakes* section of the Terrain sub-
panel:

1. **Bake AO + Path Wear** — Cycles vertex-colour bake for AO
   (~10-20 s on a 150 k-vert terrain) plus the path-wear pass below.
   Run once after the terrain shape settles.
2. **Bake Path-Worn** — just the racing-line mask. Pure-Python KDTree
   (~1 s on a 150 k-vert terrain); cheap to re-run while iterating
   on the three knobs:
   - *Inner (m)* — distance from the spline at which wear saturates
     at 1.0. Default 0 — full wear on the line itself.
   - *Outer (m)* — distance beyond which wear is 0. Smoothstep
     falloff in between. Default 8 m.
   - *Intensity* — final-value multiplier in [0, 1]. 0 disables the
     stamp (useful for tracks whose biome shouldn't show a worn line —
     tunnel interiors, anti-grav stretches); 1 stamps the full mask.

The export operator auto-bakes path-worn before writing the GLB, so
authors who never touched these knobs still ship with a baked
racing line at the scene defaults. The bake is idempotent: same
inputs always produce the same stamps. Distance is computed in
world XZ against the AI spline polyline, so the wear band tracks
the bike's racing footprint even on hills where the spline floats
above the terrain.

### Horizon

A per-track distant-horizon silhouette mesh — the cylinder of "distant
mountains" the runtime camera-locks to the player so the far field
has a tangible shape instead of an empty fog gradient.

**Default behaviour.** Tracks without an authored horizon mesh get a
procedural seeded ring (`createHorizonRing` in
[horizon-ring.ts](../src/engine/render/horizon-ring.ts)) — five-octave
layered-sine cylinder, 192 segments, seed hashed from the track id so
every track is distinct without authoring. Knobs (`radius`,
`peakHeight`, `seed`, `silhouetteDark`) round-trip through
`public/tracks/<id>.json`'s `horizon` block; tune them from the
addon's Horizon sub-panel when you don't need a hand-shaped silhouette.

**Authoring a bespoke silhouette.** Click **Add Horizon Ring** in the
Horizon sub-panel. The addon drops a `horizon_ring` mesh at the world
origin using the same layered-sine starter the runtime uses (so your
viewport reads as the in-game default until you start pushing verts).
Tab into edit mode, turn on Proportional Editing (`O`), and pull verts
into your track's recognisable skyline — Skytree behind Shibuya,
Table Mountain behind Cape Town, the Manhattan grid behind Liberty.
The runtime extracts the mesh from the exported GLB and feeds its
positions into the camera-locked ring shader; the silhouette
re-projects the player's view but the shape is yours.

Workflow:

1. **Add Horizon Ring** — drops `horizon_ring` (tagged `kind=horizon`,
   192 × 2 verts) at origin. Knobs above the button choose starter
   shape (Segments / Radius / Peak / Seed) before you commit.
2. **Edit Horizon Ring** — selects the mesh and enters edit mode.
   The runtime ignores everything below `y ≈ peak` of the bottom
   edge; the visible silhouette is what's above the water-line.
3. **Reset Horizon Ring** — destructive re-seed of the starter. Lose
   your edits, get a fresh procedural layout. Use when you want to
   pick a different seed.
4. **Delete Horizon Ring** — removes the mesh; the track falls back
   to the procedural fallback on the next export.

The mesh exports as part of the normal track GLB; the runtime GLB
loader's first pass extracts every `kind=horizon` node out of the
scene graph before terrain shading or collider attach, so the ring
costs the same single draw call regardless of whether it's procedural
or authored.

**Precedence on load.** The runtime picks the silhouette source in
this order:

1. `kind=horizon` mesh in `environmentGlb` (Blender-authored)
2. `horizon` block in `public/tracks/<id>.json` (procedural with
   per-track overrides)
3. Default procedural with seed hashed from the track id

The track JSON's `silhouetteDark` always applies, and `peakHeight`
contributes as a `heightT` normalisation reference when an authored
mesh ships — useful if your authored peaks reach further than the
default 300 m and you want the shader's haze gradient to span the
full silhouette.

### Sky preset

A per-track sky / atmosphere block in `public/tracks/<id>.json` that
the runtime applies once at boot. All fields are optional — absent
fields fall back to the defaults baked into `sky.ts`.

Knobs live in the addon's **Sky preset** sub-panel (between Horizon
and Waves, default-closed):

| Knob | Meaning | Runtime impact |
|---|---|---|
| `tint` | Hex colour multiplied onto the dome palette. White = no tint. | Live — biases palette warm/cool without rewriting ramps. |
| `cloudiness` | 0..1 cloud-layer density. | Live — drives the FBM cloud mask threshold. |
| `sunIntensity` | Multiplier on the directional sun + sun-disc. | Live — scales `DirectionalLight.intensity` and shader sun disc. |
| `fogNear` / `fogFar` | Exponential fog distances (m). | Live — the horizon ring sits ~75 % through this range. |
| `timeOfDay` | 0..360 s along the (frozen) day-night cycle. | Live — picks elevation + azimuth at construction; held for the race. |
| `colorGrade` | LUT preset name from the bundled set. | Live — per-preset (tint × saturation × contrast) tweak on the dome. |
| `bloom` | 0..2 intensity multiplier on the renderer bloom pass. | **Round-trip only** — no bloom pass is wired into the WebGPU renderer yet. The value ships through authoring + JSON and the runtime logs it; goes live when the post pipeline lands. |
| `seaStateBeaufort` | 0..12 Beaufort wind scale. | Live — scales every base wave amplitude at boot via `beaufortToAmplitudeScale` (Beaufort 4 ≈ 1.0×, glass-calm 0 ≈ 0.15×, hurricane 12 ≈ 2.5×). Wave-zones layer on top via `heightMult`. |

**Bundled `colorGrade` presets** (each is a (tint × saturation ×
contrast) triple in `SKY_GRADE_TABLE` in
[sky.ts](../src/engine/render/sky.ts)):

| Preset | Look |
|---|---|
| `neutral` | No grade — identity. |
| `miami_pastel` | Soft warm-pink lift, lower saturation; South Beach sunset. |
| `tokyo_neon` | Cool magenta-cyan lean, punchy saturation; Shibuya night. |
| `big_sur_golden` | Golden-hour warmth; California / The Maw mid-day. |
| `venice_warm` | Adriatic warm-stone amber; Doge's Drift. |
| `nyc_sunset` | Strong warm tint, high contrast; Liberty finale. |
| `cape_town_blue` | Atlantic cool blue, desaturated haze. |
| `kilauea_volcanic` | Ash + lava red lift, high contrast. |

The preset list is mirrored in two places:
`SKY_COLOR_GRADES` in [types.ts](../src/game/tracks/types.ts) (with
its lookup table in [sky.ts](../src/engine/render/sky.ts)) on the
runtime side, and `SKY_COLOR_GRADES` in
`tools/blender/hoverbike_addon/sky_preset.py` on the addon side.
Adding a preset means editing both — there's no auto-sync yet.

**Round-trip.** The sky block is fully Blender-owned: any value the
.blend dialled in wins over what's in the JSON on next export. The
`load_post` handler in `handlers.py` pulls the JSON back into the
scene props on `.blend` open, so opening a track always reflects the
most recently saved values.

### Audio palette

Per-track audio is the one bucket that **lives only in the JSON** —
music is licensed/commissioned (not procedural) and ambient beds are
layered loops from a shared SFX bank, so there's no Blender side to
this block. Hand-edit `public/tracks/<id>.json` (or write through the
in-app editor when the audio sub-panel ships).

Block shape:

```jsonc
{
  "audio": {
    "music": "south-beach-vaporwave.opus",
    "ambient": ["gulls.opus", "surf-light.opus", "neon-hum.opus"],
    "ambientGains": [0.4, 0.6, 0.2],
    "music3dEffects": { "duckOnPump": 0.35 }
  }
}
```

Paths target `public/audio/music/` and `public/audio/ambient/`. The
runtime loads each file lazily on track boot; **missing files (404)
warn and fall back gracefully** — the procedural pad bed shipped at
horizon time stays as the music fallback whenever `audio.music` is
absent or unreachable, so a track can ship its full schema before the
licensed assets land. `ambientGains[i]` defaults to 1.0 when omitted;
`music3dEffects.duckOnPump` is a multiplier on the engine's base
0.35 pump-duck depth (1.0 = unchanged).

### Track hero render

Every ship-quality track ships with two pieces of UI art:

- A **1280×720 hero image** for the loading screen, written to
  `public/assets/tracks/<id>-hero.jpg`.
- A **320×180 tile thumbnail** for the track-select grid, written to
  `public/assets/tracks/<id>-thumb.jpg`.

Both are produced from a single author-controlled camera in the
.blend — no Photoshop, no Playwright screenshots, no per-track
scripts. The render is reproducible, fast (sub-second EEVEE renders
typical on a modern GPU), and auto-fires on every track export so the
UI art never drifts from the latest .blend.

**Author the shot.** Park the 3D cursor where you want the hero
camera to sit, then click **Add Camera Hero** in the *Track hero
render* sub-panel. The addon drops a Camera object named
`camera_hero` at the cursor (`AuthoringKind.CAMERA_HERO`) with a 50 mm
lens, aimed at a sensible default target (`start_00`, the AI-spline
mid-point, or the world origin if neither exists). Translate / rotate
the camera to frame the track's set-piece exactly how you want the
loading-screen tile to read — this is the one shot the player sees of
this track between menu and grid, so make it postcard-worthy.

**Trigger the render.** Click **Render Hero** in the same sub-panel
to render the full 1280×720 hero + the 320×180 tile in one shot, or
**Tile only** to refresh just the smaller image after a framing tweak.
The render engine is forced to EEVEE for speed (Cycles is overkill
for a loading-screen tile and would slow the export hook down by a
factor of 20-50×). The JPGs land in `public/assets/tracks/` and
the track's `manifest.json` entry gains a `heroUrl` field (and a
`thumbUrl` field if the tile was rendered too) pointing at the
public URL.

**Automatic on export.** *Export Track to Game* fires the hero render
automatically after the GLB write succeeds. If `camera_hero` is
missing, the export warns ("no camera_hero — track exported without a
hero image") and continues — the hero render is non-fatal so a
mid-authoring .blend without a hero still exports successfully. To
disable the auto-render, delete the `camera_hero` object.

**Batch / CI render.** The standalone script
[`tools/blender/render_track_thumbnail.py`](../tools/blender/render_track_thumbnail.py)
runs the same render headlessly without going through the addon UI —
useful for CI batch builds that need to refresh every track's hero in
one pass:

```bash
"$BLENDER_EXE" --background tracks-src/<id>.blend \
    --python tools/blender/render_track_thumbnail.py
```

Exits non-zero if the .blend lacks a `camera_hero` or the repo root
can't be resolved, so a CI loop over the `tracks-src/*.blend` glob
can gate on `$?` and fail the build if a track is missing its hero
camera.

**Runtime story.** The runtime never sees the camera — the GLB
exporter is invoked with `export_cameras=False`, so `camera_hero`
(and any other Camera object) is stripped before the GLB lands in
`public/assets/tracks/`. The chase cam is procedural; the hero
camera is an authoring-only `AuthoringKind` whose only job is to
frame the loading-screen JPG.

### Particle emitters

A unified emitter abstraction drives every authored track VFX —
wave-pump flash, lava steam, neon glare, gull flocks, palm sway,
torch flame, oxidation shimmer, jungle motes, container rust, tsunami
spray, anything else. The runtime (`createParticleSystem` in
[particle-system.ts](../src/engine/render/particle-system.ts)) reads
`kind=emitter` empties from the loaded GLB and spawns particles from
their pose using a shared 1024×1024 atlas split into a 4×4 grid of
16 cells.

**Author a new emitter.** In the addon's *Emitters* sub-panel, click
**Add Emitter**. The new `emitter_NN` empty drops at the 3D cursor
with default extras and the SPHERE display type. Position with G,
aim with R — the empty's **local +Y axis** is the emission direction.

**Tweak in custom properties** (N-panel → Object → Custom Properties):

| Extra | Default | Meaning |
|---|---|---|
| `atlas_cell` | 0 | 0..15 — picks a 256×256 sprite from the shared atlas |
| `emit_rate` | 30 | particles spawned per second |
| `lifetime_s` | 1.5 | seconds before a particle is recycled |
| `velocity_cone_deg` | 25 | half-angle of the emission cone around local +Y |
| `speed_min` / `speed_max` | 0.8 / 2.5 | uniform-random initial speed (m/s) |
| `size_start` / `size_end` | 0.4 / 1.2 | world-space sprite size, lerped over age |
| `color_start` / `color_end` | white→white(alpha 0) | RGBA, lerped over age |
| `gravity` | 0 | Y-axis acceleration (m/s²). 0 = drift, negative = fall, positive = rise |
| `max_particles` | 256 | per-emitter cap contributed to the cell pool |

**Atlas cell legend** (mirrored in
[`build_sprite_atlas.py`](../tools/blender/build_sprite_atlas.py) and
the addon panel):

| Cell | Sprite | Typical use |
|---|---|---|
| 0 | soft round spark | wave-pump flash, generic shine |
| 1 | smoke puff | lava steam, container fire, exhaust haze |
| 2 | ember | torch flame, hot debris |
| 3 | foam droplet | water spray, tsunami crests |
| 4 | dust mote | jungle motes, ash drift, sun-haze |
| 5 | gull silhouette | gull flocks |
| 6 | leaf | palm sway debris, jungle floor swirl |
| 7 | neon glare | Shibuya neon, lighthouse beam |
| 8 | ash | Kilauea ashfall |
| 9 | water spray | breaking wave plumes |
| 10 | glow halo | bell ripple, oxidation shimmer |
| 11 | motion streak | speed lines |
| 12-15 | spare | aliased to 0/1/2/3; safe to override later |

**Regenerate the atlas** with `pnpm gen:fx-atlas` (calls
`python tools/blender/build_sprite_atlas.py`). Pillow is the only
dependency. Output: `public/assets/fx/particle-atlas.png`.

**Cost.** One `SpriteNodeMaterial` + `InstancedMesh` per *cell* (not
per emitter), so two `dust_mote` emitters on the same track share a
draw call. The system caps at 16 cells × `max_particles` particles,
typically well under 2000 alive at peak.

**Runtime trigger hook.** Gameplay code can fire one-off bursts via
`window.__particles.triggerBurst('emitter_name', count)`. The
`fx/index.ts` explosion path already does this — name an emitter
`emitter_explosion` in the track and every detonation triggers a
24-particle burst from that pose (lava chunks for Kilauea, glass for
Cape Town aquarium, etc).

### Water (sea level + preview)

Sea level is a scene-wide value — the *Sea level (m)* slider in the
Water sub-panel (scene prop `hoverbike_water_height`). Scrub the
slider; the wave preview's mesh follows on the next debounced rebuild
and the value rides out as `water.height` in the JSON. JSON-reload
writes back to the same scene prop.

The legacy `water_volume_main` empty is **optional now** — it's only
useful for overriding `wave_height` / `wave_freq` custom props per
track. Its transform is no longer load-bearing for sea level.
`.blends` saved before this change migrate lazily — the first
read after open promotes a legacy volume's Z into the scene prop, so
existing tracks export the same height they always did.

<a id="wave-rider-buoys"></a>
### Wave-rider buoys

Marker buoys are placed procedurally along the racing line wherever
the spline crosses open water — same Gameplay sub-panel toggles as
before (*Auto buoys*, *Spacing (m)*, *Offset ×gw*). The mesh you see
in Blender is the gizmo; the buoys that actually spawn at runtime
are wave-rider asset props that float on the wave surface and react
to bike impacts (see [`src/game/components/wave-rider.ts`]).

Two artifacts ship per buoy:

- **Authoring preview** — `gate_buoys` mesh inside the
  `_hoverbike_buoy_preview` collection (auto-excluded from the GLB
  by the standard `_hoverbike_*_preview` scrub). The preview is
  purely visual; no `kind` tag, no runtime presence.
- **Runtime placements** — emitted into a new top-level
  `waveRiderBuoys[]` array in the exported track JSON. Each entry
  is `{position, rotation}` in three.js coords. The runtime's
  json-loader synthesises asset Props (`assetId='buoy'`, unit size)
  from the array, so the rest of the engine treats them as ordinary
  wave-riders — no special-casing downstream.

`waveRiderBuoys` is in `BLENDER_OWNED_JSON_KEYS`, so every re-export
replaces the whole list (the editor never authors these directly).
Inland tracks with no water authoring emit no entries — the
`has_water` gate honours `hoverbike_water_height ≠ 0`,
`water_volume_main`, **and** `water_preview`.

The buoy GLB itself comes from the asset-prop pipeline
([`specs/props/buoy.json`](../specs/props/buoy.json) → kit-part
`buoy` in `prop_kit.blend` → `public/assets/props/buoy.glb`). Retune
the buoy silhouette by editing the constants in
[`tools/blender/seed_buoy_kit_part.py`](../tools/blender/seed_buoy_kit_part.py)
and re-running the seed + `pnpm gen:props` chain.

<a id="float-any-prop"></a>
### Float any prop on waves (per-instance)

Buoys/logs above float because their *asset* is tagged a wave-rider. To
float **any** placed asset prop — a wrecked boat, a crate, a container —
**per instance** (so the same asset can be static in one spot and bobbing
in another), tag the **placement**, not the asset, in the **Prop
Placements** panel:

1. **Import Prop Placements** (Hoverbike → Prop Placements) to pull the
   track's `props[]` into the `_hoverbike_props_preview` collection as
   movable instances of their shipping GLBs.
2. Select the prop instance(s) you want floating.
3. In the panel's **Float on Waves** box, tick **Float**, pick a
   **Motion** mode, and click **Apply Float to Selected**.
4. **Write Prop Placements → JSON** to persist it.

This stamps `props[i].waveRider` in the track JSON. At runtime the
placement becomes a kinematic body that tracks the swell using **the
prop's own collider** (not a substituted buoy cylinder), resting at the
height you placed it. Spring/tilt feel is auto-derived from the
collider's size, so a big hull bobs slower and tips less than a cork. To
unfloat, untick **Float** and re-apply, then write.

**Motion (degrees of freedom):**

- **Heave + tilt** (`dof: "locked"`, default) — vertical bob + pitch/roll
  with the wave normal; the prop holds its authored heading and XZ.
- **+ Yaw** (`dof: "yaw"`) — also yaws gently with the swell.

Free horizontal motion (a dynamic, shoveable float) is **planned** — it
needs a dynamic body rather than the current kinematic one. **Ramps**
become floatable once authored as asset-prop GLBs (rather than baked
`kind=track` geometry) — still a follow-on. Tuning the float feel is best
done by eye on a water track or in the `?waveriders=1` scene
([`src/game/components/wave-rider.ts`](../src/game/components/wave-rider.ts)
`deriveWaveRiderTuning`).

<a id="floating-gates"></a>
### Floating gates

Checkpoint gates can ride the swell too. In the Hoverbike panel's **Gates**
section, tick **Float gates on waves** (scene prop `hoverbike_float_gates`,
round-tripped as the track-level `floatGates` in the JSON). At runtime, on
that track:

- Each gate that sits **over water** bobs vertically on the wave surface at
  its own XZ (visual only). Gates raised onto dry structures — base more
  than `GATE_FLOAT_WATER_BAND_M` (4 m) above the water line — **stay static**
  ("auto-off over land"), so a gate on a bridge or rooftop doesn't bob.
- The **crossing trigger stays put** and is **widened** vertically by the
  wave amplitude, so a bike passing through at any wave phase still
  registers ("oversized static trigger"). See `gateFloatsOnWaves`
  ([`src/game/tracks/gate-float.ts`](../src/game/tracks/gate-float.ts)) —
  one predicate shared by the render bob and the trigger so they agree.

It's a track-wide toggle (no per-gate authoring); "over land" gates opt
themselves out automatically. Motion is strictly vertical (heave) by design.

### Boost pads

Drop a `boost_NN` empty at the 3D cursor with **Add Boost Pad**. The
empty's local +Y axis (Blender forward) is the boost direction; rotate
around Z to aim. A cyan-emissive slab is parented under the empty as
a viewport gizmo (lives in `_hoverbike_boost_pad_preview` so it's
scrubbed at export — the runtime builds its own visual via
`makePadHelper`).

Custom properties on the empty (defaults match the in-app editor):
- `half_width` (3.0 m) — extent across the pad
- `half_depth` (6.0 m) — extent along the boost direction
- `strength` (1.5) — top-speed multiplier on overlap

Boost pads round-trip through `boostPads[]` in the JSON. The JSON
merge respects opt-in: if the .blend has any `boost_NN` empties,
Blender owns the list; otherwise the in-app editor's placements
stay through re-exports.

### Wave zones

Drop a `wave_zone_NN` empty at the 3D cursor with **Add Wave Zone**
(under the *Wave zones* sub-panel). The empty's local +X axis is the
dominant swell direction; rotate around Z to aim it, and scale the
extents via the custom properties. The child box gizmo renders as
**wireframe** so overlapping zones / busy scenes stay readable.

Each zone scales the global Gerstner wave field inside its oriented
bounding box. Custom properties (defaults in parentheses):

- `half_width` (30 m) — half-extent along local +X (the swell axis)
- `half_height` (20 m) — half-extent along local +Z (vertical; mostly
  cosmetic — surface samples ignore the vertical extent)
- `half_depth` (30 m) — half-extent along local +Y
- `height_mult` (1.5) — multiplier on global wave amplitude
- `freq_mult` (1.0) — multiplier on per-wave frequency (shorter
  wavelengths → choppier; longer → rolling swell)
- `blend_radius_m` (20 m) — soft-edge falloff outside the OBB face
  so the boundary isn't visible

Optional extras — add these directly in the Properties panel when you
need them:

- `direction_deg` — override the dominant swell bearing, degrees in
  world XZ. 0° = +X swell train, 90° = +Z. Leave unset to inherit
  the global wave bearing.
- `surge_period_s` + `surge_amplitude` — additive periodic surge,
  `surge_amplitude · max(0, sin(2π·t / surge_period_s))`. Useful for
  the Aqualand-style tsunami timer: set period to 12 s and amplitude
  to 4 m for a slow, rising wave wall. Both fields must be set
  together — half a surge spec is rejected by the JSON validator.

Multi-zone overlap uses a soft-max on the multipliers (loudest zone
wins) plus additive accumulation on surges — see `sampleZoneFactors`
in `src/engine/sim/water/wave-field.ts`.

Wave zones round-trip through `waveZones[]` in the JSON. Like boost
pads, the merge is opt-in: if the .blend has any `wave_zone_NN`
empties, Blender owns the list.

### Gate / racer / water previews

These are render-disabled gizmo collections (`_hoverbike_*_preview`).
They never reach the GLB export.

- **Gate preview** instances the real `prop_gate_mesh` from
  `tracks-src/props-library.blend` at every `gateSpacing` step along
  `ai_spline_main`. Adjust *Spacing*, *Half-width*, *Height* on the
  panel — the gates rebuild live as you scrub.
- **Racer preview** drops a bike silhouette at `start_00` plus one per
  AI slot loaded from `specs/grid-offsets.json` — same file the
  runtime reads.
- **Water preview** builds a wave-displaced plane at the current
  *Sea level* (`hoverbike_water_height`) using the same Gerstner
  waves the runtime uses. The collection is reused across rebuilds
  so its Outliner collapse state survives debounced changes.

### Ghost lap + chase cam

**Rebuild Ghost Lap** binds a bike silhouette to `ai_spline_main` via
a Follow Path constraint, attaches a chase camera with Track-To, and
sets the scene's frame range to one full lap at *Target speed (m/s)*.
Hit Spacebar in the viewport to fly the lap; the chase cam becomes
the scene's active camera so view-from-camera frames the bike.

### Auto-rebuild

A persistent `depsgraph_update_post` handler watches `ai_spline_main`,
`start_00`, and `water_volume_main`. Edits to any of them schedule a
debounced (~200 ms) rebuild of the matching preview collections, so
the gates, turn-indicator chevrons, racer grid, and water plane
follow source edits without manual rebuilds. The `update=` callbacks
on the spacing / curb / wave-time scene props go through the same
scheduler, so scrub interactions are also live.

### Reload JSON & manifest sync

- **Reload from JSON** pulls scalar fields from
  `public/tracks/<id>.json` into the scene custom properties — gate
  spacing, terrain shader, water knobs, and the `start_00` pose.
  Runs automatically on `.blend` open (via the addon's `load_post`
  handler) so the edit-in-app → reopen-in-Blender loop is seamless.
- **Export Track to Game** rewrites the JSON merging Blender-owned
  fields (`environmentGlb`, `water`, `terrainShader`, `aiSplines`,
  `gateSpacing`, `start`) onto whatever the editor last saved, and
  upserts the track's entry into `public/assets/manifest.json` so
  the in-game level picker surfaces the track. Existing manifest
  entries for other tracks and any hand-edited `displayName` are
  preserved.

## Object kinds reference

| Kind | Naming pattern | Required Blender type | Required `extras` |
|---|---|---|---|
| Track surface | any name; material starts `mat_track_*` | mesh | (none — collidable by default) |
| Decoration | any name | mesh | `{ kind: "decoration" }` (opt out of collider) |
| Water volume | `water_volume_*` | empty (cube) | `{ kind: "water", wave_height, wave_freq }` |
| Checkpoint | `cp_NN` (zero-padded, contiguous from 0) | empty | `{ kind: "checkpoint", index, half_width, height }` |
| AI spline | `ai_spline_main` (or `ai_spline_alt_*`) | NURBS curve | `{ kind: "ai_spline", branch }` |
| Pickup spawn | `pickup_*` | empty | `{ kind: "pickup_spawn" }` |
| Player start | `start_NN` (zero-padded, NN = grid position) | empty | `{ kind: "start", index }` |
| Boost pad | `boost_NN` (zero-padded) | empty | `{ kind: "boost_pad", half_width, half_depth, strength }` |
| Anti-grav zone | `antigrav_NN` (zero-padded) | empty | `{ kind: "antigrav_zone", half_width, half_height, half_depth }` |
| Wave zone | `wave_zone_NN` (zero-padded) | empty (cube) | `{ kind: "wave_zone", half_width, half_height, half_depth, height_mult, freq_mult, blend_radius_m, [direction_deg, surge_period_s, surge_amplitude] }` |
| Horizon ring | `horizon_ring` (singular) | mesh | `{ kind: "horizon" }` |
| Particle emitter | `emitter_NN` | empty | `{ kind: "emitter", atlas_cell, emit_rate, lifetime_s, velocity_cone_deg, speed_min, speed_max, size_start, size_end, color_start, color_end, gravity, max_particles }` |

## Coordinate system

- **Y is up** in both glTF and three.js. Blender authors with Z up but
  the exporter passes `export_yup=True` so the converted file matches.
- **+Z is forward**. The bike's mesh has its yellow fin pointing +Z and
  red tail light at -Z.
- **Scale: 1 Blender unit = 1 metre.** Don't change scene units. Bikes
  are roughly 2.5m long.

## Hidden objects are skipped

Toggling the **eye icon** off in the outliner (or hiding a whole
collection) excludes that object from the export entirely — GLB,
validation, and JSON derivation all filter on `visible_get()`. This
lets you park WIP geometry, alternate spline branches, or reference
empties in a hidden collection without breaking the
contiguous-checkpoint or single-`ai_spline_main` checks. Want it
back? Toggle the eye on and re-export.

(Render-only hide — the camera icon — does **not** affect this. The
export always uses viewport visibility.)

## Known limitations

- **Trimesh colliders — tunneling fixed in M9.27 via CCD + slab
  surfaces.** `attachTrackColliders` registers a static Rapier trimesh
  per `kind=track` mesh with double-winding indices. Pre-M9.27 a
  fast-falling capsule could tunnel through a 0-thickness plane on its
  first downward step. Two fixes:
    1. `createBike()` now sets `setCcdEnabled(true)` on the dynamic
       rigid body — Rapier's swept-shape Continuous Collision
       Detection catches fast bodies before they punch through.
    2. Spec-driven track surfaces (`pnpm gen:tracks`) author a 1m-thick
       slab instead of a flat plane. Hand-authored Blender tracks
       should follow the same convention — give your `kind=track`
       meshes real volume.
  E2E coverage: `tests/e2e/m9-trimesh-tunneling.spec.ts` autoplays a
  full lap on `?track=test-ring` (a slab-surface ring) and asserts
  the bike never falls below the slab's bottom face.
- **No mesh-loaded track collider variation.** Every `kind=track` mesh
  gets the same friction (0.6) and restitution (0.05). Per-material
  parameter passthrough is a future improvement.
- **No camera/light export.** The runtime always uses its own chase
  camera and lighting. Cameras and lights in the .blend are stripped at
  export time.
- **Single AI spline branch supported by AI controller.** You can author
  `ai_spline_alt_*` branches and they'll round-trip through the loader,
  but the AI controller only follows the `main` branch right now.

## Troubleshooting

**`<obj>: missing custom property 'kind'`** — You named an object using
one of the recognised patterns (`cp_*`, `pickup_*`, etc.) but didn't set
its `kind` custom property. Object Properties → Custom Properties → New
→ name `kind`, type String, value `checkpoint` (or whichever).

**`<obj>: kind='X' does not match name pattern (expected 'Y')`** — Name
and kind disagree. Either rename the object or fix the kind.

**`<cp>: index=N does not match position N+1`** — Checkpoint indices
must be contiguous starting at 0. If you delete `cp_02`, also rename
`cp_03..cp_NN` to close the gap, or your race won't lap.

**`ai_spline_main: needs at least 2 points`** — The exporter sampled the
NURBS curve and got nothing. Make sure your curve actually has control
points and that its `resolution_u` (Object Data → Active Spline) is
non-zero.

**`missing required object: ai_spline_main`** — Every track must have
an AI spline named `ai_spline_main` (the canonical racing line). Branch
splines like `ai_spline_alt_*` don't satisfy this.

**Track loads but nothing's visible at runtime.** Check that the mesh's
material name starts with `mat_track_*`. The runtime relies on this for
nothing right now (the kind property is what matters), but it's the
authoring convention and future passes may key off it.

**Bikes fall straight through the loaded mesh.** This is the trimesh
broadphase issue — see [Known limitations](#known-limitations). The
safety floor and water surface will catch them.

## CI lint

The same lint that the *Lint Track* button runs in-editor also runs
headless in CI. PRs that touch `tracks-src/`, `tools/blender/`, or
`specs/` trigger the `asset-pipeline` workflow, which loops over every
`tracks-src/*.blend` (skipping the asset libraries — `props-library`,
`landmarks-library`, `calibration`) and fails the build on any ERROR.

Run it locally with:

```bash
pnpm gen:tracks:validate
```

It calls `tools/blender/run-lint.mjs`, which spawns one background
Blender per track and pipes `tools/blender/lint_track.py` against it.
Output is one `[lint:<trackId>] ERROR|WARNING: <message>` line per
finding. Exit code 1 if any track has at least one ERROR.

Checks the CI lint covers beyond the in-editor pass:

- `start_01` presence (in-editor lint only checks `start_00`).
- `cp_NN` index contiguity by *name* (not just by `index` extra).
- Every `kind=track` mesh has positive evaluated area.
- Every `wave_zone_NN` empty has positive half-extents on all three
  axes and a positive `height_mult`.
- At least one `pickup_*` exists (warning, not error — tutorial tracks
  may legitimately omit pickups).

If a CI lint failure looks spurious, repro locally with
`pnpm gen:tracks:validate` — same script, same exit code.

## See also

- [`specs/tracks/calibration.json`](../specs/tracks/calibration.json)
  + [`tools/blender/build_track.py`](../tools/blender/build_track.py)
  — the spec-driven fixture builder. Run `pnpm gen:tracks` to rebuild
  `tracks-src/calibration.blend` and the GLB. Replaces the legacy
  `tools/build_calibration_scene.py` (deleted in 2026-05).
- [`tools/export_track.py`](../tools/export_track.py) — the export +
  validation script.
- [`src/game/tracks/glb-loader.ts`](../src/game/tracks/glb-loader.ts)
  — sim-side loader. Reads the .glb's JSON chunk manually (Three-free)
  and builds a `Track`.
- [`src/engine/render/glb-track.ts`](../src/engine/render/glb-track.ts)
  — render-side loader. Wraps Three's GLTFLoader.
- [`src/game/tracks/cliffside.ts`](../src/game/tracks/cliffside.ts)
  — procedural reference layout. Each piece of code maps 1:1 to an
  object you'd author in Blender (the file's docstring is the mapping
  table).

## Scattered props (Item 4)

The export pipeline now emits `EXT_mesh_gpu_instancing` for Geometry
Nodes scatter output. A track with 800 palms costs roughly what 1 palm
costs in mesh memory and draw-call count, plus a per-instance transform
buffer.

### Authoring convention

1. Put a top-level **Empty** in the scene named `scatter_<zone>` (e.g.
   `scatter_palms`, `scatter_rocks`). The instance output of the GN
   tree must be a child of this Empty. Blender's exporter restricts
   `EXT_mesh_gpu_instancing` to children of an Empty, so the parent
   matters.
2. Attach a **Geometry Nodes** modifier on a mesh child of that Empty.
   The graph's final output uses `Instance on Points` (with a
   prop-collection input) or `Realize Instances` *off* — instances
   must remain as instances all the way to export, not be flattened
   into mesh data.
3. Source props: link a Collection from `tracks-src/props-library.blend`
   (per Item 3) or any local collection. Drop it in via Geometry Nodes'
   `Collection Info` node in **Instance** mode.

The four export sites (`tools/export_track.py`,
`tools/blender/common.py`, and the two Hoverbike-addon operators) all
pass `export_gpu_instances=True` and `export_gn_mesh=True`. No
per-track flag toggle needed.

### Runtime behaviour

- **Render side**: Three.js's stock `GLTFLoader` recognises the
  extension and produces `THREE.InstancedMesh` nodes automatically.
  Castshadow / receiveShadow / frustum culling all work natively.
- **Collider side**: scattered instances are **render-only by
  default**. `attachTrackColliders` in `src/engine/render/glb-track.ts`
  skips `InstancedMesh` so the prototype's transform isn't accidentally
  registered as a single misplaced collider. The intended pattern: if
  a designer needs collidable scatter, the asset's `kind` extra opts
  in (currently a TODO — collidable scatter isn't wired yet; raise it
  in a Linear ticket when first needed).

### Sanity check

After an export, the produced `.glb` should contain
`"extensionsUsed": ["EXT_mesh_gpu_instancing", ...]` in its JSON chunk.
The `parseGlbJson` helper used by `glb-loader.ts` reads that field
directly. Quick verification from a unit test:

```bash
node -e 'import("./tools/blender/inspect_glb.mjs").then((m) =>
  m.inspect("public/assets/tracks/<id>.glb"))'
```

If the extension isn't emitted, the most common cause is the scattered
output sitting outside an Empty parent — re-parent and re-export.

## Biome palette scatter

A whole-terrain scatter that **reads the painted biome map** and routes
points into per-biome prop collections. One palette per track, no
per-zone empties to place — drop the modifier on the scene, pick a
source collection + density for each biome, and the GN graph fills the
terrain by reading `baked_biome` / `baked_path` / `baked_ao` off the
terrain mesh. Pairs with the [terrain coloration flow](#vertex-bakes-ao--path-worn).

### Authoring loop

1. **Paint the biome** — run *Apply Terrain Vertex Colors* on the
   terrain (Hoverbike → Terrain → Bake to vertex colors). This stamps
   `COLOR_0` plus a sibling `baked_biome` FLOAT attribute the scatter
   GN graph reads. World-Z thresholds map verts to deep / seafloor /
   beach / jungle buckets.
2. **Add the palette** — Hoverbike → Add → *Biome Palette Scatter*
   (or click *Add Biome Palette Scatter* in the sidebar's Biome scatter
   sub-panel when the terrain is selected). Drops a singleton
   `scatter_biome_palette` Empty + `scatter_biome_palette_surf` Mesh,
   attaches the `HV_BiomePalette` modifier from the props library, and
   binds the modifier's *Terrain* socket to the selected mesh.
3. **Tune from the sidebar** — selection-driven sub-panel surfaces when
   you have the terrain or either palette object active. Per-biome
   rows: pick a source collection from the props library, set density
   per m². Globals: size jitter, path-wear avoidance, AO floor, seed.
4. **Iterate** — every panel change is a live modifier-socket write, so
   the viewport re-evaluates immediately. No refresh button.
5. **Export** — *Export Track to Game* picks up the InstanceOnPoints
   output via `EXT_mesh_gpu_instancing` (same path as `HV_Scatter`).
   The surf mesh is `kind=decoration` so the runtime doesn't try to
   collide with it; the scattered instances are render-only.

### Per-biome rows

The four biome buckets correspond to `baked_biome ∈ {0, 1/3, 2/3, 1}`:

| Biome | Z band (default) | Typical sources |
|---|---|---|
| Deep | `z < -22` | (usually empty — open water) |
| Seafloor | `-22 ≤ z < 0` | `prop_kelp_strand`, debris, mooring bollards |
| Beach | `0 ≤ z < 4` | `prop_palm` (sparse), driftwood, beach ball |
| Jungle | `z ≥ 4` | `prop_palm`, `prop_fern_clump`, `prop_mossy_boulder` |

The Z thresholds are the same ones [`apply_terrain_vertex_colors`](#vertex-bakes-ao--path-worn)
writes into `COLOR_0.A`. Adjust them on the bake operator before
re-baking if a track has a different waterline / treeline.

### Density tuning

Densities are **per m² of terrain face area**, *not* per scatter zone
like the legacy `HV_Scatter` zones. A 1 km² terrain at the default
0.005 jungle density gives ~5000 palms — sparse forest, viewport
handles smoothly. Crank up for crowded foliage, drop for sparse
coastlines. As a rule of thumb:

| Density | Reads as |
|---|---|
| 0.001 | scattered, mostly empty |
| 0.005 | sparse forest (default) |
| 0.02 | dense canopy |
| 0.05+ | wall-of-trees |

### Path-wear avoidance + AO gate

Two global gates apply on top of biome routing:

- **Path Wear Avoid** (0..1, default 1.0) — multiplier on
  `COLOR_0.B`'s contribution. At 1.0, vertices the racing line crosses
  (where `baked_path` ≈ 1) get zero density — palms automatically
  clear the bike's path. At 0, path-wear is ignored.
- **AO Floor** (0..1, default 0.0) — smoothsteps point density up from
  `baked_ao = AO Floor` to `baked_ao = 1.0`. Set to 0.4 to drop
  scatter from deep cavities; leave at 0 for no AO filtering.

Both gates re-evaluate live with the bake (the path-wear bake auto-fires
on spline edits, so moving the racing line slides the scatter "no-go"
band along with it).

### Paint masks — fine-tune the biome palette

The palette gives you a baseline keyed to painted biome. **Paint masks
are a delta layer on top** for the cases where the baseline is mostly
right and you want to suppress or thin scatter in a specific area —
clear a sight line, thin out the start grid, kill the palm that's
poking through your sky-box mountain.

Each biome row has its own vertex group on the terrain:
`mask_deep`, `mask_seafloor`, `mask_beach`, `mask_jungle`. They're
created automatically at weight 1.0 on every vertex when you add the
palette, so **unpainted terrain scatters exactly what A produces**.
The GN graph multiplies each biome's per-face density by its mask
attribute before sampling Distribute Points:

```
density(prop, v) = biome_density × in_biome(v) × mask(v)
                                              × path_wear_keep(v) × ao_keep(v)
```

**Author flow:**

1. Click **Edit mask** on the biome row you want to suppress. The
   addon switches to Weight Paint with the right group already
   active.
2. **Paint to taste.** Subtract brush (`Ctrl` + click while in Weight
   Paint, or pick from the brush settings) paints down — weight 0 =
   "no scatter here," weight 0.5 = "half density." Add brush paints up
   if you over-corrected.
3. **Tab** in the viewport to return to Object Mode. The scatter
   re-evaluates immediately.
4. To switch biomes mid-paint, click **Edit mask** on a different row —
   no need to exit paint mode first; the active group swaps under you.
5. **Clear** resets a row's mask to 1.0 everywhere (undo all paint for
   that biome).

**Tradeoffs vs. paint-on-COLOR_0.A:**

- Masks suppress *within* A's biome routing — they can thin or remove
  scatter from a biome that's already there, but they can't *put*
  palms onto a beach (that requires repainting `COLOR_0.A`). For the
  rare "stick a palm in this exact spot" case, run Apply Terrain
  Vertex Colors with different thresholds, or hand-place a single
  prop instance.
- Masks are per-biome-row, not per-prop. If the same prop is assigned
  to multiple biome rows (e.g. palms in both Beach and Jungle),
  suppressing palms in an area needs both `mask_beach` and
  `mask_jungle` painted there. Usually moot — biome buckets are mostly
  disjoint by world-Z so each vertex belongs to exactly one row.
- Default brush is Add mode (raises weight toward 1). Set it to
  Subtract in the brush settings to paint *down* from the default 1.0.

### Comparison with `HV_Scatter` zones + scatter strokes

| | `HV_Scatter` (per-zone) | `HV_BiomePalette` (whole-terrain) | `HV_StrokeScatter` (curve) |
|---|---|---|---|
| Coverage | One rectangular zone | The whole terrain | Ribbon along a Bezier curve |
| Where authored | `scatter_NN` empties | Singleton palette empty | `scatter_<prop>_stroke_NN` curve |
| Filter | Geometric (slope, altitude) | Painted biome (`COLOR_0.A`) | Curve shape + Width |
| Path-wear gate | ❌ ignored | ✅ via `baked_path` | ❌ v1 (TODO) |
| AO gate | ❌ ignored | ✅ via `baked_ao` | ❌ v1 |
| Paint suppression | ❌ all-or-nothing | ✅ per-biome paint masks | n/a (curve is the boundary) |
| Live edit | ❌ manual refresh | ✅ panel writes modifier sockets | ✅ curve edit |

All three ship through `EXT_mesh_gpu_instancing` and coexist on the
same track. Typical layering: palette gives "the whole island gets
foliage" with B masks for local tweaks; strokes spike density along
hand-shaped paths for groves, rock piles, driftwood lines, etc. The
legacy zone tool stays as an escape hatch.

### Verifying the scatter

A smoke-test script lives at
[`tools/blender/_smoke_biome_palette.py`](../tools/blender/_smoke_biome_palette.py).
Run it against any `tracks-src/<id>.blend` to:

1. Run the vertex-color bake (populates `baked_biome`).
2. Add the biome palette (drops the empty/surf pair + modifier and
   initialises the four `mask_*` vertex groups at weight 1.0).
3. Evaluate the modifier and count instances.
4. Paint `mask_jungle = 0` on half the verts and re-evaluate, asserting
   the instance count drops by roughly half (Proposal B regression).

```bash
"$BLENDER_EXE" --background tracks-src/<id>.blend \
    --python tools/blender/_smoke_biome_palette.py
```

Expected output ends with `PASS: biome palette smoke test`. A zero
instance count means either `baked_biome` is missing on the terrain
(rerun *Apply Terrain Vertex Colors*) or no biome row has a non-zero
density × source combo set.

## Scatter strokes (Proposal C)

Bezier curves the author draws through the area they want populated.
Each stroke is **additive** — it composes on top of whatever the
biome palette already produces in that region, so use it to *spike*
density along a curve (a palm grove, a rock pile, a driftwood line at
the water's edge) without re-tuning the whole biome.

### Authoring a stroke

1. **Add** — *Hoverbike → Add → Scatter Stroke (curve-bounded grove)*.
   The Add operator dialog picks a **prop** (palm / rock / driftwood /
   buoy), a **width** (perpendicular half-extent, default 8 m), and a
   **density** (per m² of ribbon area, default 0.1). Drops a triplet
   at the 3D cursor:
   - `scatter_<prop>_stroke_NN` — Empty (organiser).
   - `scatter_<prop>_stroke_NN_curve` — 4-anchor Bezier with a gentle
     starter bend (~12 m long).
   - `scatter_<prop>_stroke_NN_surf` — single-vertex mesh hosting the
     `HV_StrokeScatter` modifier. Reads the curve via Object Info; its
     own mesh data is irrelevant.
2. **Shape** — the operator selects + activates the curve, so press
   `Tab` and drag handles in Edit Mode. The scatter re-evaluates live
   via the existing depsgraph debounce timer.
3. **Conform to terrain** *(optional, manual for v1)* — add a
   **Shrinkwrap modifier** to the curve (Properties → Modifiers →
   Add → Shrinkwrap, Target = your terrain mesh, Wrap Method = Project,
   Project Axis = -Z) and the curve's evaluated geometry follows the
   terrain shape without altering the authored control points.
4. **Tune** — selecting any of the three stroke objects surfaces the
   *Scatter stroke* sub-panel with the modifier's sockets (Source,
   Width, Density, Size min/max, Seed). All live-edit.

### What the GN graph does

```
curve  ─── Curve to Mesh (Profile = Line of length 2 × Width) ──→ flat ribbon
ribbon ─── Distribute Points on Faces (Density)               ──→ point cloud
points ─── Instance on Points (Collection Info, Pick Instance)──→ instances
                + random Z rotation + random uniform scale
```

The ribbon orientation follows the curve's normal — when the curve
lies flat (in the XY plane, or shrinkwrapped to terrain), the ribbon
lies flat and instances stand up naturally.

### Multiple strokes

Each Add operation gets a fresh `_NN` per prop type, so
`scatter_palm_stroke_00`, `scatter_palm_stroke_01`, … coexist. Strokes
are independent — own modifier, own Source, own knobs. Adding a rock
stroke doesn't affect the palm stroke's distribution.

A stroke's *Source* socket isn't locked to the name's prop — author
can swap a `scatter_palm_stroke_*` to instance buoys instead by
changing the modifier's Source. The naming is mnemonic, not
constraining.

### Verifying strokes

A second smoke-test script lives at
[`tools/blender/_smoke_scatter_stroke.py`](../tools/blender/_smoke_scatter_stroke.py).
Runs `hoverbike.add_scatter_stroke` twice (palm + rock) and confirms
each emits a non-zero instance count and that adding the second
stroke doesn't perturb the first.

```bash
"$BLENDER_EXE" --background tracks-src/<id>.blend \
    --python tools/blender/_smoke_scatter_stroke.py
```

### Known limitations (v1)

- **No path-wear gate.** The biome palette filters scatter off the
  racing line via `baked_path`; strokes don't yet. Workaround: shape
  the curve to avoid the racing line. Adding the gate is a small
  follow-up (Raycast node sampling `baked_path` at each projected
  point).
- **No biome filter.** A stroke crossing a beach/jungle boundary
  scatters its prop on both sides. Same workaround as above (shape
  the curve), or split into two strokes.
- **No bespoke Snap-to-Terrain** for stroke curves. The existing
  `hoverbike.snap_curve_to_terrain` operator is hard-bound to
  `road_curve_main`; Shrinkwrap modifier on the curve is the
  workaround for v1.

## Procedural props library (Item 3)

`tracks-src/props-library.blend` is a shared library of procedural
track props, registered as Blender Assets so authors can drag them
into any track `.blend` from the Asset Browser.

Five prop kinds ship in the seeded library:

| Catalogue            | Collection            | Geometry                                | Live knobs (HV_Prop modifier) |
|---|---|---|---|
| Track Props/Rocks    | `prop_rock`           | Distorted icosphere, FBM displacement   | Size, Jaggedness, Noise Scale, Seed |
| Track Props/Palms    | `prop_palm`           | Tapered trunk + radial fronds           | Scale (shape/frond-count regen by re-running the seed) |
| Track Props/Buoys    | `prop_buoy`           | Pylon + skirt + emissive top cap (legacy decoration asset; runtime wave-rider buoys ship via the asset-prop pipeline — see [Wave-rider buoys](#wave-rider-buoys) below) | static (no GN modifier; edit verts to retune) |
| Track Props/Gates    | `prop_gate`           | Two posts + crossbar at 28m × 6m gizmo dimensions | static |
| Track Props/Indicators | `prop_turn_indicator` | Flat chevron (+X = bend direction)   | static |

Each collection is marked as a Blender Asset with a description, tags,
and a catalogue assignment. Every mesh carries `COLOR_0` per the
[vertex-attribute spec](./vertex-attribute-spec.md): the palm stamps a
linear sway gradient in `R` (trunk base → leaf tip); rocks / buoys /
gates / indicators carry terrain defaults (R=1, G=1, B=0, A=0) with
the buoy's top-cap ring tagged `A=1` so the runtime emissive material
can read its glow strength from the attribute.

Material naming follows the runtime convention: `mat_foliage_palm`
opts the palm into the foliage sway shader at load time
([`foliage-sway.ts`](../src/engine/render/foliage-sway.ts)); the rest
use `mat_prop_*` and render statically.

### One-time setup

1. Run the seed once to produce the library:
   ```bash
   "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \
     --background --python tools/blender/seed_props_library.py
   ```
   Writes `tracks-src/props-library.blend` and
   `tracks-src/blender_assets.cats.txt`. Re-running nukes any
   hand-edits — treat the .blend as the source of truth after the
   first run, and re-tune in Blender via the modifier panel.
2. Register `tracks-src/` as an asset library: in Blender, Edit →
   Preferences → File Paths → Asset Libraries → Add… and pick the
   `tracks-src/` folder. Name it "Hoverbike" (or anything).

### Authoring loop

1. Open your track `.blend` (e.g. `tracks-src/<id>.blend`).
2. Open an Asset Browser editor (split a viewport or use the *Asset
   Browser* workspace). Select the Hoverbike library and the
   *Track Props* catalogue.
3. Drag a prop into the viewport. Blender drops it in as a
   **Collection Instance** — a single Empty whose `instance_collection`
   points at the source library. The geometry isn't copied; subsequent
   re-seeds will refresh every instance.
4. Position / scale the instance. Each instance is independent.
5. Re-export the track via the addon's *Export Track to Game* button.
   Instances export as separate scene nodes; if many props sit under
   an Empty named `scatter_<zone>`, they become
   `EXT_mesh_gpu_instancing` instances (see [Scattered props](#scattered-props-item-4)).

### Using props with the scatter pipeline

Every prop collection has a `scatter_source = True` custom property,
so a Geometry Nodes graph can use them as instance sources directly:

```
Object Info (the terrain mesh)
  → Distribute Points on Faces
  → Instance on Points
    └─ Collection Info (Instance mode, Reset Children OFF) ─ pick `prop_palm`
  → Realize Instances OFF
  → (output to a mesh child of `scatter_palms` Empty)
```

The result rides through the export as one `EXT_mesh_gpu_instancing`
node with N transforms, so a track with 800 palms costs roughly what
1 palm costs in mesh memory.

### Aesthetic polish — deferred to GUI work

The seeded geometry is *functional* placeholder. Per the wishlist's
"scaffold + hand off" guidance, real PBR materials, sculpted rock
silhouettes, palm-leaf textures, and per-prop preview thumbnails are
all left for hand tuning in Blender. Iterate the .blend directly; just
don't re-run `seed_props_library.py` afterwards unless you want a
nuke-and-pave.

## Procedural island template (Item 1)

`tracks-src/template-island.blend` ships with a live Geometry Nodes
modifier that procedurally generates a volcanic-tropical heightfield
inspired by St. Lucia: shear-tilted cones for lopsided volcanoes,
optional summit craters, continental shelves descending to a deep-
water floor, cone-masked erosion noise, and a low-amplitude global
background noise field. The seeded file also runs the addon's water-
preview helper so a wave-displaced water surface is visible from the
moment you open it.

### Per-peak controls — base + top empty pair

Each volcanic peak uses **two empties**:

| Empty | Visual | Encoded fields |
|---|---|---|
| `peak_NN_base` (SPHERE, Z-flattened) | Footprint ring at sea level | `location.xy`: peak centre in world XY. `scale.x`: base radius (m). `scale.z` is held at 0 so the wireframe sphere reads as a horizontal great circle. |
| `peak_NN_top` (SPHERE) | Apex / summit | `location` (offset from base via a *Copy Location* constraint): apex XY-offset and Z height. `scale.z`: crater flag (0/1). |

Drag the **base** empty to move the entire island — the *Copy Location*
constraint drags the top along. Drag the **top** empty to slide the
apex sideways (producing a lopsided cone) or push it up (taller peak).
Toggle `scale.z` between 0 and 1 on the top to carve a summit crater.

The constraint approach (vs. parenting) avoids the scale-inheritance
issue that would otherwise propagate `base.scale.x = radius` into the
child's position.

### Forking the template for a new island track

1. **Copy** `tracks-src/template-island.blend` to
   `tracks-src/<your-id>.blend` and open it.
2. **Reposition / retune peaks** as described above. Up to 8 pairs
   supported (`Base 0`..`Base 7`, `Top 0`..`Top 7`); unbound slots are
   inert.
3. **Tune global knobs** in the modifier panel (Properties → Modifier
   → HV_Island):

   | Knob | Default | Purpose |
   |---|---|---|
   | Shelf Depth | -25 m | Deep-water floor |
   | Shelf Radius | 200 m | How far offshore the shelf descends from each coast |
   | Reef Inset | 20 m | Distance from coast to centre of reef ring |
   | Reef Height | 0 m | Reef pulse amplitude (default off — dial up if you want fringing reefs) |
   | Reef Width | 25 m | Reef Gaussian σ |
   | Cone Erosion | 12 m | Per-cone noise amplitude (slope gulleys / outcrops). Mask-driven by cone contribution — zero off the cone. |
   | Erosion Scale | 0.035 | Erosion noise frequency (smaller = larger features) |
   | Roughness Above | 2 m | Global background-noise amplitude above water |
   | Roughness Below | 1 m | Global background-noise amplitude below water |
   | Noise Scale | 0.008 | Global noise frequency |
   | Noise Seed | 0 | Re-roll for variation |

4. **Apply the modifier** when the silhouette reads right. Object →
   Convert → Mesh, then add the standard track furniture on top:
     - Update or delete the starter `ai_spline_main` curve to follow
       your racing line. After the first *Rebuild Gate Preview* /
       *Rebuild Turn Indicators* click, both previews auto-follow the
       spline as you edit it — control-point moves and spacing
       changes trigger a debounced rebuild (~0.2 s) so the gates and
       chevrons slide along with the curve.
     - Place gates either by editing `cp_NN` empties or hitting the
       addon's *Rebuild Gate Preview* button after setting
       `gateSpacing` on the track JSON.
     - Move `start_00` / `start_01` to your grid (see *Starting line*
       below if you want them re-derived from the spline).
     - Adjust `water_volume_main`'s extents if needed.
5. **Export** via the addon's *Export Track to Game* — identical
   pipeline to every other track.

### Starting line — sampled from the spline

`start_00` / `start_01` are placed by sampling `ai_spline_main` at
arc-length parameter `START_T` ∈ [0, 1] (default 0.0 = first anchor).
The two starts spawn perpendicular to the spline tangent, 4 m apart
(`START_GRID_SPACING_M`), both facing along the racing line.

To shift the starting line further down the loop, edit `START_T` near
the top of `tools/blender/seed_template_island.py` and re-seed. Each
start carries its `start_t` value as a custom property so you can read
it back from the .blend.

To pin the starts at hand-authored positions instead, just move them
in the viewport after the seed runs — they're plain `ARROWS` empties
once placed.

### Re-seeding the template from scratch

If the bundled `template-island.blend` is ever lost or you want a
clean reset, regenerate it via the seed script:

```bash
"C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \
  --background --python tools/blender/seed_template_island.py
```

This writes `tracks-src/template-island.blend` from scratch, including
the GN graph (parent + `HV_PeakProfile` sub-group, ~90 nodes total) and
the starter scene with the water-preview plane already rebuilt.

### Vertex attribute contract

The GN graph stamps `COLOR_0` on the terrain per the
[Item 6 spec](./vertex-attribute-spec.md):

| Channel | Meaning | Stamped value |
|---|---|---|
| R | Sway | `0` (terrain doesn't sway) |
| G | AO multiplier | `1` (placeholder — real AO bake is a GUI pass) |
| B | Path-worn mask | `0` (filled later when the racing line is painted) |
| A | Biome index | `0` deep (z < -22) / `0.33` sandy seafloor (-22 ≤ z < 0) / `0.67` beach (0 ≤ z < 4) / `1.0` jungle (z ≥ 4) |

The biome thresholds are intentionally tuned so that most underwater
terrain reads as **sandy seafloor**, with deep-blue only appearing at
the very deepest shelf floor (near the map corners where no peak's
shelf shallows the depth). Water *surface* colour is the runtime
water shader's responsibility, not this material's.

### Known limitations

- **8 peak-pair cap.** Going past 8 requires editing the GN graph to
  add more sub-group instances. Author who wants ≥9 peaks: open
  `HV_TemplateIsland`, duplicate one of the inner sub-group instances,
  wire it through another `MAX` node in the cascade, and add `Base 8`
  / `Top 8` Group Inputs.
- **Lopsided cone is a one-iteration shear, not exact.** Strong apex
  offsets (top empty pushed far from the base centre) read as
  visually tilted but aren't geometrically a true slanted cone. The
  approximation is good enough for typical St. Lucia-style apex shifts.
- **Steep volcanic slopes may not be drivable.** Cone sides above
  ~40° are too steep for the hover controller in some directions.
  Hand-flatten saddles where the racing line crosses ridges.
- **Trimesh count is ~150 k tris** at default 384² subdivision.
  Comfortable for Rapier but on the heavy end for static colliders.
  Reduce `SUBDIV` in the seed script if you need a lighter file.
- **Material is placeholder.** The vertex-color biome ramp is set
  dressing — author a real shader with sand/jungle textures keyed off
  `COLOR_0.A` as the next polish pass.

