# Scene conventions

At-a-glance reference for the contract between Blender and the runtime.
Every metadata-bearing object in a `.blend` carries a `kind` custom
property that the exporter copies into glTF `extras`; the runtime loader
walks the GLB and reads `extras.kind` to decide what to do with each node.

For the full walk-through, see [Your first track](./your-first-track).
For the panels + operators that author these conventions for you, see
[Addon reference](./addon-reference).

## Object kinds — track mode

| Kind | Naming pattern | Required Blender type | Required `extras` |
|---|---|---|---|
| Track surface (drivable) | any name; material `mat_track_*` by convention | mesh | `{ kind: "track" }` (default if not set on `mat_track_*`-prefixed meshes) |
| Decoration (render-only) | any name | mesh | `{ kind: "decoration" }` — opts out of the trimesh collider |
| Water volume | `water_volume_*` (typically `water_volume_main`) | empty (cube display) | `{ kind: "water", wave_height, wave_freq }` |
| Checkpoint | `cp_NN` (zero-padded, contiguous from 0) | empty | `{ kind: "checkpoint", index, half_width, height }` |
| AI spline | `ai_spline_main` (or `ai_spline_alt_*` for branches) | NURBS or Bezier curve | `{ kind: "ai_spline", branch }` |
| Pickup spawn | `pickup_*` | empty | `{ kind: "pickup_spawn" }` |
| Player start | `start_NN` (zero-padded, NN = grid position) | empty | `{ kind: "start", index }` |
| Boost pad | `boost_NN` (zero-padded) | empty | `{ kind: "boost_pad", half_width, half_depth, strength }` |

::: tip Reference scene
`tracks-src/calibration.blend` contains exactly one of every kind set
up correctly. Open it, copy patterns from it. Rebuild it any time with
`pnpm gen:tracks` (which calls `build_track.py` against
`specs/tracks/calibration.json`).
:::

## Object kinds — bike mode

Separate matrix for bike `.blend`s (`bikes-src/<id>.blend`):

| Object | Required | Purpose |
|---|---|---|
| `bike_root` (empty) | exactly 1 | Runtime entry node. Extras: `kind=bike`, `bike_id`, `mass_kg`, `top_speed_mps`, `hover_height`, `display_name`. |
| Visual meshes (`bike_body`, `bike_fairing`, etc.) | typical loadout | Parented to `bike_root`. Materials use `mat_bike_<id>_*` so the spec's `appearance.*` overrides can recolour them at build time. |
| `socket_seat` (empty) | yes | Where the rider parents to the bike. Extras: `kind=socket`, `slot=seat`. |
| `socket_nose_cam` (empty) | yes | Chase-camera anchor. `slot=nose_cam`. |
| `socket_fx_thruster_l` / `_r` (empties) | yes | Thruster FX emitter origins. |
| `socket_fx_exhaust` (empty) | yes | Centre exhaust FX origin. |
| One collider (empty) | yes — at least 1 | Extras: `kind=collider`, `shape=box`, `half_extents=[hx, hy, hz]` in three's axes (right, up, forward). |

For more bike-specific authoring detail see [Modding → Authoring bikes](/modding/bikes).

## Custom properties reference

Set via Object Properties → Custom Properties in Blender. The exporter
copies them verbatim into glTF `extras`.

