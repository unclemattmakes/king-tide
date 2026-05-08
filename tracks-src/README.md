# Track sources

Authoritative `.blend` files for **environment geometry** in our hybrid
track pipeline. Gameplay data (gates, pickups, boost pads, AI spline)
lives separately in `public/tracks/<id>.json` and is authored via the
in-app editor — see [../docs/track-editor-guide.md](../docs/track-editor-guide.md).

- `calibration.blend` — minimal scene with one of every metadata object
  kind. Reference + integration test for the legacy all-in-glb export
  pipeline. New tracks should keep .blend content focused on collidable
  environment geometry only.

## Outputs

- `.glb` outputs go to `public/assets/tracks/`. The corresponding JSON
  in `public/tracks/<id>.json` references its `.glb` via `environmentGlb`.
- See [../docs/blender-pipeline-guide.md](../docs/blender-pipeline-guide.md)
  for the export workflow.

## When to author here vs. the in-app editor

- **Blender (.blend → .glb here):** track surface meshes, ramps, mesa,
  cliff faces, decorative geometry, anything the bike collides with.
- **In-app editor (JSON in `public/tracks/`):** start pose, checkpoints,
  AI racing line, pickup spawns, boost pad placement, water tuning.

The legacy all-in-glb path (gates + spline baked into Blender extras)
still works — `tools/export_track.py` validates and exports it — but the
hybrid path is preferred for new tracks because the editor's iteration
loop is much faster than re-exporting from Blender for every gate move.
