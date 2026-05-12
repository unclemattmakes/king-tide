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

After the first export the JSON is the source of truth for gameplay
placement. Re-exporting from Blender refreshes the GLB but **never
overwrites** the JSON unless you Shift-click the button (or toggle
*Overwrite JSON* in the operator's redo panel). That way edits made
in the in-app editor — placing pickups, sliding gates along the
spline, retuning water — survive subsequent Blender exports.

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
| `peak_NN_base` (CIRCLE) | Footprint at sea level | `location.xy`: peak centre in world XY. `scale.x`: base radius (m). |
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
       your racing line.
     - Place gates either by editing `cp_NN` empties or hitting the
       addon's *Rebuild Gate Preview* button after setting
       `gateSpacing` on the track JSON.
     - Move `start_00` / `start_01` to your grid.
     - Adjust `water_volume_main`'s extents if needed.
5. **Export** via the addon's *Export Track to Game* — identical
   pipeline to every other track.

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

