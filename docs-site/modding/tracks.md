# Authoring tracks

Tracks are the most complex of the three asset categories — they pair gameplay data (gates, AI spline, pickups, start pose) with optional environment geometry (cliffs, mesas, hand-modeled props). There are two intended workflows:

| Workflow | Source of truth | Best for |
|---|---|---|
| **Spec-driven** | `specs/tracks/<id>.json` | Calibration-style declarative tracks with axis-aligned slabs and analytic AI splines. |
| **Editor-driven** | `public/tracks/<id>.json` (live-edited via `?edit=1`) | Everything else — anything where you want to drag gates / spline anchors visually. |

Mixing the two is fine: you can author a base spec, build the GLB, then live-edit the gameplay JSON in the editor. Once tuned in the editor, the spec is no longer the source of truth for gate / spline placement.

## Spec-driven authoring

For declarative, calibration-style tracks. Spec → Blender headless → GLB + gameplay JSON.

```bash
# 1. Copy an existing spec
cp specs/tracks/test-ring.json specs/tracks/sandbar.json

# 2. Edit it — see "Spec format" below

# 3. Build
pnpm gen:tracks
#    → public/assets/tracks/sandbar.glb           (environment geometry)
#    → public/tracks/sandbar.json                 (gameplay data — gates, spline, pickups)
#    → tracks-src/sandbar.blend                   (for follow-up Blender authoring)

# 4. Try it in-game
open http://localhost:5191/?track=sandbar
```

::: warning Existing JSON is preserved by default
`pnpm gen:tracks` won't overwrite an existing `public/tracks/<id>.json` — once you've tuned a track in the in-app editor, the spec is no longer the source of truth for placement. To force-overwrite, set `HOVERBIKE_FORCE_GAMEPLAY_JSON=1`.
:::

### Spec format

```json
{
  "$schema": "../_schema/track.json",
  "id": "test-ring",
  "displayName": "Test Ring",
  "lapsToFinish": 3,
  "surface": {
    "size": [60, 60]
  },
  "water": {
    "center": [0, 0, 0],
    "extents": [120, 120, 4],
    "waveHeight": 0.6,
    "waveFreq": 0.4
  },
  "checkpoints": [
    { "x":  20, "y":   0, "z": 1.5, "halfWidth": 6, "height": 4 },
    { "x":   0, "y":  20, "z": 1.5, "halfWidth": 6, "height": 4 },
    { "x": -20, "y":   0, "z": 1.5, "halfWidth": 6, "height": 4 },
    { "x":   0, "y": -20, "z": 1.5, "halfWidth": 6, "height": 4 }
  ],
  "aiSpline": [
    [ 20,   0, 0.5],
    [ 14,  14, 0.5],
    [  0,  20, 0.5],
    [-14,  14, 0.5],
    [-20,   0, 0.5],
    [-14, -14, 0.5],
    [  0, -20, 0.5],
    [ 14, -14, 0.5],
    [ 20,   0, 0.5]
  ],
  "starts": [
    [19, -8, 0.5, 3.14159],
    [21, -8, 0.5, 3.14159]
  ],
  "pickups": [
    [ 14,  14, 1.0],
    [-14, -14, 1.0]
  ]
}
```

### Coordinate system

::: warning Specs use Blender axes — runtime uses three.js axes
The track spec is consumed by Blender headless. Inside the spec, **X = Blender X (right), Y = Blender Y (forward), Z = Blender Z (up)**. The exporter swaps these to three.js (X right, Y up, Z forward) at GLB-write time.

