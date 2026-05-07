# Hoverbike — Implementation Plan v0.1

> Concrete tech choices, repo layout, and milestones to deliver the Playable Demo MVP defined in [product-plan.md](./product-plan.md).

## Architectural principle: sim ↔ render split

The single most important constraint in this codebase: **the simulation runs without rendering.** Three.js is a consumer of the simulation state, never a participant in it.

This unlocks three things:
1. **Headless tests** — sim runs in Vitest/Node without a browser.
2. **Claude can test the game** — a debug API on `window.__hover` lets an automated agent (or a Playwright script) drive inputs, step physics, and inspect state.
3. **Multiplayer is possible later** — a deterministic sim that doesn't depend on rendering is a prerequisite for rollback netcode (the Rapier deterministic build was chosen for this reason).

Practical rule: nothing under `src/engine/sim/` or `src/game/systems/` may import from Three.js. Render systems read from the ECS world and write to Three.js objects, never the other way around.

## Stack (concrete)

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict) | |
| Build | Vite | Fast HMR, native ESM |
| Package mgr | pnpm via Corepack | No npm-global pollution |
| Renderer | Three.js — `WebGPURenderer` w/ `WebGLRenderer` fallback | Auto-detect at boot |
| Physics | `@dimforge/rapier3d-compat` (deterministic build) | WASM, ~700KB |
| ECS | `bitecs` | Small, fast, struct-of-arrays |
| Math | `gl-matrix` for hot paths, Three.js math elsewhere | |
| Audio | Web Audio API + thin wrapper | |
| Glb loading | Three.js `GLTFLoader` + custom `extras` metadata reader | |
| Test (unit) | Vitest | Sim tests run without a browser |
| Test (e2e) | Playwright | Drives the real game via debug API |
| Lint/format | Biome | One tool, fast |
| CI | GitHub Actions | typecheck + test + build on PR |
| Hosting | Vercel (push-to-deploy from GitHub) | Preview deploys per PR |
| CDN | Cloudflare proxy in front of Vercel domain | Wired up when a domain is attached — no config until then |

## Repo layout

```
hoverbike/
├── docs/
│   ├── product-plan.md
│   ├── implementation-plan.md
│   └── blender-conventions.md     # naming + metadata cheat sheet for track authors
├── public/
│   └── assets/
│       ├── tracks/                # exported .glb files
│       ├── bikes/                 # exported bike meshes
│       └── audio/                 # SFX, music
├── src/
│   ├── main.ts                    # browser boot
│   ├── debug.ts                   # window.__hover dev API
│   ├── engine/
│   │   ├── sim/                   # PURE — no Three.js imports allowed
│   │   │   ├── ecs/               # bitECS world + system runner
│   │   │   ├── physics/           # Rapier wrapper, collider helpers
│   │   │   ├── water/             # Gerstner field + CPU sampler
│   │   │   └── time/              # fixed-step accumulator
│   │   ├── render/                # Three.js layer
│   │   │   ├── renderer.ts        # WebGPU/WebGL2 detect + setup
│   │   │   ├── camera.ts          # chase rig
│   │   │   ├── water-shader.ts    # GPU Gerstner vertex shader
│   │   │   └── render-systems.ts  # ECS → Three.js sync
│   │   ├── input/                 # gamepad + keyboard → intent
│   │   ├── audio/                 # Web Audio buses, dynamic engine sound
│   │   └── assets/                # glTF loader, manifest
│   ├── game/
│   │   ├── components/            # ECS components
│   │   ├── systems/               # ECS systems (no Three.js)
│   │   ├── entities/              # factory functions
│   │   ├── tracks/                # track loader, metadata schema
│   │   ├── bikes/                 # bike stat defs
│   │   ├── pickups/               # pickup defs + behavior
│   │   └── ai/                    # spline follower, rubber-band
│   └── ui/                        # HUD, menus (vanilla DOM)
├── tools/
│   └── export-track.py            # Blender → glTF with metadata
├── tracks-src/
│   ├── calibration.blend          # one of every metadata object — pipeline reference
│   └── README.md
├── tests/
│   ├── unit/                      # Vitest, sim only
│   └── e2e/                       # Playwright
├── biome.json / tsconfig.json / vite.config.ts / playwright.config.ts
├── package.json / pnpm-lock.yaml
└── index.html
```

## ECS sketch

**Components (data-only):** `Transform`, `Velocity`, `RigidBody` (Rapier handle), `HoverController`, `BikeStats`, `Buoyancy`, `Player`, `AI`, `Racer` (lap/checkpoint/position), `PickupSlot`, `Projectile`, `MeshHandle` (Three.js Object3D ref — render-only), `Audible`.

**Systems (ordered each tick, all in `src/game/systems/` unless noted):**
1. `InputSystem` — writes intent to `Player`-tagged entities
2. `AISystem` — writes intent to `AI`-tagged entities (spline + rubber-band)
3. `PhysicsStepSystem` — advances Rapier world (fixed 60 Hz)
4. `BuoyancySystem` — samples wave field, applies vertical force
5. `HoverControlSystem` — raycast ride-height, hover/torque
6. `WeaponSystem` — projectiles, hit detection
7. `RaceSystem` — checkpoints, laps, positions
8. `CameraSystem` — updates camera target (data only)
9. `RenderSyncSystem` *(render layer)* — copies physics transforms → Three.js objects
10. `AudioSystem` *(render layer)* — engine pitch, spatial sounds
11. `RenderSystem` *(render layer)* — draws frame

## Asset pipeline (tracks)

