# Track sources

Authoritative `.blend` files for tracks. See [../docs/blender-conventions.md](../docs/blender-conventions.md) for naming and metadata rules.

- `calibration.blend` — minimal scene with one of every metadata object kind. Reference + integration test for the export pipeline.

`.glb` outputs go to `public/assets/tracks/` (gitignored only if the source is checked in — currently both are tracked).