So a checkpoint with `{ x: 20, y: 0, z: 1.5 }` lands at three.js position `(20, 1.5, 0)`. The pattern:
- **Spec X** → world right
- **Spec Y** → world forward (the track's "down the straight" direction)
- **Spec Z** → world up (height)

Pickups, AI-spline points, and start poses follow the same convention.
:::

### Field reference

| Field | Notes |
|---|---|
| `lapsToFinish` | 1–99. Default in code: 3. |
| `surface.size` | `[width, length]` of the drivable slab in Blender X/Y. |
| `surface.thickness` | Slab thickness in metres. **Default 1.0; do not set 0.** A 0-thickness plane trimesh is tunnel-prone in Rapier 0.19's discrete broadphase. |
| `water.center` | `[x, y, z]` of the water volume center. |
| `water.extents` | `[ex, ey, ez]` half-extents of the water box. |
| `water.waveHeight` | Peak Gerstner amplitude. |
| `water.waveFreq` | Per-wave frequency multiplier. |
| `checkpoints[].x/y/z` | Center of the gate (Blender axes). `x` defaults to 0 if omitted. |
| `checkpoints[].halfWidth` | Lateral half-width of the gate window. |
| `checkpoints[].height` | Vertical height of the gate window. |
| `aiSpline` | Array of `[x, y, z]` (Blender axes), at least 2 points. The runtime resamples this into a dense polyline at boot. Loops automatically. |
| `starts` | Array of `[x, y, z]` or `[x, y, z, yaw]` (yaw in radians, 0 = facing three.js +Z). At least one. |
| `pickups` | Array of `[x, y, z]` pickup spawn locations. |

### Why surface thickness matters

Set the slab `thickness` to **1 m or more** (default works). M9.27 / M9.28 fixed a class of "bike falls through the track" bugs by extruding the surface into a real slab and enabling CCD on the bike rigid body. A 0-thickness trimesh is a portal — the bike will tunnel through it on the first downward step at top speed.

## Editor-driven authoring

For visual / non-axis-aligned tracks, use the in-app editor. It owns gameplay data — gates, AI spline anchors, pickups, boost pads, start pose. Pair with a Blender-authored `environmentGlb` for collidable terrain.

```
http://localhost:5191/?edit=1                      # opens lagoon-edit (default)
http://localhost:5191/?track=<id>&edit=1           # opens a specific track
```

`<id>` can be:

- **`lagoon-edit`** — JSON snapshot of the procedural Lagoon Loop. Regenerate with `node tools/snapshot_lagoon.mjs` if `lagoon-loop.ts` changes.
- An existing JSON track in `public/tracks/<id>.json` — opens for editing.
- A new id (e.g. `?track=mybeach&edit=1`) — opens an empty draft. Hit Save to write `public/tracks/mybeach.json`.

The two procedural tracks (`lagoon`, `cliffside`) are built in code and are **not editable** here.

### Workflow

1. **Select** an entity by clicking its row in the **Outliner**. Three.js TransformControls gizmo appears.
2. **Switch gizmo mode** with the panel buttons or hotkeys (`W` move, `E` rotate, `R` scale).
3. **Drag a handle** to move / rotate / scale.
4. **Place new entities** with the +Gate / +Pickup / +Boost / +Spline pt / +Asset buttons. The next ground click drops it.
   - New gates auto-bind to the spline at the click's nearest curve point.
   - New spline anchors insert into the segment closest to the click.
5. **Undo** with Ctrl/Cmd+Z. 50-deep stack.
6. **Save** writes `public/tracks/<id>.json` via the dev middleware.
7. **Play** reloads without `?edit=1`.

### Gizmo modes

| Mode | Hotkey | Affects |
|---|---|---|
| Move | `W` | Translate (X/Y/Z) |
| Rotate | `E` | Yaw around Y (gates + pads only) |
| Scale | `R` | Resize (gates: halfWidth + height; pads: halfWidth + halfDepth) |

- **Gates + Boost Pads** support all three modes.
- **Spline-bound gates** (the default for new gates) translate by *sliding along the spline*. Rotation is locked (derived from the curve tangent); scale still works.
- **Pickups + Spline anchors** are translate-only.

When scaling, the gizmo stretches during the drag. On drag end the scale is **baked** into the entity's `halfWidth` / `halfDepth` / `height` and reset to 1. Min sizes clamp to 0.5 m.

### Camera

| Action | Effect |
|---|---|
| Left-drag | Orbit |
| Right-drag | Pan |
| Wheel | Zoom |

OrbitControls — damped, polar-clamped to keep the camera above the water plane.

### Wiring an env GLB

Set `environmentGlb` in the JSON to the public URL of your Blender export:

```json
{
  "id": "mybeach",
  "environmentGlb": "/assets/tracks/mybeach.glb",
  "checkpoints": [],
  "anchors": [],
  "pickups": []
}
```

In editor mode the GLB is **not loaded** — you author against the bare water plane without parallax distractions. It loads on Play.

For environment geometry workflow, see [`docs/blender-pipeline-guide.md`](https://github.com/occ-matt/hoverbike/blob/main/docs/blender-pipeline-guide.md).

### Splines: anchors vs. legacy points

The runtime AI controller follows a dense polyline of ~100+ points. Authors don't want to drag 100 dots, so the JSON supports two formats:

- **`anchors`** *(preferred)* — sparse Catmull-Rom control points (8–12 is plenty for a stadium loop). The loader resamples them at boot.
- **`points`** *(legacy)* — the dense polyline as-is. Older tracks (e.g. `calibration.json`) use this. The editor will show every point as a small dot — workable but tedious. Convert to anchors by hand-editing the JSON when convenient.

When a track has anchors, the dense `points` field is regenerated on every save and stored as `[]`.

## Limits to know about

- **No diff vs. saved.** The status appears under the Save button, but the underlying file isn't watched for outside changes.
- **Boost pads have no runtime effect yet.** They render and persist; the sim doesn't react. Wiring the speed-up is its own task.
- **Numeric input boxes are read-only.** The properties panel shows values but you can't type into them — use the gizmo. Hand-edit the JSON for fine-grained control.
- **No "unbind from spline" UI.** Hand-edit the JSON to remove `splineT` from a gate.

These are the next things to build.
