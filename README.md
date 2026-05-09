# Hoverbike

Web-first arcade hover-bike racer. JetMoto homage with Wave Race water physics and light Mario Kart combat. Three.js + WebGPU + Rapier WASM, gamepad-first.

**Live:** [hoverbike-...vercel.app](https://hoverbike-ciaqaossl-oddballcreatureclubs-projects.vercel.app) — every push to `main` auto-deploys.

- [Status](docs/status.md) — current state, controls, known issues, roadmap
- [Product plan](docs/product-plan.md) — vision + MVP scope
- [Implementation plan](docs/implementation-plan.md) — architecture + milestones
- [In-app track editor](docs/track-editor-guide.md) — authoring gameplay data
- [Blender pipeline](docs/blender-pipeline-guide.md) — authoring environment geometry
- [Blender conventions](docs/blender-conventions.md) — quick-reference for the legacy all-in-glb path
- [Dev + modder docs site](docs-site/) — VitePress site (`pnpm docs:dev`) covering build, gameplay, asset pipeline, and reference

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

```bash
pnpm install
pnpm dev          # http://localhost:5191
pnpm test         # unit (Vitest), sim layer only
pnpm e2e          # end-to-end (Playwright, real Vite + WebGPU/WebGL2)
pnpm typecheck
pnpm exec biome check --write .   # format + lint

pnpm docs:dev     # http://localhost:5173 — VitePress dev/modder docs site
pnpm docs:build   # → docs-site/.vitepress/dist
```

Try `pnpm dev` then open http://localhost:5191/?track=cliffside&bike=stunt for the most fun config.

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
