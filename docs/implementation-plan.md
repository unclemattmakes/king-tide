# Hoverbike — Implementation Plan v0.1

> Concrete tech choices, repo layout, and milestones to deliver the Playable Demo MVP defined in [product-plan.md](./product-plan.md).
>
> **Status (2026-05-07):** MVP feature-complete. M0–M6 all shipped, plus
> M7–M9.x extension milestones (real loop track, kinematic attitude
> system, surface alignment, motion trails, combat bundle, AI pickup
> usage, jump ramp, audio, second track, garage menu + variants + save
> state, hybrid Blender + JSON track pipeline with in-app editor). Live
> build at the Vercel URL in [README](../README.md). For the live state
> of features, gotchas, and what's still open, see
> [status.md](./status.md) — this doc covers the original architectural
> plan; status.md tracks the actual codebase.

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
│   ├── status.md                  # live state of the codebase
│   ├── track-editor-guide.md      # in-app editor (gameplay data)
│   ├── blender-pipeline-guide.md  # Blender side (environment geometry)
│   └── blender-conventions.md     # quick-reference for the legacy all-in-glb path
├── public/
│   ├── tracks/                    # JSON gameplay data (editor reads/writes here)
│   └── assets/
│       ├── tracks/                # exported .glb environment geometry
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
│   │   ├── editor/                # in-app track editor (TransformControls + outliner)
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
│   ├── export_track.py            # Blender → glTF with metadata (legacy all-in-glb)
│   ├── build_calibration_scene.py # rebuild calibration.blend from script
│   └── snapshot_lagoon.mjs        # generate lagoon-edit.json from procedural Lagoon
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

## Asset pipeline (tracks) — hybrid

Tracks have **two source files** edited in two different tools, joined
at runtime:

| Source | Tool | Owns |
|---|---|---|
| `public/tracks/<id>.json` | In-app editor (`?track=<id>&edit=1`) | Gates, AI spline, pickups, boost pads, start pose, water tuning |
| `public/assets/tracks/<id>.glb` *(optional)* | Blender + `tools/export_track.py` *(or vanilla glTF export)* | Collidable environment geometry — track surfaces, ramps, mesa, decorative meshes |

The JSON references the `.glb` via its `environmentGlb` field; the
runtime fetches both and joins them at boot. The in-app editor saves
the JSON live via a dev-only Vite middleware (`/__editor/save-track`,
`apply: 'serve'`) — no editor write endpoint ships in production.

### In-app editor — the fast loop

`?edit=1` (defaults to `lagoon-edit`, a JSON snapshot of Lagoon Loop)
opens an outliner panel + Three.js `TransformControls` gizmos:

- **Outliner** lists every entity grouped by kind. Click to select.
- **Move (W) / Rotate (E) / Scale (R)** gizmo modes. Per-entity axis
  gating: gates rotate Y only and scale X→halfWidth + Y→height; pads
  scale X→halfWidth + Z→halfDepth; pickups + spline points are
  translate-only.
- **+ Gate / + Pickup / + Boost / + Spline pt** place new entities at
  the next ground click.
- **Save** writes back to `public/tracks/<id>.json`. **Play** reloads
  without `?edit=1` so you immediately race the changes.

See [track-editor-guide.md](./track-editor-guide.md) for the full
walk-through.

### Blender side — environment geometry

For collidable terrain, the workflow is:
1. Author meshes in Blender (any name; mark drivable surfaces with a
   `mat_track_*` material and `kind = "track"` custom property).
2. Export via `tools/export_track.py` *(validates conventions)* or
   vanilla glTF export *(when no metadata is needed)*.
3. Reference the `.glb` URL in your track's `environmentGlb` field.

See [blender-pipeline-guide.md](./blender-pipeline-guide.md).

### Calibration scene (legacy all-in-glb)

`tracks-src/calibration.blend` is the historical reference for the
all-in-glb pipeline (gates / spline / pickups baked into Blender
`extras`). The runtime still loads this format via
`src/game/tracks/glb-loader.ts`, but the JSON path is preferred for new
tracks. Calibration today loads via JSON + env-glb (its `.glb` is just
the floor mesh); the older all-in-glb loader is kept for back-compat.

