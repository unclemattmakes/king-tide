# Hoverbike

Web-first arcade hover-bike racer. JetMoto homage with Wave Race water physics and light Mario Kart combat. Three.js + WebGPU + Rapier WASM, gamepad-first.

**Live:** [hoverbike-...vercel.app](https://hoverbike-ciaqaossl-oddballcreatureclubs-projects.vercel.app) — every push to `main` auto-deploys.

- [Status](docs/status.md) — current state, controls, known issues, roadmap
- [Product plan](docs/product-plan.md) — vision + MVP scope
- [Implementation plan](docs/implementation-plan.md) — architecture + milestones
- [Architecture decisions](docs/adr/README.md) — ECS, sim/render split, WebGPU, Rapier
- [In-app track editor](docs/track-editor-guide.md) — authoring gameplay data
- [Blender pipeline](docs/blender-pipeline-guide.md) — authoring environment geometry
- [Blender conventions](docs/blender-conventions.md) — quick-reference for the legacy all-in-glb path
- [Dev + modder docs site](docs-site/) — VitePress site (`pnpm docs:dev`) covering build, gameplay, asset pipeline, and reference
- [Contributing](CONTRIBUTING.md) — workflow, conventions, testing expectations
- [Cross-browser support](docs/cross-browser.md) — tier matrix + how to run `E2E_BROWSERS=all pnpm e2e`
- [Steam Deck build path](docs/steam-deck.md) — Tauri 2 wrapper, profile defaults, on-device testing

## Build targets

- **Web** — Chrome / Edge (tier 1), Firefox (tier 1), Safari iOS 18.2+ / macOS Sonoma+ (tier 2). See [`docs/cross-browser.md`](docs/cross-browser.md).
- **Steam Deck** — Tauri 2 wrapper around the web build, planned. See [`docs/steam-deck.md`](docs/steam-deck.md) for the layout, profile, and testing notes.

## What's playable

- **Two tracks** — Lagoon Loop (default) and Cliffside (`?track=cliffside`, with the JetMoto-style cliff drop)
- **Three bike variants** — Cruiser / Racer / Stunt with distinct stat tradeoffs (`?bike=cruiser|racer|stunt`)
- **Four pickups** — boost, shield, mine, homing missile (random pool)
- **4 AI opponents** — spline-following with rubber-band, fire their own pickups
- **3-lap races** with checkpoint enforcement and lap-completion fanfare
- **Best-lap save state** per (track, bike) in localStorage
- **Garage menu** for picking bike + track + viewing records (HUD button top-right)
- **Procedural audio** — engine pitch tied to speed, water ambient, pickup chime, weapon SFX, gate / lap cues, mute toggle (M)
- **In-app track editor** — `?edit=1` opens a TransformControls-based editor over a JSON snapshot of the lagoon stadium; gates / pickups / boost pads / spline points are placeable + drag-manipulable; Save writes back to disk via a dev-only Vite middleware

## Develop

Prerequisites: **Node ≥ 20**, **pnpm ≥ 10** (`engines` in `package.json`). A
WebGPU-capable browser (recent Chrome / Edge) gives the best feel; Firefox
runs the WebGL2 fallback.

```bash
pnpm install
pnpm dev          # http://localhost:5191
pnpm typecheck
pnpm lint                          # biome check .
pnpm format                        # biome format --write .
pnpm test         # unit (Vitest), sim layer only

pnpm e2e:install  # one-time: pulls Playwright Chromium
pnpm e2e          # end-to-end (Playwright, real Vite + WebGPU/WebGL2)

pnpm docs:dev     # http://localhost:5173 — VitePress dev/modder docs site
pnpm docs:build   # → docs-site/.vitepress/dist
```

Try `pnpm dev` then open http://localhost:5191/?track=cliffside&bike=stunt for the most fun config.

### Multiplayer dev

Multiplayer rides on a PartyKit relay (`party/relay.ts`). For local
two-tab testing, run the relay alongside the dev server:

```bash
pnpm party:dev    # PartyKit on http://127.0.0.1:1999
pnpm dev          # in another terminal
```

Open two tabs at `http://localhost:5191/?room=test` and the lobby will
match-make them. Without `pnpm party:dev`, `?room=` will fail to
connect — single-player works fine without it.

### Asset pipeline (optional)

Authoring bikes, props, or tracks needs **Blender 5.1**. Linux / macOS /
Windows are all fine; set `BLENDER_EXE` if Blender isn't on your `PATH`.
See [`docs/blender-pipeline-guide.md`](docs/blender-pipeline-guide.md) and
[`docs/asset-pipeline-guide.md`](docs/asset-pipeline-guide.md).

```bash
pnpm gen:bikes    # build bike GLBs from specs/bikes/*.json
pnpm gen:props    # build prop GLBs from specs/props/*.json
pnpm gen:tracks   # build track GLBs from specs/tracks/*.json
pnpm gen:all      # all of the above + manifest
```

You don't need Blender to work on code — only to author assets.

### Troubleshooting

- **bitECS schema changes**: hard-reload (Ctrl/Cmd+Shift+R) — stale
  bitECS state in the page can cause cryptic errors.
- **WebGPU not available**: Firefox runs the WebGL2 fallback automatically;
  on Chrome, check `chrome://gpu/` if performance is unexpectedly bad.
- **`pnpm e2e` is slow / flaky**: it needs a real GPU. Headless software
  rendering throttles the water shader. Locally, the suite runs headed by
  default for that reason — see [`playwright.config.ts`](playwright.config.ts).

## Deploy

The repo backs **two** Vercel projects, both pointing at the same GitHub repo, both auto-deploying on push to `main`.

| Project | Root Directory | Build settings | Notes |
|---|---|---|---|
| **Game** | `.` (repo root) | defaults — `pnpm build` → `dist/` | The existing live build. |
| **Docs** | `docs-site` | comes from [`docs-site/vercel.json`](docs-site/vercel.json) | VitePress build. Configures `installCommand`, `buildCommand`, `outputDirectory` itself. |

### One-time setup for the docs project

In the Vercel dashboard (team `oddballcreatureclubs-projects`):

1. **Add New → Project**, import the `occ-matt/hoverbike` repo.
2. In the import screen, set **Root Directory** to `docs-site`. Leave Framework Preset as auto-detect (it will pick VitePress from `vercel.json`).
3. The dashboard's Build Command, Output Directory, and Install Command are overridden by `docs-site/vercel.json` — leave them at defaults.
4. **Deploy.** First build runs `cd .. && pnpm install --frozen-lockfile` then `cd .. && pnpm docs:build`, output reads from `docs-site/.vitepress/dist`.

After that, every push to `main` triggers a docs rebuild alongside the game rebuild. The docs project gets its own `*.vercel.app` URL; assign a custom domain (e.g. `docs.<yourdomain>`) when ready.

### Why two projects, not one?

Vercel projects bind to a single Build Command + Output Directory. The game and the docs have different ones, so they live in separate projects. They share the repo, the lockfile, and the `node_modules` install — `cd ..` in the docs `vercel.json` reaches up to the workspace root.

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict, exactOptionalPropertyTypes) |
| Build | Vite |
| Renderer | Three.js, WebGPU-first with WebGL2 fallback |
| Physics | `@dimforge/rapier3d-compat` (deterministic build) |
| ECS | bitECS 0.4 with side-table data stores |
| Audio | Web Audio API, procedurally synthesised (no SFX assets) |
| Test | Vitest (unit, sim-only) + Playwright (e2e via real dev server) |
| Lint/format | Biome |
| Hosting | Vercel push-to-deploy |

## Architecture rule

**Sim layer cannot import Three.js.** Anything under `src/engine/sim/` or `src/game/systems/` must be Three-free. Render systems read from the ECS world and write to Three.js objects, never the other way around. This unlocks headless tests, deterministic replays, and future rollback netcode.

See [`docs/adr/`](docs/adr/README.md) for the full set of architecture decisions.

## Known issues

- **Cliffside AI** — the AI racers occasionally fall off the mesa on the descending corner and can't recover. Tracked as a level-design fix (widen the mesa / add a side ramp). Affects entertainment value of AI-only playback on Cliffside; player-only races and human multiplayer are unaffected.
- **Multiplayer e2e coverage** — M10.11 transform-snapshot sync is covered by unit tests + manual playtest; a two-tab Playwright probe is not yet automated. Bugs that only manifest cross-tab need to be reproduced manually.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for workflow, branch conventions, commit style, testing expectations, and architecture rules contributors must respect. Security issues: [`SECURITY.md`](SECURITY.md).
