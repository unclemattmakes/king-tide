# Claude project notes — Hoverbike

Loaded into every Claude session in this repo, so keep it short: an **index** of
where to look, plus the few rules that prevent real mistakes. Detail lives in the
linked docs — extend those rather than growing this file.

## Start here

- [README.md](README.md) — canonical entry point: what's playable, how to run,
  tech stack, build targets.
- [docs/status.md](docs/status.md) — current state. **Read the top banner** —
  much of the older changelog below it is v1-historical.
- [docs/implementation-plan.md](docs/implementation-plan.md) — architecture + milestones.
- [docs/adr/](docs/adr/README.md) — architecture decisions (ECS, sim/render split,
  WebGPU, Rapier, drift).
- [CONTRIBUTING.md](CONTRIBUTING.md) — workflow, conventions, testing expectations.

## Hard rules (don't get these wrong)

1. **Don't trust CI — verify locally.** GitHub Actions for this repo regularly
   aborts at setup on a spending-limit failure (a ~2s failure on every job).
   Don't gate work on green CI or wait for it. Before landing, run
   `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build` (plus
   `pnpm test:blender` for Hoverbike-addon changes).

2. **Verify with headed Playwright on _your own_ dev server — not the in-app preview.**
   For any visual/feel work the primary check is **headed Playwright** (`pnpm e2e`
   runs headed by default — real GPU): `E2E_PORT=<N> pnpm e2e <spec>` starts and
   owns its own server on `<N>`. Drive your own browser against a server **you**
   started — **never** the Claude in-app preview or a shared tab via the web
   extension. **Author a focused test scene/spec to isolate what you're verifying**
   (a targeted e2e spec, a URL-param dev mode in
   [src/boot/url-modes.ts](src/boot/url-modes.ts), or a greybox/spec test track)
   rather than hunting inside a full level. Instances run in parallel and
   `pnpm dev` cascades ports (`strictPort: false`, 5191 → 5192 → …; the preview
   often squats 5191) while Playwright reuses any server already on its port — so
   **pin a unique `<N>` and use `--strictPort`** so a collision errors out instead
   of silently attaching you to a sibling's app. (For manual poking:
   `pnpm dev --port <N> --strictPort` then open `http://localhost:<N>`.) Keep it
   headed — headless software WebGL throttles the water shader.

3. **Sim layer is Three-free.** Nothing under `src/engine/sim/` or
   `src/game/systems/` may import Three.js. Render systems read from the ECS world
   and write to Three objects, never the reverse. (ADR
   [0002](docs/adr/0002-sim-render-separation.md).)

4. **Assets aren't in git.** Raw `*.blend` sources live in a Google-Drive folder
   (gitignored, auto-synced on save); compiled `public/assets/` + `public/audio/`
   are served from Cloudflare R2 (gitignored — *not* git/LFS). `pnpm assets:pull`
   to hydrate a clone, `pnpm assets:push` after a re-export. Don't try to commit
   GLBs/thumbs/opus. Full convention: [docs/asset-storage.md](docs/asset-storage.md).

5. **Asset `kind` constants are mirrored** across
   `tools/blender/hoverbike_kinds.py` and `src/engine/asset-kinds.ts`;
   `tests/unit/asset-kinds.test.ts` fails if they drift. Add a value to **both**
   sides and use the `ExportedKind.*` constants, not string literals.

## Current direction (v2) — orientation only; detail in the docs

Web-first arcade hover-bike racer; near-future post-warming world where every
track is named for a city — real or fictional — seen post-flood.

**Where we are now:** racing mechanics are **in** and in **precision-tuning**;
the Blender level tooling is **in** and ready for real level work; the current
proof-of-thesis is making **shippable versions of the Reef Cup maps** (Mayday Bay →
Mexico City → Cape Town Drift). Verify against that with **headed Playwright**
(hard rule 2), not the preview tool.

Three things that are easy to assume wrong from older docs:

- **Anti-grav is cut** (parked for a possible future DLC). `anti-grav.ts` + HUD +
  Blender tools stay parked; no shipped track places anti-grav zones. Anything
  calling it "shipped" is v1-historical.
- **`status: 'ship'` means wired/playable, not art-complete.** Only **Mayday Bay**
  (the tutorial lagoon, slug `sandbar`) and **The Maw** are dressed; the rest are greybox route-stubs awaiting the v2
  art pass.
