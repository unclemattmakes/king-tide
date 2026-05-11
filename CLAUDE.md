# Claude project notes — Hoverbike

This file is read automatically by Claude sessions when they open this repo.
Keep it short. Pointers to existing docs are better than duplicated content.

## Project shape

Web-first arcade hover-bike racer. Three.js + WebGPU + Rapier WASM. Architecture
notes live in [docs/implementation-plan.md](docs/implementation-plan.md); current
status in [docs/status.md](docs/status.md). The repo's [README.md](README.md) is
the canonical entry point.

The sim layer cannot import Three.js. Render systems read from the ECS world and
write to Three.js objects, never the other way around.

## Authoring pipelines

- **Tracks** — split between Blender (environment geometry) and the in-app editor
  (gameplay data). See [docs/blender-pipeline-guide.md](docs/blender-pipeline-guide.md)
  and [docs/track-editor-guide.md](docs/track-editor-guide.md).
- **Bikes** — one `.blend` per variant in `bikes-src/`, exported via the
  Hoverbike addon. See the bike section in
  [docs/asset-pipeline-guide.md](docs/asset-pipeline-guide.md).
- **Blender scripts** live in `tools/blender/`. The Hoverbike addon
  (`tools/blender/hoverbike_addon.py`) is the user-facing entry point;
  `build_*.py` files regenerate `.blend`s from JSON specs.

## Blender connector — INSTALLED AND READY

A Blender MCP connection is configured and live. This means Claude can:

- Read the active `.blend` file's contents (objects, modifiers, materials,
  collections, custom properties) without exporting.
- Execute arbitrary `bpy` Python inside the running Blender, or headlessly via
  `blender --background` (the `_for_cli` tool variants).
- Take viewport / area screenshots, jump the 3D view to specific objects,
  render thumbnails.
- Search the bundled Blender Python API reference and user manual.

Components:

- **Cowork-side MCP server** — installed as a Cowork extension. Source:
  [projects.blender.org/lab/blender_mcp](https://projects.blender.org/lab/blender_mcp).
- **In-Blender extension** — built from the same repo's `addon/blender_mcp_addon/`,
  installed as the user-default extension named "MCP". Listens on `localhost:9876`,
  auto-starts on Blender launch. `BLENDER_PATH` should point at
  `C:\Program Files\Blender Foundation\Blender 5.1\blender.exe` for the `_for_cli`
  tools.

If Claude can't reach Blender, the usual cause is Blender not running, or the
addon's TCP server having been stopped from its preferences panel.

## Wishlist for Blender-side automation

Things Matt wants Claude to build on top of the connector: see
[docs/blender-wishlist.md](docs/blender-wishlist.md).
