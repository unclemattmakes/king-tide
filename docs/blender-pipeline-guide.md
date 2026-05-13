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
  hovering above.
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
- **A water volume.** Empty cube (Add → Empty → Cube). Name
  `water_volume_main`, custom props `kind = "water"`, `wave_height =
  1.0`, `wave_freq = 0.5`. The runtime applies the wave field over the
  scene; bikes hover on water wherever there's no track surface above
  them.
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

In Blender, press **N** to open the sidebar, switch to the **Hoverbike**
tab, and click **Export to Game**. The addon prints to Blender's info
bar:

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

## Authoring tools (Hoverbike sidebar)

Press **N** in the 3D viewport, switch to the **Hoverbike** tab. The
panel re-renders based on whether the `.blend` lives in `tracks-src/`
(track mode) or `bikes-src/` (bike mode). This section covers the track
authoring tools, top to bottom.

### Spline tools

- **Snap Spline to Terrain** raycasts each control point of
  `ai_spline_main` straight down onto the scene, then lifts each
  hit by *Hover (m)*. Pairs with the live gate preview — after a
  terrain edit, snap the spline back onto the new surface and the
  gates follow. Preview collections (`_hoverbike_*_preview`) are
  hidden during the cast so gizmos can't catch the ray.

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
3. F1 curbs (optional — set *Curb w* = 0 to disable):
   - *Curb w* (0.6 m) and *Curb h* (0.12 m) — width and rise of each
     side strip.
   - *Stripe (m)* (2.0) — length of each red / white stripe along the
     road.
4. **Build Road** samples the curve, conforms the terrain to the
   sampled altitude in a `width/2 + curb_width + blend_radius` band,
   then emits the road mesh tagged `kind=track` with materials:
   - `mat_track_road` (asphalt, slot 0)
   - `mat_track_curb_white` (slot 1)
   - `mat_track_curb_red` (slot 2)

**Active modifiers on terrain.** Geometry-Nodes graphs (the
`HV_Island` template, Displace, Subsurf, etc.) override raw vertex
edits and can stack their displacement on top of the road tool's
flatten, producing terrain spikes through the road. The operator
errors out by default; toggle *Apply modifiers first* in the redo
panel to bake the modifier into the source mesh before deforming.
This is one-way — you lose parametric tunability of the procedural
template once it's applied, so save the .blend first.

### Ramp tool

Drop a parametric stunt-ramp wedge at the 3D cursor, tagged
`kind=track` with `mat_track_ramp`. Curved (smoothstep) or linear
kicker profile. The mesh has a 30 cm foundation depth so the wedge
is always a closed solid — no degenerate top/bottom coplanar quads.

To align the ramp to the road's tangent at placement, set the 3D
cursor's rotation around Z before clicking **Add Ramp** (or move /
rotate after placement with G / R). Each ramp gets a fresh
`ramp_NN` name so repeated drops don't stomp prior ones.

### Heightmap import

Read a greyscale PNG/EXR and emit a subdivided plane whose verts are
luminance-displaced. The output mesh `terrain_heightmap` is tagged
`kind=track` and ships as collidable terrain at export. Configure
*Size (m)*, *Subdiv*, *Δz (m)*, and *Base z* on the panel; the file
picker remembers the last imported path. Re-import replaces the
previous heightmap mesh idempotently.

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
- **Water preview** builds a wave-displaced plane around
  `water_volume_main` using the same Gerstner waves the runtime uses.

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

## Procedural props library (Item 3)

`tracks-src/props-library.blend` is a shared library of procedural
track props, registered as Blender Assets so authors can drag them
into any track `.blend` from the Asset Browser.

Five prop kinds ship in the seeded library:

| Catalogue            | Collection            | Geometry                                | Live knobs (HV_Prop modifier) |
|---|---|---|---|
| Track Props/Rocks    | `prop_rock`           | Distorted icosphere, FBM displacement   | Size, Jaggedness, Noise Scale, Seed |
| Track Props/Palms    | `prop_palm`           | Tapered trunk + radial fronds           | Scale (shape/frond-count regen by re-running the seed) |
| Track Props/Buoys    | `prop_buoy`           | Pylon + skirt + emissive top cap        | static (no GN modifier; edit verts to retune) |
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