- **Signature mechanic is wave mastery** — the motocross "master the jump" model
  (pitch the takeoff/landing), not the old press-forward-on-crest pump.

Vision + targets: [product-plan](docs/product-plan.md) (locked vision/pillars) ·
[design-targets](docs/design-targets.md) (numeric targets, P0/P1/P2, anti-targets) ·
[v1-work-breakdown](docs/v1-work-breakdown.md) (execution plan + definition-of-done +
the **input-navigability convention** — read before adding any menu/overlay/modal).

## Where things live (index)

**Art direction** — [art-direction.md](docs/art-direction.md) is canonical
(painterly-vinyl look, built/broken/blooming material-state rule, shader waterline,
builder checklists, concept-art `--sref` recipe). Per domain:
[tracks](docs/track-art-direction.md) ·
[props + ComfyUI prompts](docs/prop-art-direction.md) ·
[bikes + ComfyUI prompts](docs/bike-art-direction.md). The look in-engine + the
mesh-intake pipeline: [painterly-vinyl-pipeline.md](docs/painterly-vinyl-pipeline.md).

**Track content** — [track-themes.md](docs/track-themes.md) (content bible) +
canonical per-track design docs under [docs/tracks/](docs/tracks/README.md), which
supersede the bible's stat blocks where they disagree.

**Authoring pipelines**
- Tracks — build-from-scratch pass workflow:
  [level-design-playbook](docs/level-design-playbook.md) (canonical). Underlying
  tools: Blender geometry [blender-pipeline-guide](docs/blender-pipeline-guide.md)
  + in-app editor for gameplay data [track-editor-guide](docs/track-editor-guide.md).
  Dressing a finished track with props/foliage:
  [track-art-pass-playbook](docs/track-art-pass-playbook.md).
- Bikes — one `.blend` per variant in `bikes-src/`, exported via the addon; see
  the bike section of [asset-pipeline-guide](docs/asset-pipeline-guide.md) +
  [bike-art-direction](docs/bike-art-direction.md).
- QA gates + manual playtest checklist: [qa-playbook.md](docs/qa-playbook.md).

**Dev / tool scenes** — URL-param modes in
[src/boot/url-modes.ts](src/boot/url-modes.ts) (`?viewer` bike, `?propviewer=<id>`,
`?calibrate`, `?rideredit`, `?waveriders`, `?podium`, `?edit`); the prop viewer is
[src/viewer/prop-viewer.ts](src/viewer/prop-viewer.ts). Asset URLs resolve through
[src/engine/asset-url.ts](src/engine/asset-url.ts) (`VITE_ASSET_BASE_URL`).
In a dev build, **all** of these scenes — plus the live tuners (input/water/camera/brush),
the in-race debug toggles (collision/hover/anti-grav/perf, water wireframe/probe…),
live world controls (time-of-day, freeze water — no reload) and the few genuinely
reload-only render params (backend/aa/rider) — are launchable from the **dev
palette**: the right-edge dock rail + **Ctrl/⌘K** command bar. Registry in
[src/engine/dev/tools.ts](src/engine/dev/tools.ts) (add one entry to surface a new
tool in both surfaces); install point is `startGameLoop` in
[src/boot/game-loop.ts](src/boot/game-loop.ts). Live time-of-day re-bakes the sky
via `SkySystem.setTimeOfDay` ([sky.ts](src/engine/render/sky.ts)).

## Blender

- **Install the addon once:** `pnpm install:blender-addon` symlinks
  `tools/blender/hoverbike_addon/` into Blender's addons dir so code changes are
  picked up on the next *Reload Scripts*. Re-run it if N-panel operators disappear
  after a pull. Scripts live in `tools/blender/`; `build_*.py` regenerate `.blend`s
  from JSON specs.
- **Optional MCP connector** lets a session read/drive a running Blender (or
  `--background` headless via the `_for_cli` variants), screenshot viewports, and
  search the API reference. Needs the `lab/blender_mcp` server + the in-Blender
  extension on `localhost:9876`, and `BLENDER_EXE` → Blender 5.1. Code-only work
  doesn't need it.
- Automation backlog: [docs/blender-wishlist.md](docs/blender-wishlist.md).
