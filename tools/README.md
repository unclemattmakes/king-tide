# Track authoring tools

Blender Python scripts for the track import/export pipeline. Run with Blender 4.x.

## One-time setup

Put `blender` on PATH (Windows: typically `C:\Program Files\Blender Foundation\Blender 4.x\blender.exe`).

## Build the calibration scene

The calibration scene is the reference scene containing exactly one of every metadata object kind. It's both a smoke test for the import/export pipeline and a template for new tracks.

```bash
blender --background --python tools/build_calibration_scene.py
```

This writes `tracks-src/calibration.blend`.

## Export a track to glTF

After authoring (or building) a `.blend`, export it:

```bash
blender --background tracks-src/calibration.blend --python tools/export_track.py
```

Output goes to `public/assets/tracks/<basename>.glb` by default. Override with `HOVERBIKE_OUTPUT`:

```bash
HOVERBIKE_OUTPUT=public/assets/tracks/lagoon.glb \
  blender --background tracks-src/lagoon.blend --python tools/export_track.py
```

## What the exporter validates

- Each object whose name matches a convention pattern (e.g. `cp_*`, `water_volume_*`) must carry a `kind` custom property that matches the convention.
- Checkpoint indices (`cp_00`, `cp_01`, ...) must be contiguous from 0.
- The scene must contain `ai_spline_main`.

If validation fails, the script prints the offending objects and exits non-zero.

## Conventions

See [../docs/blender-conventions.md](../docs/blender-conventions.md) for the full naming and metadata reference.
