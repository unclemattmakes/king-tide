# Blender Track Authoring — Conventions Quick Reference

> For the full walk-through (setup, authoring a track, troubleshooting),
> see [blender-pipeline-guide.md](./blender-pipeline-guide.md). This file
> is the at-a-glance reference card.
>
> **Hybrid pipeline (M9.19+):** new tracks split gameplay data into
> `public/tracks/<id>.json` (authored via the in-app editor — see
> [track-editor-guide.md](./track-editor-guide.md)) and environment
> geometry into a Blender `.glb` referenced from the JSON. Most of the
> object kinds below (`checkpoint`, `ai_spline`, `pickup_spawn`, `start`)
> are now redundant — the editor owns those. Keep `kind="track"` on
> drivable surfaces; the rest are only needed for the legacy all-in-glb
> pipeline that the calibration scene exercises.

## Object kinds

| Kind | Naming convention | Required type | `extras` |
|---|---|---|---|
| Track surface | any name; material `mat_track_*` | mesh | `{ kind: "track" }` |
| Water volume | `water_volume_*` | empty (cube) | `{ kind: "water", wave_height, wave_freq }` |
| Checkpoint | `cp_NN` (zero-padded, ordered, contiguous from 0) | empty | `{ kind: "checkpoint", index, half_width, height }` |
| AI spline | `ai_spline_main` (or `ai_spline_alt_*` for branches) | NURBS curve | `{ kind: "ai_spline", branch }` |
| Pickup spawn | `pickup_*` | empty | `{ kind: "pickup_spawn" }` |
| Player start | `start_NN` (zero-padded, NN = grid position) | empty | `{ kind: "start", index }` |

The reference scene is [`tracks-src/calibration.blend`](../tracks-src/calibration.blend) — it contains exactly one of every object kind. Open it, copy patterns from it.

## Custom properties

Set via Object Properties → Custom Properties in Blender. The exporter copies them verbatim into glTF `extras`.

| Property | On | Type | Notes |
|---|---|---|---|
| `kind` | every metadata-bearing object | string | the matrix above |
| `index` | checkpoints, starts | int | trailing digits of the name |
| `half_width` | checkpoints | float (m) | half the gate's horizontal span |
| `height` | checkpoints | float (m) | gate's vertical clearance |
| `branch` | AI splines | string | `"main"` for the canonical racing line |
| `wave_height` | water volumes | float (m) | peak wave amplitude |
| `wave_freq` | water volumes | float (Hz) | wave temporal frequency |

The exporter also writes a baked `points` flat-float array onto AI spline nodes (`[x0,y0,z0,...]`), since glTF doesn't carry NURBS curves. Authors don't set this — the export script populates it from the curve geometry.

## Validation rules

The exporter fails loudly if:
- An object whose name matches a convention pattern doesn't have a `kind` extra, or has a kind that disagrees with its name.
- Checkpoints aren't contiguous (`cp_00`, `cp_02` without `cp_01`), or any checkpoint is missing `half_width` / `height`.
- There's no `ai_spline_main`, or its baked `points` array is empty.

## Coordinate system

Blender → glTF uses Y-up via `export_yup=True`. Three.js is also Y-up. Z forward in Blender stays +Z forward in three after the conversion. The exporter handles this — author with Blender's default Z-up, no manual swap.

## Scale

1 Blender unit = 1 metre. Don't change units. Bikes are roughly 2.5m long; gates are typically 28m wide (`half_width = 14`) and 6m tall.

## Bike reference (`bikes-src/<id>.blend`)

Separate from the track conventions above. As of M9.38 each bike
variant lives in its own `bikes-src/<id>.blend` (no shared kit, no
propagation between variants). Author the bike directly, click
*Hoverbike → Export Bike to Game* in the addon. What the .blend
must contain:

| Object | Required | Lifecycle | Purpose |
|---|---|---|---|
| `bike_root` (empty) | yes — exactly one | rides into GLB | Runtime entry node. Extras: `kind=bike`, `bike_id`, `mass_kg`, `top_speed_mps`, `hover_height`, `display_name`. |
| `bike_body` / `bike_fairing` / `bike_fork` / `bike_thruster_*` / `bike_fin` / `bike_tail` (meshes) | typical loadout — at least the visual mesh you want rendered | rides into GLB | Parented to `bike_root`. Materials follow `mat_bike_<id>_*` so the spec's `appearance.*` overrides can recolour them at build time. |
| `socket_<slot>` (empties) | yes — all five slots | rides into GLB | Runtime attach points: `seat`, `nose_cam`, `fx_thruster_l/r`, `fx_exhaust`. |
| `collider_body` (empty) | yes — at least one | rides into GLB | Extras: `kind=collider`, `shape=box`, `half_extents=[hx, hy, hz]` in three's axes (right, up, forward). |

Studio lights baked into the .blend make the in-Blender preview
match the in-game viewer; the GLB exporter strips lights so they
never reach the runtime. The legacy kit (`bike_parts.blend`,
`mounts.py`, `seed_bike_kit.py`) is no longer wired up — kept on
disk pending cleanup.

See [`asset-pipeline-guide.md`](./asset-pipeline-guide.md#bikes-bikes-srcidblend--specsbikesidjson).

## Reference layout — Cliffside

While we wait for someone to actually author a track in Blender, the **Cliffside** track ([`src/game/tracks/cliffside.ts`](../src/game/tracks/cliffside.ts) + [`src/game/entities/cliffside-terrain.ts`](../src/game/entities/cliffside-terrain.ts) + [`src/engine/render/cliffside-mesh.ts`](../src/engine/render/cliffside-mesh.ts)) is the procedural reference for what a Blender-authored track should look like. Each piece of procedural code maps 1:1 to an object you'd author in Blender:

| Procedural code | Blender equivalent |
|---|---|
| `MESA_*` cuboid | mesh `track_mesa`, material `mat_track_mesa`, `extras = { kind: "track" }` |
| `CLIMB_RAMP_*` tilted cuboid | mesh `track_climb_ramp`, material `mat_track_ramp`, `extras = { kind: "track" }` |
| `CLIFF_FACE_*` cuboid (visual only) | mesh `cliff_face_visual`, no `extras.kind` (renders only, no physics body) |
| `track.start.*` Vec3 + yaw | empty `start_00`, `extras = { kind: "start", index: 0 }` |
| `track.checkpoints[i]` | empty `cp_NN`, `extras = { kind: "checkpoint", index: NN, half_width: 14, height: 6 }` |
| `track.aiSplines[0].points` | curve `ai_spline_main`, `extras = { kind: "ai_spline", branch: "main" }` (exporter bakes points) |
| `track.pickupSpawns[i]` | empty `pickup_NN`, `extras = { kind: "pickup_spawn" }` |
| Universal wave field (everywhere outside surface meshes) | empty cube `water_volume_main`, `extras = { kind: "water", wave_height: 0.6, wave_freq: 0.5 }` |

Open the running game with `?track=cliffside` to playtest the layout, then port it to a `.blend` once you're ready.
