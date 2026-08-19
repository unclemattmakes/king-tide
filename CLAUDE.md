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

1. **Verify locally before you push — but CI is real signal again (2026-08-13).**
   Always run `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build` (plus
   `pnpm test:blender` for Hoverbike-addon changes) before landing. The
   pre-push hook that runs `pnpm verify` is **opt-in and off by default** —
   `git config core.hooksPath .githooks` once per clone, or nothing gates your
   push at all. Maintainers can also bypass branch protection on `main`
   (`enforce_admins` is off), so a direct push runs no remote checks either:
   see [maintainer-workflow.md](docs/maintainer-workflow.md).
   What changed: every workflow had been
   dying at setup since 2026-06-25 — `pnpm/action-setup@v6` hard-errors when a
   `version:` input is combined with package.json's `packageManager` pin — so
   the old advice here was "don't trust CI, it aborts on a spending limit".
   That diagnosis was wrong and the failure is fixed (#416). **A red check now
   means something.** Read it before assuming it's infrastructure.
   What CI actually covers: **`check-and-build` and `docs` are the real
   gates** — typecheck, lint, unit tests, build, docs build. `determinism`,
   `e2e` and `QA report` all boot real tracks, so they hydrate assets from R2
   and **skip with a `::warning::` when `RCLONE_CONF_BASE64` is absent** — a
   green run there means "not exercised", not "passed", on forks *and* on the
   main repo (the secret has never been set).
   **Don't just set that secret expecting the gates to light up.** Measured
   2026-08-17 by setting it on a clone: hydration works fine, then the specs
   fail on runner hardware — GitHub runners have no GPU, headless Chromium
   falls back to SwiftShader, and a WebGPU track boot can't finish inside the
   specs' waits. QA matrix 14/14 cells failed (`waitForFunction` 20 s);
   determinism 2 passed / 1 failed in 7.7 min (30 s wait, 120 s test timeout).
   These gates need GPU-capable (self-hosted) runners, or CI-specific
   timeouts, before the secret buys anything but red. Same root cause as hard
   rule 2's "keep it headed".

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
[bikes + ComfyUI prompts](docs/bike-art-direction.md) ·
[UI/HUD](docs/ui-art-direction.md) ("Regatta" painted race-day signage — UI tokens
in `index.html`, product name in `src/engine/branding.ts`, verify with
`pnpm gen:ui-shots <label>`). The look in-engine + the
mesh-intake pipeline: [painterly-vinyl-pipeline.md](docs/painterly-vinyl-pipeline.md).
Deepening the render model (TF2 illustrative lighting, contrast-budget grade) +
using style to make gameplay events legible at speed:
[painterly-legibility-plan.md](docs/painterly-legibility-plan.md).

**Track content** — [track-themes.md](docs/track-themes.md) (content bible) +
canonical per-track design docs under [docs/tracks/](docs/tracks/README.md), which
supersede the bible's stat blocks where they disagree.

**Authoring pipelines**
- Tracks — **start at [level-making](docs/level-making.md)** (newcomer hub: reading
  order, the build pipeline end-to-end, and the Blender↔editor export-ownership
  contract). Build-from-scratch pass workflow:
  [level-design-playbook](docs/level-design-playbook.md) (canonical). Underlying
  tools: Blender geometry [blender-pipeline-guide](docs/blender-pipeline-guide.md)
  + in-app editor for gameplay data [track-editor-guide](docs/track-editor-guide.md).
  Dressing a finished track with props/foliage:
  [track-art-pass-playbook](docs/track-art-pass-playbook.md).
- Bikes — one `.blend` per variant in `bikes-src/`, exported via the addon; see
  the bike section of [asset-pipeline-guide](docs/asset-pipeline-guide.md) +
  [bike-art-direction](docs/bike-art-direction.md).
- QA gates + manual playtest checklist: [qa-playbook.md](docs/qa-playbook.md).
- Pushing to `main` (who is gated by what, when to PR):
  [maintainer-workflow.md](docs/maintainer-workflow.md).
- Judging a dependabot PR: [dependency-triage.md](docs/dependency-triage.md) —
  a green `pnpm verify` is **not** sufficient for a runtime bump (rapier 0.20
  passed every test while moving the bike 47 cm); use the determinism harness.

**Dev / tool scenes** — URL-param modes in
[src/boot/url-modes.ts](src/boot/url-modes.ts) (`?viewer` bike, `?propviewer=<id>`,
`?calibrate`, `?rideredit`, `?waveriders`, `?waterlab`, `?podium`, `?edit`); the prop viewer is
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