Tracks are authored in Blender and exported to glTF with metadata in `extras`:

| Object kind | Naming convention | glTF `extras` |
|---|---|---|
| Track surface mesh | any name; material `mat_track_*` | `{ kind: "track" }` |
| Water volume | empty cube `water_volume_*` | `{ kind: "water", waveHeight, waveFreq }` |
| Checkpoint | empty `cp_NN` (zero-padded, ordered) | `{ kind: "checkpoint", index }` |
| AI spline | NURBS curve `ai_spline_main` | `{ kind: "ai_spline" }` |
| Pickup spawn | empty `pickup_*` | `{ kind: "pickup_spawn" }` |
| Player start | empty `start_NN` | `{ kind: "start", index }` |

`tools/export-track.py` is a Blender Python script that walks the scene, validates conventions, and writes the .glb. Conventions are documented in [blender-conventions.md](./blender-conventions.md).

### Calibration scene

`tracks-src/calibration.blend` is a deliberately-minimal scene containing **exactly one** of every metadata object kind above, plus a flat track plane and a small water volume. Purposes:
1. **Smoke-test the import/export pipeline** — if the calibration `.glb` loads cleanly, the conventions are intact.
2. **Reference for future tracks** — open it, copy patterns.
3. **Round-trip integration test** — exported by CI; loader asserts every expected entity appears.

## Testability — debug API

In dev builds (`import.meta.env.DEV`) the engine exposes `window.__hover`:

```ts
window.__hover = {
  reset(scenarioId?: string): void
  step(deltaSeconds: number): void
  setInput(entityId: number, intent: Partial<Intent>): void
  query(entityId: number): EntitySnapshot
  listEntities(filter?: ComponentFilter): number[]
  loadTrack(name: string): Promise<void>
  screenshot(): Promise<string>          // base64 PNG
  state(): WorldSnapshot                  // serializable
}
```

This is what enables Playwright (and Claude in a Chrome session) to drive the game programmatically: load a scenario, push synthetic gamepad input, advance N physics steps, assert position / lap / collision.

E2E test example shape (Playwright):
```ts
await page.goto('/')
await page.evaluate(() => window.__hover.loadTrack('calibration'))
await page.evaluate(() => window.__hover.setInput(0, { throttle: 1 }))
await page.evaluate(() => { for (let i = 0; i < 60; i++) window.__hover.step(1/60) })
const snap = await page.evaluate(() => window.__hover.query(0))
expect(snap.position.x).toBeGreaterThan(0)
```

## Milestones

| # | Goal | Done when... |
|---|---|---|
| **M0** | Skeleton boots | Vite + TS + Three.js WebGPU canvas, gamepad axes log, FPS counter, WebGL2 fallback path, `window.__hover` skeleton, Playwright smoke test green |
| **M1** | Hover bike on flat ground | Rapier integrated, raycast hover controller, gamepad throttle/steer, chase cam. Drives "right" on a checkered plane. E2E: bike moves forward when throttle=1 |
| **M2** | Wave water + buoyancy | Gerstner shader, CPU wave sampler, bike floats and gets thrown by waves. E2E: bike Y oscillates with wave field |
| **M3** | First track + calibration scene | `tools/export-track.py` works end-to-end on `calibration.blend`. Test track with land+water+cliff+checkpoints+AI spline loads. Lap counting works. E2E: lap increments after crossing all checkpoints |
| **M4** | AI racers | 5 AI bikes follow spline, rubber-band, race against player. E2E: AI finishes a lap unaided |
| **M5** | Combat | 4 pickups + projectile system + hit reactions. E2E: missile homes, mine detonates, shield blocks |
| **M6** | Polish to MVP | HUD, menu, audio mix, second track, WebGL2 fallback validated, deployed to Vercel |

Each milestone is a decision gate — re-evaluate scope at the end before moving on.

## Open decisions (resolve in M1/M2)

- **Camera:** start with chase cam (offset + spring damping). Cinematic cam on cliff drops if motion sickness shows up.
- **Lap target:** 60-90s lap, 3 laps. Tune at M3.
- **Bike stats range:** stub now (`{topSpeed, accel, handling, mass}`), tune from M4 onward.

## Deploy

- GitHub repo (origin) → Vercel project linked.
- Push to `main` → production deploy. Push to a branch / open PR → preview deploy.
- Cloudflare CDN/proxy added when a custom domain is attached. Until then, default `*.vercel.app` URLs.
- No secrets needed at MVP (no backend).

## Immediate next steps (M0)

1. `corepack enable` for pnpm
2. `git init` + `.gitignore`
3. `pnpm init` and install: `three`, `@dimforge/rapier3d-compat`, `bitecs`, `gl-matrix`; dev: `typescript`, `vite`, `vitest`, `@playwright/test`, `@biomejs/biome`
4. Configure: `tsconfig.json` (strict), `vite.config.ts`, `biome.json`, `index.html`, `playwright.config.ts`
5. Build M0:
   - `src/main.ts` — boot, renderer detect, gamepad reader, FPS counter
   - `src/debug.ts` — skeleton `window.__hover` (just enough to run the smoke test)
   - `src/engine/sim/ecs/world.ts` — bitECS world bootstrap
   - `tests/e2e/boot.spec.ts` — Playwright smoke: page loads, FPS counter ticks, debug API present
6. Verify: `pnpm dev`, `pnpm test`, `pnpm e2e`
7. Initial commit, push to GitHub

Past M0, each milestone gets its own PR/branch with its own E2E test, then I check in with you before starting the next.