| Property | On | Type | Notes |
|---|---|---|---|
| `kind` | every metadata-bearing object | string | See the matrices above. |
| `index` | checkpoints, starts | int | Trailing digits of the name. |
| `half_width` | checkpoints, boost pads | float (m) | Half the gate's horizontal span / half the pad's lateral extent. |
| `height` | checkpoints | float (m) | Vertical clearance of the gate window. |
| `half_depth` | boost pads | float (m) | Half the pad's depth along the boost direction. |
| `strength` | boost pads | float | Top-speed multiplier on overlap. 1.0 = no boost; 1.5 = +50%. |
| `branch` | AI splines | string | `"main"` for the canonical racing line; `"alt_*"` for branches. |
| `wave_height` | water volumes | float (m) | Peak wave amplitude. |
| `wave_freq` | water volumes | float (Hz) | Wave temporal frequency. |
| `bike_id` | bike root | string | Variant id, must match the `.blend` filename basename. |
| `mass_kg` / `top_speed_mps` / `hover_height` | bike root | float | Runtime physics overrides (optional; spec can override these too). |
| `display_name` | bike root | string | Garage menu label. |
| `slot` | sockets | string | One of `seat`, `nose_cam`, `fx_thruster_l`, `fx_thruster_r`, `fx_exhaust`. |
| `shape` | colliders | string | Currently only `box` is supported. |
| `half_extents` | colliders | float[3] | `[hx, hy, hz]` in three's axes (right, up, forward). |

The exporter also writes a baked `points` flat-float array onto AI
spline nodes (`[x0, y0, z0, x1, y1, z1, ...]`) since glTF can't carry
curves natively. Authors don't set this — the export script populates
it from the curve geometry.

### `ExportedKind` enum

