# Track authoring tools

Blender Python scripts for the track import/export pipeline. Run with Blender 5.x.

> **Most authors should read [`docs/blender-pipeline-guide.md`](../docs/blender-pipeline-guide.md) instead** — it's the end-to-end walkthrough. This file is just the script reference.

## One-time setup

Put `blender` on PATH (Windows: typically `C:\Program Files\Blender Foundation\Blender 5.1\blender.exe`; macOS: `/Applications/Blender.app/Contents/MacOS/Blender`). The pipeline guide has full setup details.

## Build the calibration scene

The calibration scene is the reference scene containing exactly one of every metadata object kind. It's both a smoke test for the import/export pipeline and a template for new tracks.

```bash
blender --background --python tools/build_calibration_scene.py
```

This writes `tracks-src/calibration.blend`. The .blend is committed to the repo, so you only need to re-run this if you've edited the build script.

## Export a track to glTF

After authoring (or building) a `.blend`, export it:

```bash
blender --background tracks-src/calibration.blend --python tools/export_track.py
```

Output goes to `public/assets/tracks/<basename>.glb` by default. Override with `HOVERBIKE_OUTPUT`:

```bash
HOVERBIKE_OUTPUT=public/assets/tracks/my-track.glb \
  blender --background tracks-src/my-track.blend --python tools/export_track.py
```

## What the exporter does

Beyond the validation listed below, the exporter also **bakes any NURBS curve named `ai_spline_*` into a flat point array** stored on the same node's `extras.points` (since glTF doesn't carry curve geometry natively). Authors keep editing the curve in Blender; the exported .glb gets the sampled points.

## What the exporter validates

- Each object whose name matches a convention pattern (e.g. `cp_*`, `water_volume_*`) must carry a `kind` custom property that matches the convention.
- Checkpoint indices (`cp_00`, `cp_01`, ...) must be contiguous from 0 and each checkpoint must declare `half_width` and `height`.
- The scene must contain `ai_spline_main`, and its baked points array must be non-empty.

If validation fails, the script prints the offending objects and exits non-zero.

## Conventions

See [`docs/blender-conventions.md`](../docs/blender-conventions.md) for the at-a-glance reference card, or [`docs/blender-pipeline-guide.md`](../docs/blender-pipeline-guide.md) for the full guide.
