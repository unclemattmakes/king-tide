# Blender Track Authoring Conventions

Tracks are authored in Blender and exported to glTF (.glb) via `tools/export-track.py`. The exporter walks the scene, validates names, and writes per-object metadata into glTF `extras`. The runtime track loader reads `extras` to wire up collision, AI, and race state.

The reference scene is [`tracks-src/calibration.blend`](../tracks-src/calibration.blend) — it contains exactly one of every object kind below. Open it, copy patterns from it.

## Object kinds

| Kind | Naming convention | Required type | `extras` |
|---|---|---|---|
| Track surface | any name; assign material `mat_track_*` | mesh | `{ kind: "track" }` |
| Water volume | `water_volume_*` | empty (cube) | `{ kind: "water", waveHeight, waveFreq }` |
| Checkpoint | `cp_NN` (zero-padded, ordered, contiguous) | empty | `{ kind: "checkpoint", index }` |
| AI spline | `ai_spline_main` (or `_alt_*` for branches) | curve | `{ kind: "ai_spline", branch }` |
| Pickup spawn | `pickup_*` | empty | `{ kind: "pickup_spawn" }` |
| Player start | `start_NN` (zero-padded, NN = grid position) | empty | `{ kind: "start", index }` |

## Custom properties

Set via Object Properties → Custom Properties in Blender. The exporter copies them into `extras`.

- `wave_height` (float, meters): peak wave amplitude inside this water volume. Default 1.0.
- `wave_freq` (float, Hz): wave temporal frequency. Default 0.5.

## Validation rules

The exporter fails loudly if:
- Multiple `start_00`, multiple `cp_00`, etc.
- Checkpoints are not contiguous (`cp_00`, `cp_02` without `cp_01`).
- No `ai_spline_main`.
- Water volumes are not empty cubes.

## Coordinate system

Blender → glTF uses Y-up by default in glTF. Three.js is also Y-up. Z forward in Blender becomes -Z forward in three.js after the glTF axis convention. The exporter handles this.

## Scale

1 Blender unit = 1 meter. Don't change units. Bikes are roughly 2.5m long.

## Reference layout: Cliffside

While the .blend → .glb pipeline is still being wired, the **Cliffside** track (`src/game/tracks/cliffside.ts` + `src/game/entities/cliffside-terrain.ts` + `src/engine/render/cliffside-mesh.ts`) is the procedural reference for what a Blender-authored track should look like. Each procedural piece maps 1:1 to an object you'd author in Blender:

| Procedural code | Blender equivalent |
|---|---|
| `MESA_*` cuboid | mesh `track_mesa`, material `mat_track_mesa`, `extras = { kind: "track" }` |
| `CLIMB_RAMP_*` tilted cuboid | mesh `track_climb_ramp`, material `mat_track_ramp`, `extras = { kind: "track" }` |
| `CLIFF_FACE_*` cuboid (visual only) | mesh `cliff_face_visual`, no `extras.kind` (renders only, no physics body) |
| `track.start.*` Vec3 + yaw | empty `start_00`, `extras = { kind: "start", index: 0 }` |
| `track.checkpoints[i]` | empty `cp_NN`, `extras = { kind: "checkpoint", index: NN }` |
| `track.aiSplines[0].points` | curve `ai_spline_main`, `extras = { kind: "ai_spline" }` |
| `track.pickupSpawns[i]` | empty `pickup_NN`, `extras = { kind: "pickup_spawn" }` |
| Universal wave field (everywhere outside surface meshes) | empty cube `water_volume_main`, `extras = { kind: "water", waveHeight: 0.6, waveFreq: 0.5 }` |

Open the running game with `?track=cliffside` to playtest the layout, then port it to a `.blend` once the loader lands.

Try it locally: `pnpm dev` → http://localhost:5191/?track=cliffside