For Python-side authoring (seed scripts, headless builders), use the
constants in
[`tools/blender/hoverbike_kinds.py`](https://github.com/occ-matt/hoverbike/blob/main/tools/blender/hoverbike_kinds.py)
instead of string literals:

```python
from tools.blender.hoverbike_kinds import ExportedKind

obj["kind"] = ExportedKind.TRACK     # not "track"
obj["kind"] = ExportedKind.CHECKPOINT
obj["kind"] = ExportedKind.WATER
```

The TypeScript runtime side has a mirrored enum in
[`src/engine/asset-kinds.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/engine/asset-kinds.ts).
A unit test (`tests/unit/asset-kinds.test.ts`) parses both files and
fails if they drift, so adding a value on one side without the other
is caught at CI time.

The Python side also has an `AuthoringKind` enum for object kinds that
are useful inside Blender (e.g. `_tunnel_cutter`) but never ship in the
GLB — they have no TypeScript counterpart.

## Validation rules

The validator runs both in the addon (pre-export) and in the headless
builders. It rejects the build if:

- An object whose name matches a recognised pattern (`cp_NN`,
  `pickup_*`, `start_NN`, `boost_NN`, `water_volume_*`, `ai_spline_*`)
  doesn't have a `kind` extra, or its `kind` disagrees with the name.
- Checkpoints aren't contiguous from 0 (`cp_00`, `cp_02` with no
  `cp_01`). Renaming `cp_03..cp_NN` to close gaps is on you.
- A checkpoint is missing `half_width` or `height`.
- There's no `ai_spline_main`, or its sampled point array is empty
  (curve has < 2 control points).
- A bike `.blend` is missing any of the five required sockets, or
  has no collider empty.
- A bike's `bike_root.extras.bike_id` disagrees with the filename basename.

Use **Lint Track** in the addon for warnings (the linter also flags
playability traps like spline points below the water surface or above
non-`kind=track` meshes — these are warnings, not errors).

## Coordinate system

::: warning Blender vs. runtime axes
Blender authors in **Z-up, +Y forward**. The runtime (three.js / glTF)
uses **Y-up, +Z forward**. The exporter passes `export_yup=True` so the
conversion is automatic:

| Blender axis | Runtime axis |
|---|---|
| +X (right) | +X (right) |
| +Y (forward) | -Z (forward) |
| +Z (up) | +Y (up) |

In practice this means: **author with Blender's defaults**, don't manually
rotate. A start empty's local +Y points down-track in Blender, which
becomes +Z forward in three.js — exactly the direction the bike accelerates.
:::

For the JSON spec format (separate convention — specs use Blender axes
even though they consume Blender's headless build), see
[Modding → Tracks](/modding/tracks#coordinate-system).

## Scale

1 Blender unit = 1 metre. Don't change scene units. Reference dimensions:

- Bike: roughly 2.5 m long × 1 m wide × 0.6 m tall.
- Gate: 28 m wide × 6 m tall (`half_width = 14`, `height = 6`).
- Drivable track surface: any size; typical templates are 600 × 600 m.
- Water volume: extends well past the playable area (the wave field
  renders everywhere outside drivable meshes).

## Materials

| Material name pattern | Used for | Notes |
|---|---|---|
| `mat_track_*` | Drivable track surfaces | Authoring convention. The runtime doesn't key off it — `kind=track` is what matters — but using the prefix groups them in Blender's material panel and is the right place to put track-specific shader work. |
| `mat_track_road` | Road tool asphalt | Slot 0 on road meshes. |
| `mat_track_curb_white` / `mat_track_curb_red` | Road tool curbs | Slots 1 / 2 — F1-style alternating stripes. |
| `mat_track_road_underside` | Road tool slab underside | Lighter concrete grey so the underside reads as bridge structure. |
| `mat_track_ramp` | Stunt ramp | Single material on the wedge. |
| `mat_track_tunnel` | Tunnel interior shell | Dark concrete with slight blue cast. |
| `mat_track_downtown_sidewalk` / `_road` | Downtown plinth | Slot 0 = sidewalk under building lots; slot 1 = asphalt on inter-block strips. Per-face material indices, single mesh per block. |
| `mat_bike_<id>_*` | Bike materials | Pre-prefix lets the slim spec's `appearance.liveryColor` / `metalColor` / `glowColor` overrides apply at build time. |

## Hidden objects are skipped

Toggling the **eye icon** off in the outliner (or hiding a whole
collection) excludes that object from the export entirely — GLB,
validation, and JSON derivation all filter on `visible_get()`. This
lets you park WIP geometry, alternate spline branches, or reference
empties in a hidden collection without breaking the contiguous-
checkpoint or single-`ai_spline_main` checks.

Render-only hide (the **camera icon**) does **not** affect this. The
export always uses viewport visibility.

## Known limitations

- **Single AI spline branch supported by AI controller.** You can author
  `ai_spline_alt_*` branches; they'll round-trip through the loader,
  but the AI controller only follows `main`.
- **No per-material collider tuning.** Every `kind=track` mesh gets
  the same friction (0.6) and restitution (0.05). Per-material passthrough
  is on the wishlist.
- **No camera or light export.** Studio lights baked into a `.blend`
  make the in-Blender preview look good, but they're stripped at export
  time — the runtime always uses its own chase camera + lighting.
- **Trimesh broadphase requires real volume.** Pre-M9.27, a fast-falling
  capsule could tunnel through a 0-thickness plane. The spec-driven
  builder authors 1 m-thick slabs by default; hand-authored Blender
  tracks should follow the same convention. M9.27 added CCD on the
  bike's rigid body as a backstop.
- **Boost pad gizmos don't update on rotation alone.** Trigger a
  depsgraph notification (click elsewhere → click back) or hit **Refresh
  Boost Pads** in the Gameplay sub-panel.
- **Old AI-spline tunnel rig deprecated.** The seed-driven
  `tracks-src/template-tunnels.blend` is now canonical for tunnels.
  The addon's tunnel tool still works but is marked deprecated.

## See also

- [Your first track](./your-first-track) — guided walk-through.
- [Addon reference](./addon-reference) — every panel + operator.
- [Modding → Tracks](/modding/tracks) — the spec-driven + editor-driven workflows.
- [Modding → Bikes](/modding/bikes) — bike-specific authoring.
- In-repo docs: [`docs/blender-conventions.md`](https://github.com/occ-matt/hoverbike/blob/main/docs/blender-conventions.md) and [`docs/blender-pipeline-guide.md`](https://github.com/occ-matt/hoverbike/blob/main/docs/blender-pipeline-guide.md) — the source material these pages are distilled from.
