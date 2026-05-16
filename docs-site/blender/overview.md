# Blender pipeline overview

The Hoverbike asset pipeline runs through **Blender 5.1+**. Most of
what you build in Blender exports to a single `.glb` per track or
per bike, which the runtime loads at boot. The pipeline has three
distinct surfaces:

1. **The in-Blender addon** (`tools/blender/hoverbike_addon/`) — a
   sidebar in Blender's 3D viewport with one-click **Export to
   Game** buttons, parametric authoring tools (road, tunnel, ramp,
   downtown), and live previews of gates / racers / water that
   follow your edits.
2. **Headless builders** (`tools/blender/build_*.py`) — Python
   scripts run via `blender --background`. Pair with JSON specs to
   produce GLBs in CI / batch.
3. **Seed scripts** (`tools/blender/seed_*.py`) — one-shot
   generators that materialise canonical `.blend` files (template
   islands, prop libraries, calibration scene) from code.

Authoring usually means **opening an existing `.blend`, editing,
clicking Export**. The seed scripts are how those `.blend`s get
created in the first place; the headless builders are how CI keeps
the canonical scenes in sync with their JSON specs.

## What the addon gives you

Once installed, press **N** in any 3D viewport → **Hoverbike** tab
to reveal the panel. It re-renders based on whether the open
`.blend` lives in `tracks-src/` or `bikes-src/`.

In **track mode** the panel exposes 12 collapsible sub-panels:

| Sub-panel | Drops you into |
|---|---|
| Spline tools | Editing the racing line, snapping it to terrain, auto-placing ramps at curvature peaks. |
| Placement helper | A persistent curve-constrained empty for parking ramps / boosts / props at any (t, offset). |
| Road tool | Bezier curve → drivable road slab with banking, F1 curbs, terrain conform. |
| Tunnels | Bezier curve → boolean cut through the hill + concrete-liner interior shell. |
| Ramps | Drop a parametric stunt wedge at the 3D cursor. |
| Terrain | Heightmap import, sculpt-mode entry, raise/lower at cursor, smooth, AO + path-wear bakes. |
| Water | Sea-level slider + wave preview plane. |
| Downtown | Procedural city block at the 3D cursor (multi-block grid, terrain-conformed plinth). |
| Gameplay | Gates, boost pads, racer preview, turn indicators — placement + previews. |
| Ghost lap + chase cam | Auto-flying preview bike along the racing line. |
| Terrain shader (runtime) | Tunes the runtime ramp / slope / wet-band / coloration without touching the .ts. |
| Track stats | Spline length, lap-time estimate, terrain min/max y, water coverage. |

In **bike mode** the panel is much smaller — header with bike id,
**Export Bike to Game**, **Copy Play / Viewer URL**.

Both modes share a **Lint** button (pre-export sanity check) and a
**Reload from JSON** button (pulls scalar fields back from the
runtime JSON into the scene custom properties).

For the full operator + panel reference, see [Addon reference](./addon-reference).

## What lives where

```text
tools/blender/
├── hoverbike_addon/             ← in-Blender addon (package)
│   ├── __init__.py              ← bl_info + per-module register
│   ├── panel.py                 ← sidebar UI
│   ├── road.py · tunnel.py · ramp.py · downtown.py · terrain.py
│   ├── spline.py · placement_helper.py · turn_indicators.py
│   ├── water.py · previews.py · ghost_lap.py · boost_pad.py · bake.py
│   ├── export.py · track_meta.py · terrain_shader.py
│   ├── handlers.py              ← live-preview auto-rebuild
│   └── _legacy.py               ← validation + JSON sync (shared infra)
│
├── build_bike.py                ← headless bike → GLB
├── build_track.py               ← spec-driven track → .blend + GLB
├── build_prop.py                ← spec-driven prop → GLB
│
├── seed_template_island.py      ← procedural island scene
├── seed_template_alpine.py      ← procedural alpine scene
├── seed_template_dunes.py       ← procedural dunes scene
├── seed_template_mesa.py        ← procedural mesa scene
├── seed_template_downtown.py    ← procedural downtown scene
├── seed_template_tunnels.py     ← procedural tunnels-through-hills scene
├── seed_props_library.py        ← rebuilds tracks-src/props-library.blend
├── seed_prop_kit.py             ← rebuilds tools/blender/lib/prop_kit.blend
│
├── run.mjs                      ← Node CLI for headless batch builds
├── install-addon.mjs            ← symlinks the addon for live editing
├── test-addon.mjs               ← smoke-tests addon registration
├── inspect_glb.mjs              ← quick GLB inspection (extensions, nodes)
│
├── common.py · sockets.py · colliders.py · mounts.py
└── lib/                         ← committed source-art kits
    └── prop_kit.blend
```

