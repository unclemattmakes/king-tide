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
  (`tools/blender/hoverbike_addon/`, a package) is the user-facing
  entry point; `build_*.py` files regenerate `.blend`s from JSON specs.

## Blender connector — optional

If a Blender MCP connection is configured for the session, Claude can:

- Read the active `.blend` file's contents (objects, modifiers, materials,
  collections, custom properties) without exporting.
- Execute arbitrary `bpy` Python inside the running Blender, or headlessly via
  `blender --background` (the `_for_cli` tool variants).
- Take viewport / area screenshots, jump the 3D view to specific objects,
  render thumbnails.
- Search the bundled Blender Python API reference and user manual.

Setup (optional — code-only work doesn't need it):

- **Server side** — [projects.blender.org/lab/blender_mcp](https://projects.blender.org/lab/blender_mcp).
- **In-Blender extension** — built from the same repo's `addon/blender_mcp_addon/`.
  Listens on `localhost:9876`, auto-starts on Blender launch.
- **`BLENDER_EXE`** should point at the Blender 5.1 executable for the `_for_cli`
  tools and `pnpm gen:*` scripts. Examples:
  - Linux: `/opt/blender/blender`
  - macOS: `/Applications/Blender.app/Contents/MacOS/Blender`
  - Windows: `C:\Program Files\Blender Foundation\Blender 5.1\blender.exe`

If Claude can't reach Blender, the usual cause is Blender not running, or the
addon's TCP server having been stopped from its preferences panel.

## Asset `kind` registry

Object-extras `kind` values that flow Blender → glTF → runtime live in two
mirrored files:

- `tools/blender/hoverbike_kinds.py` — Python-side constants. Use
  `ExportedKind.TRACK` etc. when tagging objects, not string literals.
- `src/engine/asset-kinds.ts` — TypeScript-side constants. Use
  `ExportedKind.TRACK` when reading `obj.userData.kind`.

The unit test `tests/unit/asset-kinds.test.ts` parses both files and fails
if they drift — adding a value to one side without the other is caught at
CI time.

Python-only kinds (authoring helpers that never ship in the GLB) live in
`AuthoringKind` in the same Python file with no TS counterpart.

Use the constants at all new sites. There's still a long tail of literal
string sites in `hoverbike_addon/_legacy.py` and `seed_*.py` waiting for a
follow-up migration pass — feel free to fix them opportunistically.

## Hoverbike addon — installation

The Hoverbike addon is a package directory (`tools/blender/hoverbike_addon/`)
that Blender loads from a user scripts dir. To keep the repo and the install
in sync, run once:

```
pnpm install:blender-addon
```

It symlinks the package directory into
`<blender-user-scripts>/addons/hoverbike_addon/` so every code change is
picked up by Blender's next "Reload Scripts" (`F3 → Reload Scripts`) without
a manual copy. Falls back to a recursive copy on Windows without Developer
Mode; the script prints how to enable it. Also handles the pre-package
single-file install — backs up any leftover `hoverbike_addon.py` from the
old layout to `.bak`.

If panels or operators disappear from the N-panel after pulling, the installed
addon has drifted — re-run `pnpm install:blender-addon` (or check that the
symlink wasn't broken by a deleted worktree).

## Blender automation roadmap

Open items for Blender-side automation live in
[docs/blender-wishlist.md](docs/blender-wishlist.md). These are good
contribution targets.
