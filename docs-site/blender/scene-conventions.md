# Scene conventions

At-a-glance reference for the contract between Blender and the runtime.
Every metadata-bearing object in a `.blend` carries a `kind` custom
property that the exporter copies into glTF `extras`; the runtime loader
walks the GLB and reads `extras.kind` to decide what to do with each node.

For the full walk-through, see [Your first track](./your-first-track).
For the panels + operators that author these conventions for you, see
[Addon reference](./addon-reference).

> **Anti-grav kinds are parked.** Anti-grav is cut (parked for a possible DLC).
> The `antigrav_zone` / `antigrav_NN_surface` kinds and the `anti_grav` spline
> flag still exist in the exporter and are listed below for completeness, but no
> shipped track places them — don't author anti-grav into a v2 track.

## Object kinds — track mode

| Kind | Naming pattern | Required Blender type | Required `extras` |
|---|---|---|---|
| Track surface (drivable) | any name; material `mat_track_*` by convention | mesh | `{ kind: "track" }` (default if not set on `mat_track_*`-prefixed meshes) |
| Decoration (render-only) | any name | mesh | `{ kind: "decoration" }` — opts out of the trimesh collider |
| Water volume | `water_volume_*` (typically `water_volume_main`) | empty (cube display) | `{ kind: "water", wave_height, wave_freq }` |
| Wave zone | `wave_zone_NN` (zero-padded) | empty (cube display) | `{ kind: "wave_zone", half_width, half_height, half_depth, height_mult, freq_mult, blend_radius_m, [direction_deg, surge_period_s, surge_amplitude] }` |
| Checkpoint | `cp_NN` (zero-padded, contiguous from 0) | empty | `{ kind: "checkpoint", index, half_width, height }` |
| AI spline | `ai_spline_main` (or `ai_spline_alt_*` for branches) | NURBS or Bezier curve | `{ kind: "ai_spline", branch, [anti_grav] }` |
| Pickup spawn | `pickup_*` | empty | `{ kind: "pickup_spawn" }` |
| Player start | `start_NN` (zero-padded, NN = grid position) | empty | `{ kind: "start", index }` |
| Boost pad | `boost_NN` (zero-padded) | empty | `{ kind: "boost_pad", half_width, half_depth, strength }` |
| Anti-grav zone | `antigrav_NN` (zero-padded) | empty | `{ kind: "antigrav_zone", half_width, half_height, half_depth }` |
| Anti-grav surface | `antigrav_NN_surface` | mesh | `{ kind: "track", anti_grav: true }` — collidable, but the runtime applies the gravity flip to bikes in the zone empties at each curve end. |
| Horizon ring | `horizon_ring` (singular) | mesh | `{ kind: "horizon" }` |
| Particle emitter | `emitter_NN` | empty | `{ kind: "emitter", atlas_cell, emit_rate, lifetime_s, velocity_cone_deg, speed_min, speed_max, size_start, size_end, color_start, color_end, gravity, max_particles }` |

::: tip Reference scenes
- `tracks-src/calibration.blend` — exactly one of every gameplay kind set up correctly. Rebuild with `pnpm gen:tracks` (calls `build_track.py` against `specs/tracks/calibration.json`).
- `tracks-src/template-antigrav-showcase.blend` — tube + ribbon + banked-strip anti-grav surfaces, all three together.
- `tracks-src/template-tunnels.blend` — three mountains, one tunnel per peak, AI spline threading all three.

Open any of them, copy the patterns. Or start a new track from one with **Hoverbike → Utility → New Map from Template**.
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
copies them verbatim into glTF `extras`. The **auto_tag** depsgraph
hook will set the `kind` extra automatically when an object whose
name matches a recognised pattern is created or renamed, so the
manual step below is mostly only needed for one-off / hand-authored
objects.

