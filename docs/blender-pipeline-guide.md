# Track authoring pipeline

A track has two sources, edited in two different tools, joined at runtime:

- **`public/tracks/<id>.json`** — gameplay data (gates, AI spline, pickup
  spawns, boost pads, start pose, water tuning). Authored in the **in-app
  editor** (`?track=<id>&edit=1`); saved by clicking *Save*. Hand-editable
  if you prefer.
- **`public/assets/tracks/<id>.glb`** *(optional)* — environment geometry
  the bike collides with. Authored in **Blender**, exported with the
  standard glTF exporter or the `tools/export_track.py` script.

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

## TL;DR — the 30-second workflow

```bash
# 1. Author. Open the calibration scene as a starting template.
"C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" tracks-src/calibration.blend

# 2. Save your track as a new .blend in tracks-src/
#    (e.g. tracks-src/my-track.blend)

# 3. Export. The script validates conventions; non-zero exit on any error.
HOVERBIKE_OUTPUT=public/assets/tracks/my-track.glb \
  "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \
  --background tracks-src/my-track.blend --python tools/export_track.py

# 4. Wire it into the runtime (one line in src/main.ts — see below).

# 5. Playtest:
pnpm dev    # http://localhost:5191/?track=my-track
```

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
and is rebuilt by `tools/build_calibration_scene.py`.

### 3. Build your layout

A real track typically needs:

- **Track surfaces.** One or more meshes for whatever the bike drives on.
  Material name should start with `mat_track_*`. Set custom property
  `kind = "track"` on the object. The runtime registers a static Rapier
  trimesh collider for each (see [Limitations](#known-limitations) for
  the broadphase caveat).
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

```bash
HOVERBIKE_OUTPUT=public/assets/tracks/my-track.glb \
  "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \
  --background tracks-src/my-track.blend --python tools/export_track.py
```

If validation passes you'll see something like:

```
[export] validating C:\...\my-track.blend
[export] baked ai_spline_main: 49 sampled points
[export] writing C:\...\public\assets\tracks\my-track.glb
[export] done
```

If it fails the script prints the offending objects and exits non-zero —
fix the .blend, re-run.

### 5. Wire into the runtime

The runtime currently has a hard-coded URL-param → track mapping in
`src/main.ts`. To add `?track=my-track`, find the block that resolves
the track id and add a branch:

```ts
const trackId =
  rawTrack === 'cliffside'
    ? 'cliffside'
    : rawTrack === 'calibration'
      ? 'calibration'
      : rawTrack === 'my-track'
        ? 'my-track'                    // ← new
        : 'lagoon'

// …later, in the track-build switch:
} else if (trackId === 'my-track') {
  const loaded = await loadGlbTrackVisuals('/assets/tracks/my-track.glb')
  scene.add(loaded.scene)
  attachTrackColliders(loaded.scene, phys)
  track = buildTrackFromGltf(loaded.parsedJson, {
    id: 'my-track',
    name: 'My Track',
    lapsToFinish: 3,
  })
}
```

Eventually we'll want a track registry so this is data-driven. For now,
inline branches.

### 6. Playtest

```bash
pnpm dev    # http://localhost:5191/?track=my-track
```

Hit `T` to enable autoplay and watch the AI follow your spline. Use
[Backspace] to respawn at start_00 if a bike gets stuck.

## Object kinds reference

| Kind | Naming pattern | Required Blender type | Required `extras` |
|---|---|---|---|
| Track surface | any name; material starts `mat_track_*` | mesh | `{ kind: "track" }` |
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

## Known limitations

- **Trimesh colliders are best-effort.** `attachTrackColliders` registers
  a static Rapier trimesh per `kind=track` mesh, with double-winding
  indices so it's normal-direction-independent. `world.castRay` against
  it returns the expected hit, but Rapier 0.19's broadphase can let a
  fast-falling capsule tunnel through on its first downward step. Until
  that's resolved (likely via `setCcdEnabled(true)` on dynamic bodies +
  thicker collider geometry), the safety floor + universal water surface
  are the load-bearing colliders. Don't ship a track that depends on
  trimesh colliders for non-fatal correctness yet.
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

- [`tools/build_calibration_scene.py`](../tools/build_calibration_scene.py)
  — the fixture builder. Recreates `tracks-src/calibration.blend` from
  scratch; useful as a code reference for what each metadata setup
  looks like programmatically.
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
