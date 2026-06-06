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

## CI is unreliable — verify locally

GitHub Actions for this repo regularly runs out of Actions minutes (the account
hits its spending limit and every job aborts at setup without running — a ~2s
"recent account payments have failed / spending limit" failure on `check-and-build`,
`e2e`, `docs`, etc.). **Don't gate work on green CI or wait for it.** Verify locally
before landing: `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build`, and
`pnpm test:blender` for Hoverbike-addon changes.

## Design direction (v2 — content restart in progress)

Near-future post-warming world: coastal cities drowned, arcade hoverbike racing
is the post-collapse spectator sport; every track is a recognizable real-world
place seen post-flood.

**Where we are:** v1 hit "complete" by v1 standards, then we **blew past it and
restarted content for v2.** So `status: 'ship'` in the catalog means
"wired/playable," **not** "art-complete" — only **Sandbar, The Maw, South Beach
Sunken** are dressed today; the rest are greybox route-stubs awaiting the v2
environment-art pass.

**Signature mechanic — wave mastery (v2).** Took the Mario-Kart fork: **not**
"press forward on the crest for a boost" (the old Wave-Race pump) but **motocross
"master the jump"** — pitch the takeoff off a crest/ramp, pitch the landing;
pitch genuinely drives how the bike rides the swell. The pieces exist (hover
dive/release-kick, tuck sweet-spot, geometric pop tricks); the open work is making
that skill **legible + graded** (like the tuck meter) and refitting the wave-pump
chyron / wave-line shimmer, which were built for the press-forward model.

**Anti-grav is cut** (parked for a possible future DLC — a fun/shippability
pandora's box). `anti-grav.ts` + HUD + Blender tools stay **parked, not active
content**; no shipped track places anti-grav zones. Docs/changelog entries calling
anti-grav "shipped" are v1-historical.

**Real remaining work:** the wave-mastery legibility/refit above, the v2 track-art
pass, a **60 fps @ 8-bike perf pass on target hardware** (Deck / 3070 / iPhone —
currently unmeasured there), and **soundtrack licensing** (today's 14 tracks are
CC0 placeholders). See [docs/status.md](docs/status.md). Key planning docs:

- [docs/product-plan.md](docs/product-plan.md) — locked vision and pillars.
- [docs/design-targets.md](docs/design-targets.md) — numeric targets, P0/P1/P2
  priorities, anti-targets from the Pacer / MK World failure modes.
- [docs/track-themes.md](docs/track-themes.md) — 12 ship tracks + tutorial,
  full content bible with set-pieces, palettes, lore tags.
- [docs/art-direction.md](docs/art-direction.md) — **canonical art direction**
  (v2): post-apocalyptic solarpunk, the **painterly-vinyl toy** register
  (hand-painted *Sea of Thieves* surface on a *Team Fortress 2* silhouette, no
  outlines), the built/broken/blooming material-state rule, the shader-driven
  waterline, the prop- + level-builder checklists, and the concept-art `--sref`
  recipe. Read before building or dressing any prop or level. Per-domain
  companions: [art per track](docs/track-art-direction.md),
  [art per prop family + ComfyUI prompts](docs/prop-art-direction.md),
  [art per bike + ComfyUI prompts](docs/bike-art-direction.md).
- [docs/tracks/](docs/tracks/README.md) — **canonical per-track design docs**
  (one per track) with unique + common prop manifests. Embodies the
  **no-anti-grav** direction (anti-grav cut from the game — parked for a possible
  future DLC; verticality is terrain,
  ramps, banked berms, cliff drops). Supersedes the per-track stat blocks in
  the bible / specs where they disagree.
- [docs/v1-work-breakdown.md](docs/v1-work-breakdown.md) — execution plan:
  Step 0 scaffolding (full menu flow stubbed with disabled buttons),
  per-domain task inventory, and the **definition-of-done convention** —
  a system isn't done until it works *and* has a settings-menu entry *and*
  its UI gate is cleared *and* any UI it adds is navigable by keyboard,
  controller, and touch (the **input-navigability convention** in the same
  doc — read it before adding any new menu/overlay/modal).

## Authoring pipelines

- **Tracks** — split between Blender (environment geometry) and the in-app editor
  (gameplay data). See [docs/blender-pipeline-guide.md](docs/blender-pipeline-guide.md)
  and [docs/track-editor-guide.md](docs/track-editor-guide.md). For dressing an
  existing gameplay-complete track with props/foliage (placement, AI-corridor
  clearance, GLB re-export that preserves the authored JSON, headless-verify
  gotchas), see [docs/track-art-pass-playbook.md](docs/track-art-pass-playbook.md).
- **Bikes** — one `.blend` per variant in `bikes-src/`, exported via the
  Hoverbike addon. See the bike section in
  [docs/asset-pipeline-guide.md](docs/asset-pipeline-guide.md). Per-variant art
  direction + ComfyUI concept prompts:
  [docs/bike-art-direction.md](docs/bike-art-direction.md).
- **The look / props** — how the painterly-vinyl look is achieved in-engine +
  the multi-point mesh-intake pipeline (shape-only → fully textured):
  [docs/painterly-vinyl-pipeline.md](docs/painterly-vinyl-pipeline.md). Validate +
  tune props in the stand-alone **prop viewer** (`?propviewer=<assetId>`,
  [src/viewer/prop-viewer.ts](src/viewer/prop-viewer.ts)). Other dev/tool scenes
  are URL-param modes in [src/boot/url-modes.ts](src/boot/url-modes.ts) (`?viewer`
  bike, `?calibrate`, `?rideredit`, `?waveriders`, `?podium`, `?edit`) — a dev
  menu linking them is a TODO (see [docs/status.md](docs/status.md)).
- **Blender scripts** live in `tools/blender/`. The Hoverbike addon
  (`tools/blender/hoverbike_addon/`, a package) is the user-facing
  entry point; `build_*.py` files regenerate `.blend`s from JSON specs.

## Asset storage — raw vs. compiled

Raw authoring sources (`tracks-src/*.blend`, `bikes-src/*.blend`) live in a
**Google Drive for Desktop** folder, **out of git** (`*.blend` is
gitignored) — the app auto-syncs every save, so there's no manual sync step.
Authors edit `.blend`s in that folder and point the Blender addon at their
repo clone via its *Project root* preference (or `$HOVERBIKE_REPO_ROOT`) so
exports still land in `public/`/`specs/`. Compiled exports under
`public/assets/` + `public/audio/` (GLBs, thumbs, atlases, opus) are served
from **Cloudflare R2** (bucket `hoverbike-content`, gitignored — *not* git/LFS);
the app fetches them via `VITE_ASSET_BASE_URL` ([src/engine/asset-url.ts](src/engine/asset-url.ts)).
Run `pnpm assets:pull` to hydrate a fresh clone for offline dev, `assets:push`
after a re-export. Full convention in [docs/asset-storage.md](docs/asset-storage.md).

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
