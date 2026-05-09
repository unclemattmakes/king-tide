# Asset pipeline tools

Headless Blender + Node scripts that turn JSON specs into runtime
GLBs. Bikes, props, and tracks share the framework in
[`tools/blender/`](./blender); the higher-level driver is
[`tools/blender/run.mjs`](./blender/run.mjs), surfaced as `pnpm gen:*`
scripts.

> **End-to-end walkthrough:**
> [`docs/asset-pipeline-guide.md`](../docs/asset-pipeline-guide.md)
> (forthcoming) — for the design rationale see
> [`docs/asset-pipeline-plan.md`](../docs/asset-pipeline-plan.md). The
> track-specific authoring guide remains
> [`docs/blender-pipeline-guide.md`](../docs/blender-pipeline-guide.md).

## One-time setup

Put `blender` on PATH (Windows: typically
`C:\Program Files\Blender Foundation\Blender 5.1\blender.exe`; macOS:
`/Applications/Blender.app/Contents/MacOS/Blender`). The pipeline
guide has full setup details. Override via `BLENDER_EXE`.

## Generate everything

```bash
pnpm gen:all          # bikes + props + tracks, then writes manifest.json
pnpm gen:bikes        # specs/bikes/*.json     → public/assets/bikes/*.glb
pnpm gen:props        # specs/props/*.json     → public/assets/props/*.glb
pnpm gen:tracks       # specs/tracks/*.json    → public/assets/tracks/*.glb (+ tracks-src/<id>.blend)
pnpm gen:manifest     # rebuild manifest.json from existing GLBs (no Blender)
```

Each spec is validated against its JSON Schema in `specs/_schema/`
before Blender starts. Any builder failure aborts the run with a
non-zero exit code.

## Layout

```
tools/
├── README.md                    ← this file
├── export_track.py              ← KEEP — track-specific glTF exporter (validates + bakes spline)
├── snapshot_lagoon.mjs          ← KEEP — captures procedural Lagoon Loop as JSON
└── blender/                     ← shared headless pipeline
    ├── __init__.py              ← package marker
    ├── common.py                ← reset_scene, read_spec, export_glb, validate_required_kinds
    ├── lib_loader.py            ← append_objects from kit .blends
    ├── sockets.py               ← socket-empty creation + validation
    ├── colliders.py             ← primitive collider helpers
    ├── inspect_glb.mjs          ← node script — dumps a GLB's nodes + extras
    ├── run.mjs                  ← Node CLI — wraps `blender --background` per spec
    ├── seed_bike_kit.py         ← (re)build tools/blender/lib/bike_parts.blend
    ├── seed_prop_kit.py         ← (re)build tools/blender/lib/prop_kit.blend
    ├── build_bike.py            ← spec → bike GLB (chassis + fairing + thrusters + sockets + collider)
    ├── build_prop.py            ← spec → prop GLB
    ├── build_track.py           ← spec → tracks-src/<id>.blend → GLB (replaces build_calibration_scene.py)
    └── lib/                     ← committed kit .blend files (source art)
        ├── bike_parts.blend
        └── prop_kit.blend
```

## Spec → GLB contract

The runtime resolves nodes by their glTF `extras.kind` tag. The
builders all use the helpers in `tools/blender/common.py` to apply
those extras consistently.

| `kind` | Where written | Required co-extras |
|---|---|---|
| `bike` | `bike_root` empty | `bike_id`, `mass_kg`, `top_speed_mps`, `hover_height` |
| `prop` | `prop_root` empty | `prop_id`, `category` |
| `socket` | `socket_<slot>` empty | `slot` |
| `collider` | `collider_*` empty | `shape` (+ `half_extents` \| `radius` \| `height`) |
| `track` | track-surface meshes | — |
| `water` | water-volume empty | `wave_height`, `wave_freq` |
| `checkpoint` | `cp_NN` empty | `index`, `half_width`, `height` |
| `ai_spline` | NURBS curve | `branch` (+ `points` baked at export time) |
| `pickup_spawn` | `pickup_*` empty | — |
| `start` | `start_NN` empty | `index` |

## Track exporter (still relevant)

`tools/export_track.py` is the track-specific exporter. `build_track.py`
runs it internally after constructing the scene from a spec. To
export an already-authored `.blend` directly (e.g. after editing in
Blender by hand):

```bash
HOVERBIKE_OUTPUT=public/assets/tracks/my-track.glb \
  blender --background tracks-src/my-track.blend --python tools/export_track.py
```

## What the track exporter validates

- Each object whose name matches a convention pattern (e.g. `cp_*`,
  `water_volume_*`) must carry a `kind` custom property that matches
  the convention.
- Checkpoint indices (`cp_00`, `cp_01`, ...) must be contiguous from
  0 and each checkpoint must declare `half_width` and `height`.
- The scene must contain `ai_spline_main`, and its baked points array
  must be non-empty.

The bike and prop builders run their own kind/socket validators in
`build_<category>.py`.

## Conventions

See [`docs/blender-conventions.md`](../docs/blender-conventions.md)
for the at-a-glance reference card, or
[`docs/blender-pipeline-guide.md`](../docs/blender-pipeline-guide.md)
for the full track-author guide.