Purposes:
1. **Smoke-test the import/export pipeline** — if the calibration
   `.glb` loads cleanly, the conventions are intact.
2. **Round-trip integration test** — `tests/e2e/m9-calibration-glb.spec.ts`
   asserts every metadata kind survives.

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

The original M0–M6 plan delivered the MVP scaffolding. Several extension milestones (M7+) followed to land the actual playable demo. status.md has the current ledger; this table is here for historical reference.

| # | Goal | Status |
|---|---|---|
| **M0** | Skeleton boots — Vite + TS + Three.js WebGPU + gamepad + debug API + smoke test | ✅ |
| **M1** | Hover bike on flat ground — Rapier, raycast hover, gamepad throttle/steer, chase cam | ✅ |
| **M2** | Wave water + buoyancy — Gerstner shader, CPU sampler, bike floats + waves throw it | ✅ |
| **M3** | First track + calibration scene — Blender pipeline scaffolded, lap counting works on a procedural Lagoon Loop. The end-to-end .blend → .glb run is still deferred; the loader will read `extras` metadata when it lands | ✅ scaffold / 🟡 e2e |
| **M4** | AI racers — 4 spline-following bikes with rubber-band catchup | ✅ (cornering polish noted in status.md) |
| **M5** | Combat — 4 pickups (boost / shield / mine / homing missile) + projectile system + shared hit reaction. AI fires its own (M9.10) | ✅ |
| **M6** | Polish to MVP — HUD, garage menu, procedural audio, second track, WebGL2 fallback validated, push-to-deploy on Vercel | ✅ |
| **M7+** | Extension milestones (real loop track, stadium gates, kinematic attitude / surface alignment, trails, jump ramp, Cliffside, bike variants, save state). See status.md for the full ledger. | ✅ |

Each milestone was treated as a decision gate; M9.x sub-milestones came out of playtest feedback rather than the upfront plan.

## Open decisions — resolved

- **Camera:** chase cam (offset + spring damping) with mouse / right-stick orbit. No motion sickness reports; cinematic cam not needed.
- **Lap target:** 3 laps, ~25s/lap on Lagoon Loop. Cliffside laps run a bit longer.
- **Bike stats:** stubbed in M1, tuned from M4 onward, locked to the variant table in `src/game/bikes/variants.ts` (M9.14). `surfaceFollow` was added in M9.7 once kinematic surface alignment landed; M9.22 made the runtime application altitude-faded so the value behaves as a peak rather than a constant — see status.md.

## Deploy

- GitHub repo (origin) → Vercel project linked.
- Push to `main` → production deploy. Push to a branch / open PR → preview deploy.
- Cloudflare CDN/proxy added when a custom domain is attached. Until then, default `*.vercel.app` URLs.
- No secrets needed at MVP (no backend).

## What's next (post-MVP)

- **AI cornering polish.** Lagoon's parallel-line AI is solid; Cliffside's
  mesa drop still snares the AI when it overshoots a corner. Either
  widen the mesa, add side ramps, or teach the AI to detour to the
  climb ramp when off-elevation.
- **Editor — phase 3.** Undo/redo, numeric input fields in the
  properties panel, env-glb preview *inside* edit mode, boost-pad
  runtime behaviour (the data type is wired but the sim doesn't react
  yet), garage-menu "Edit" entry-point.
- **On-screen touch controls.** Touch input is wired in
  `src/engine/input/touch.ts`; needs an HTML overlay with virtual
  stick + buttons.
- **Music.** Procedural audio covers SFX; background music is still
  missing.
- Beyond MVP: multiplayer (Rapier deterministic build is ready), career
  mode.

**Shipped in M9.16–M9.21** (originally listed here as future work):
- ✅ End-to-end Blender → .glb pipeline (M9.16) — `tools/export_track.py`
  validates the calibration scene and the runtime loader reads `extras`
  metadata.
- ✅ .glb mesh rendering (M9.17) — track surface visible at runtime.
- ✅ Hybrid pipeline (M9.19) — JSON gameplay data + optional Blender .glb.
- ✅ In-engine track editor (M9.20 + M9.21) — outliner + TransformControls
  with translate / rotate / scale, undo, Catmull-Rom anchor splines, and
  gates auto-bound to the spline.
