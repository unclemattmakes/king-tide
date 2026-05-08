# Hoverbike

Web-first arcade hover-bike racer. JetMoto homage with Wave Race water physics and light Mario Kart combat. Three.js + WebGPU + Rapier WASM, gamepad-first.

**Live:** [hoverbike-...vercel.app](https://hoverbike-ciaqaossl-oddballcreatureclubs-projects.vercel.app) — every push to `main` auto-deploys.

- [Status](docs/status.md) — current state, controls, known issues, roadmap
- [Product plan](docs/product-plan.md) — vision + MVP scope
- [Implementation plan](docs/implementation-plan.md) — architecture + milestones
- [Blender track conventions](docs/blender-conventions.md) — asset pipeline

## What's playable

- **Two tracks** — Lagoon Loop (default) and Cliffside (`?track=cliffside`, with the JetMoto-style cliff drop)
- **Three bike variants** — Cruiser / Racer / Stunt with distinct stat tradeoffs (`?bike=cruiser|racer|stunt`)
- **Four pickups** — boost, shield, mine, homing missile (random pool)
- **4 AI opponents** — spline-following with rubber-band, fire their own pickups
- **3-lap races** with checkpoint enforcement and lap-completion fanfare
- **Best-lap save state** per (track, bike) in localStorage
- **Garage menu** for picking bike + track + viewing records (HUD button top-right)
- **Procedural audio** — engine pitch tied to speed, water ambient, pickup chime, weapon SFX, gate / lap cues, mute toggle (M)

## Develop

```bash
pnpm install
pnpm dev          # http://localhost:5191
pnpm test         # unit (Vitest), sim layer only
pnpm e2e          # end-to-end (Playwright, real Vite + WebGPU/WebGL2)
pnpm typecheck
pnpm exec biome check --write .   # format + lint
```

Try `pnpm dev` then open http://localhost:5191/?track=cliffside&bike=stunt for the most fun config.

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