| Property | On | Type | Notes |
|---|---|---|---|
| `kind` | every metadata-bearing object | string | See the matrices above. |
| `index` | checkpoints, starts | int | Trailing digits of the name. |
| `half_width` | checkpoints, boost pads, anti-grav zones, wave zones | float (m) | Half-extent along the object's local X. For checkpoints it's the gate's horizontal span / 2. |
| `half_height` | anti-grav zones, wave zones | float (m) | Half-extent along the object's local Y (Blender Z; runtime Y after the up-axis swap). Vertical clearance. |
| `half_depth` | boost pads, anti-grav zones, wave zones | float (m) | Half-extent along the object's local Y (Blender) / Z (runtime). |
| `height` | checkpoints | float (m) | Vertical clearance of the gate window. |
| `strength` | boost pads | float | Top-speed multiplier on overlap. 1.0 = no boost; 1.5 = +50%. |
| `height_mult` | wave zones | float | Multiplier on global wave amplitude inside the zone. 1 = neutral; >1 = bigger waves; <1 = calmer. Required positive. |
| `freq_mult` | wave zones | float | Multiplier on per-wave frequency. >1 = choppier; <1 = longer rolling swell. |
| `blend_radius_m` | wave zones | float (m) | Soft-edge falloff distance outside the OBB face. Keeps the zone boundary invisible. |
| `direction_deg` | wave zones (optional) | float (°) | Override the dominant swell bearing in world XZ. 0° = +X, 90° = +Z. Inherit global bearing if absent. |
| `surge_period_s` + `surge_amplitude` | wave zones (optional, both-or-nothing) | float (s, m) | Drives `amp · max(0, sin(2π·t / period))` additive surge. Both must be set together — validator rejects half-specs. |
| `branch` | AI splines | string | `"main"` for the canonical racing line; `"alt_*"` for branches. |
| `anti_grav` | AI splines | bool | `true` to enable the spline-driven anti-grav corridor along the racing line, driven by per-anchor Tilt. Toggle from the Gameplay sub-panel. |
| `wave_height` | water volumes | float (m) | Peak wave amplitude. |
| `wave_freq` | water volumes | float (Hz) | Wave temporal frequency. |
| `atlas_cell` | emitters | int 0..15 | Picks a 256×256 sprite from the shared atlas. |
| `emit_rate` / `lifetime_s` / `velocity_cone_deg` / `speed_min` / `speed_max` / `size_start` / `size_end` / `color_start` / `color_end` / `gravity` / `max_particles` | emitters | various | Per-emitter runtime knobs — full table in [Addon reference → Emitters](./addon-reference#emitters). |
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

obj["kind"] = ExportedKind.TRACK           # not "track"
obj["kind"] = ExportedKind.CHECKPOINT
obj["kind"] = ExportedKind.WATER
obj["kind"] = ExportedKind.WAVE_ZONE
obj["kind"] = ExportedKind.ANTIGRAV_ZONE
obj["kind"] = ExportedKind.HORIZON
obj["kind"] = ExportedKind.EMITTER
```

The TypeScript runtime side has a mirrored enum in
[`src/engine/asset-kinds.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/engine/asset-kinds.ts).
A unit test (`tests/unit/asset-kinds.test.ts`) parses both files and
fails if they drift, so adding a value on one side without the other
is caught at CI time.

The Python side also has an `AuthoringKind` enum for object kinds that
are useful inside Blender but never ship in the GLB — `ANTIGRAV_CURVE`
(the Bezier behind a swept anti-grav surface), `CAMERA_HERO` (the
loading-screen camera), `_tunnel_cutter` (the boolean operand). These
have no TypeScript counterpart.

## Validation rules

The validator runs both in the addon (pre-export) and in the headless
builders. It rejects the build if:

- An object whose name matches a recognised pattern (`cp_NN`,
  `pickup_*`, `start_NN`, `boost_NN`, `antigrav_NN`, `wave_zone_NN`,
  `water_volume_*`, `ai_spline_*`, `emitter_NN`, `horizon_ring`)
  doesn't have a `kind` extra, or its `kind` disagrees with the name.