Outside `tools/blender/` the relevant directories are:

| Path | Contents |
|---|---|
| `bikes-src/<id>.blend` | One per bike — the geometry source of truth. |
| `tracks-src/<id>.blend` | One per track — editing this is the canonical track workflow. |
| `tracks-src/props-library.blend` | Linked-library source for `prop_gate_mesh` (the real gate prop) and other shared props. |
| `tracks-src/template-*.blend` | Seed-generated template scenes (island, alpine, dunes, mesa, downtown, tunnels). |
| `specs/bikes/<id>.json` | Slim metadata + recolour overrides for each bike. |
| `specs/tracks/<id>.json` | Declarative spec for spec-driven tracks (the headless builder reads these). |
| `specs/props/<id>.json` | Parametric specs for kit-assembled props. |
| `public/assets/tracks/<id>.glb` | Output track environment GLBs. |
| `public/tracks/<id>.json` | Output track gameplay data — round-trips with the .blend. |
| `public/assets/bikes/<id>.glb` | Output bike GLBs. |
| `public/assets/manifest.json` | Index of every built asset (driven by `gen:tracks` / `gen:bikes` / `gen:props`). |

## One-time setup

1. **Install Blender 5.1+.** Typical paths:
   - Windows: `C:\Program Files\Blender Foundation\Blender 5.1\blender.exe`
   - macOS: `/Applications/Blender.app/Contents/MacOS/Blender`
   - Linux: `/opt/blender/blender`

2. **Set `BLENDER_EXE`** if Blender isn't on your `PATH` — the
   headless builders and `pnpm gen:*` scripts use it to find the
   executable. Add to your shell rc or set it per-session.

3. **Install the addon as a symlink** so every edit in the repo is
   live in Blender after `F3 → Reload Scripts`:

   ```bash
   pnpm install:blender-addon
   ```

   The script symlinks `tools/blender/hoverbike_addon/` into your
   Blender user scripts directory (`%APPDATA%\Blender\5.1\scripts\addons\`
   on Windows, `~/Library/Application Support/Blender/...` on macOS,
   `~/.config/blender/...` on Linux). On Windows without Developer
   Mode it falls back to a recursive copy; the script prints how to
   enable symlinks.

4. **Enable the addon in Blender.** Edit → Preferences → Add-ons →
   search "Hoverbike" → tick the checkbox. You only need to do this
   once.

5. **Smoke-test the install:**

   ```bash
   pnpm test:blender
   ```

   Runs Blender headless, registers the addon, asserts every
   operator + panel registers cleanly. Should print
   `all 57 HOVERBIKE_OT/PT classes register cleanly`.

If a panel or operator disappears from the N-panel after pulling,
the installed addon has drifted — re-run `pnpm install:blender-addon`
(or check that the symlink wasn't broken by a deleted worktree).

## The contract: Blender objects ↔ runtime

Every metadata-bearing object in a `.blend` has a `kind` custom
property declaring what the runtime should do with it. The
exporter copies custom properties verbatim into glTF `extras`; the
runtime loader (`src/game/tracks/glb-loader.ts`) walks the GLB
nodes and reads `extras.kind`.

For the full naming + extras matrix see [Scene conventions](./scene-conventions).

## Where to go next

- **Building your first track from scratch?** → [Your first track](./your-first-track) — full walk-through from blank scene to playable map.
- **Want a comprehensive reference of every panel + operator?** → [Addon reference](./addon-reference).
- **Need the at-a-glance kind / extras matrix?** → [Scene conventions](./scene-conventions).
- **Authoring a bike, not a track?** → [Modding → Authoring bikes](/modding/bikes).
- **CI / batch builds?** The headless `pnpm gen:tracks` / `pnpm gen:bikes` / `pnpm gen:props` scripts are documented inline in [Addon reference → Headless builders](./addon-reference#headless-builders).
