# Blender Track Authoring — Conventions Quick Reference

> For the full walk-through (setup, authoring a track, troubleshooting),
> see [blender-pipeline-guide.md](./blender-pipeline-guide.md). This file
> is the at-a-glance reference card.

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