- Checkpoints aren't contiguous from 0 (`cp_00`, `cp_02` with no
  `cp_01`). Renaming `cp_03..cp_NN` to close gaps is on you.
- A checkpoint is missing `half_width` or `height`.
- There's no `ai_spline_main`, or its sampled point array is empty
  (curve has < 2 control points).
- A `wave_zone_NN` empty has a non-positive `half_*` extent or
  `height_mult`, or has only one of (`surge_period_s`,
  `surge_amplitude`) set.
- A bike `.blend` is missing any of the five required sockets, or
  has no collider empty.
- A bike's `bike_root.extras.bike_id` disagrees with the filename basename.

If you've renamed objects and end up with `kind` extras that don't
match the names, hit **Re-tag Scene by Name** in the track header
(or **Hoverbike → Utility → Re-tag Scene by Name**) — it walks the
scene and rewrites every `kind` extra from the current name.

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

A few object kinds have axis conventions that survive the up-axis
swap because they're expressed in local frame:

- **Boost pads** — local +Y is the boost direction (forward in
  Blender, forward in three after the swap).
- **Wave zones** — local +X is the dominant swell direction
  (right in both frames).
- **Anti-grav zone empties** — local +Y is "up" relative to the
  road (= the direction the bike's own +Y rotates onto). On a
  banked / wall / ceiling road, author yaw + roll so the box's
  local +Y matches the road normal.
- **Emitters** — local +Y is the emission cone axis.

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
- Wave zone: 60 m × 60 m × 40 m default for a recognisable swell
  feature; 200 m+ for a "whole bay" calm or tsunami zone.
- Anti-grav zone: scale to cover the road slab + a metre of
  clearance above and below.

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
| `mat_track_antigrav_*` | Anti-grav swept surface | Per-profile (tube / ribbon / banked-strip) variants emitted by `build_antigrav_surface`. |
| `mat_wave_zone_preview` | Wave zone gizmo | Translucent cyan-teal box. Lives only in the `_hoverbike_wave_zone_preview` collection and is scrubbed at export. |
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
  time — the runtime always uses its own chase camera + lighting. The
  one camera that has a special role — `camera_hero` — is also stripped
  from the GLB; the exporter renders it to JPG first.
- **Trimesh broadphase requires real volume.** Pre-M9.27, a fast-falling
  capsule could tunnel through a 0-thickness plane. The spec-driven
  builder authors 1 m-thick slabs by default; hand-authored Blender
  tracks should follow the same convention. M9.27 added CCD on the
  bike's rigid body as a backstop.
- **Boost-pad / wave-zone / anti-grav zone gizmos don't update on rotation alone.** Trigger a depsgraph notification (click elsewhere → click back) or hit **Refresh ...** in the matching sub-panel.
- **`bloom` in the sky preset is round-trip only.** No bloom pass is
  wired into the WebGPU renderer yet; the value ships through the JSON
  and the runtime logs it but doesn't apply it. Goes live when the
  post pipeline lands.
- **Old AI-spline tunnel rig deprecated.** The seed-driven
  `tracks-src/template-tunnels.blend` is now canonical for tunnels.
  The addon's tunnel tool still works but is marked deprecated.

## See also

- [Your first track](./your-first-track) — guided walk-through.
- [Addon reference](./addon-reference) — every panel + operator.
- [Wave zones cookbook](./wave-zones) — in-depth wave-mastery examples.
- [Modding → Tracks](/modding/tracks) — the spec-driven + editor-driven workflows.
- [Modding → Bikes](/modding/bikes) — bike-specific authoring.
- In-repo docs: [`docs/blender-pipeline-guide.md`](https://github.com/occ-matt/hoverbike/blob/main/docs/blender-pipeline-guide.md) — the source material these pages are distilled from.
