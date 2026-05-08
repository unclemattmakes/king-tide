# Hoverbike — Project Status

> Last updated: 2026-05-07 (Cliffside track + gate-cleared audio). Live build: https://hoverbike-ciaqaossl-oddballcreatureclubs-projects.vercel.app — every push to `main` auto-deploys.

This doc captures the build's current state, controls, known issues, and next steps. It complements [product-plan.md](./product-plan.md) (vision + MVP scope) and [implementation-plan.md](./implementation-plan.md) (architecture + milestone breakdown).

## What works today

- Two tracks: **Lagoon Loop** (default; jump ramp on the right straight) and **Cliffside** (`?track=cliffside`; mesa with cliff drop, doubles as the Blender-export reference layout)
- Jump ramp on Lagoon's right straight (z = 25–37) — exercises raycast-vs-static-collider, surface alignment on a sloped normal, hover-spring release on launch, and water re-acquisition on landing
- Player spawns on the racing line at the start gate, facing forward
- Hover-bike physics (Rapier WASM, deterministic build)
- Gerstner wave water with buoyancy — bike rides waves, dives into troughs, launches off crests
- Faceted water surface + horizon-fading sky dome
- 4 AI racers with per-bike race-line offsets so they hold parallel lines (no convergence pile-up)
- Pickup boxes around the loop — full pool: boost, shield, mine, homing missile
- Race lap counting with finish overlay
- Direction arrow (Crazy Taxi style) above the player pointing to the next checkpoint
- Sky beacon over the next gate
- Auto-play mode (T or F1) — AI takes over the player bike for testing
- Backspace = respawn at start
- Mouse right-drag and gamepad right-stick orbit the camera (vertical inverted by default)
- 22 e2e + 35 unit tests, all green
- Vercel push-to-deploy, Cloudflare CDN ready (not yet attached to a domain)

## Controls

### Keyboard
| Key | Action |
|---|---|
| W / ↑ | Throttle forward |
| S / ↓ | Brake / reverse |
| A / ← | Steer left |
| D / → | Steer right |
| Q | Pitch up (lean back, jump off a wave) |
| E | Pitch down (lean forward, dive into a wave) |
| Space | Fire pickup |
| Shift | Boost |
| Backspace | Respawn at start (snaps to spawn pose, zero velocity) |
| T or F1 | Toggle auto-play (AI drives player bike) |
| M | Toggle audio mute |
| R | Restart race after finish |

All keyboard axes are smoothed (~0.13s ramp) so taps give small inputs and holds give full deflection.

### Gamepad (Xbox / PS layout)
| Input | Action |
|---|---|
| Left stick X | Steer |
| Left stick Y | Pitch (push forward = dive, pull back = jump) |
| Right trigger | Throttle |
| Left trigger | Brake / reverse |
| Right stick | Camera orbit (Y inverted) |
| A / X (button 0) | Fire |
| B / Circle (button 1) | Boost |

### Mouse
| Action | Effect |
|---|---|
| Right-button drag | Orbit camera around bike (Y inverted by default) |

## Tech stack (locked)

| Layer | Choice |
|---|---|
| Language | TypeScript (strict, exactOptionalPropertyTypes) |
| Build | Vite 8, port 5191 |
| Package mgr | pnpm 10 |
| Renderer | Three.js, WebGPURenderer with WebGL2 fallback (real adapter probe) |
| Physics | `@dimforge/rapier3d-compat` (deterministic build) |
| ECS | bitECS 0.4 with side-table data stores (`engine/sim/ecs/store.ts`) |
| Input | Native gamepad/keyboard API, smoothed |
| Audio | Web Audio API, procedurally synthesised (no SFX assets needed) |
| Test (unit) | Vitest (sim layer only — no Three.js imports) |
| Test (e2e) | Playwright (real Vite dev server, real WebGPU/WebGL2) |
| Lint/format | Biome 2 |
| Hosting | Vercel (push-to-deploy) |
| Source | https://github.com/occ-matt/hoverbike (private) |

See [implementation-plan.md](./implementation-plan.md) for repo layout and the architectural rule (sim layer must not import Three.js).

## Known bugs / quirks

### Pitch + roll coupling — *resolved (M9.4)*
M9.3 was insufficient: pitching while turning produced wild roll oscillations (probe showed ±60° pitch, ±70° roll). Root cause was the roll PD reading `bikeRight.y` and false-positiving on the geometric tilt that yaw-while-pitched produces; the corrective torque pumped real angular velocity into the roll axis. M9.4 replaces the soft PD with a kinematic roll lock: at the top of `hoverSystem`, decompose the bike's rotation into YXZ Euler (yaw → pitch → roll), force roll = 0, recompose, and strip out the `bikeFwd` component of angvel. Roll velocity can no longer accumulate from misaligned-axis side-effects. Yaw + pitch behave as before.

### Pitch + throttle on water — *intentional, not a bug*
Holding `pitch=+1` (dive) at full throttle makes the bike plant its nose into wave troughs and submerge-and-bounce, with speed swinging 10→25→10 m/s as buoyancy kicks back. This is the desired Wave Race-style feel — diving into a wave should *cost* you. Thrust is already projected to horizontal (always was); the apparent "dive" is the bike's collider being driven through the wave field at speed, not a thrust-direction bug. Don't "fix" it.

### AI navigation — works but rough
- AI consistently makes it through cp 0, cp 1, cp 2 and into cp 3 in autoplay tests
- They sometimes overshoot tight curves (cp 1 → cp 2) and have to recover
- Per-bike line offsets prevent dogpiles at gates, but on heavy interactions they can still bump each other
- Lap completion rate by AI is below 50% over a 30s window — the controller is correct, just not refined enough to consistently navigate corners while braking

### `quatRotate` was buggy in M0–M3
Fixed in M4 — the `q*v*q⁻¹` expansion was producing wrong rotated vectors except at identity. All systems that read bike orientation were affected; fixing it surfaced the steer-sign issue.

### Steer/yaw torque sign convention is empirical
`aTurn = -intent.steer * turnTorque` — playtest-confirmed but my earlier analysis kept getting it backwards. Document is `hover.ts`. The chase camera makes "physical left turn = perceived right turn" feel correct.

### Pitch sign is empirical too (M9.2)
`aPitch = (currentPitch - targetPitch) * SPRING` — note the order. (target - current) was the wrong sign and produced a backflip when the player pressed E. Document in `hover.ts`.

### Tests sometimes flaky on parallel runs
The M3 race "checkpoints not in front are not counted" test occasionally needs a retry. Cause: physics-driven timing under CPU contention from 4 parallel Playwright workers. Workers capped at 4; retries enabled.

### Other small things
- The "infield island" cylinder in the middle of the loop is decorative — bike drives around it on water.
- Boot sometimes needs a hard reload (Ctrl+F5) after big code changes — Vite HMR can leave stale state in stores.

## What's left to implement

In rough priority order. Each item is sized as **S/M/L** for effort.

### Polish on what exists
- **[S] Pitch attenuation tuning.** Maybe make pitch effect smaller (±15° instead of ±30°) so the bike stays more controllable. Or scale pitch with speed.
- **[M] AI cornering tuning.** More aggressive brake-into-turn, look-ahead based on track curvature, racing-line offset that varies between inside/outside of corner.

### Combat (M5 — done)
All four MVP pickups landed in M9.9 (the M5-completion bundle):
- **Boost** — speed multiplier (was already in)
- **Shield** — 6s bubble, absorbs one mine/missile hit then consumes
- **Mine** — dropped behind the firer with a 0.6s arming delay; proximity trigger spinouts the victim
- **Homing missile** — target acquisition picks nearest bike inside a forward cone (≤80m, dot ≥ 0.3); MISSILE_TURN_RATE 2.4 rad/s caps how sharply it can chase. 5s self-destruct.

Shared hit reaction: linear-velocity damp ×0.55, ±12 rad/s yaw spinout, 1s `Stun` component that the `stunOverrideSystem` uses to zero throttle/steer/brake/pitch on the victim until it expires. Fire/boost are NOT zeroed during stun.

**AI pickup usage** (M9.10): the four AI bikes now fire their pickups via a new `aiCombatSystem` that runs between `aiControlSystem` and `stunOverrideSystem`. Decision logic is in the pure `shouldAIFire(held, throttle, |steer|, hasChaser, hasMissileTarget)` helper (12 unit tests cover the gates):
- **boost** — fires when `throttle > 0.85` (i.e. on a clean straight; never burns it scaled-down mid-corner)
- **shield** — fires whenever held; sitting on it can't help
- **mine** — fires when a non-self bike is within 12m and behind us (`dot < -0.4`), OR mid-corner (`|steer| > 0.4`) to hazard the racing line
- **missile** — fires when `throttle > 0.8` AND `pickMissileTarget()` finds a bike in our forward cone (≤80m, dot ≥ 0.3)

Open polish:
- Pool weighting feels OK at 2:1:1:1 (boost:shield:mine:missile) but only one race tested it. Tune if combat dominates.

### Missing MVP items
- **[S] Bike variants.** 2–3 bikes with distinct stat tradeoffs (top speed / handling / accel). Stats are already parameterised per entity.
- **[M] Bike select + track select menus.** Vanilla DOM, simple flow.
- **[S] Save state.** Local-storage-backed best lap times.

### Asset pipeline (deferred; tools exist)
- **[L] Run the Blender pipeline end-to-end.** Build `tracks-src/calibration.blend` via `tools/build_calibration_scene.py`, export with `tools/export_track.py`, write the runtime `.glb` loader that reads the metadata from `extras`. Procedural Lagoon Loop will serve until the user decides to author tracks in Blender.
- **[M] Wire the calibration scene as an integration test.** Loader asserts every metadata kind appears.

### Beyond MVP
- Multiplayer (architecturally unlocked by Rapier deterministic build)
- Career mode / unlocks
- Mobile / touch
- Original soundtrack
- In-engine track editor
- Real art direction (placeholders today)

## Milestone status

| # | Title | Status |
|---|---|---|
| M0 | Project skeleton + boot | ✅ |
| M1 | Hover bike on flat ground | ✅ |
| M2 | Wave water + buoyancy | ✅ |
| M3 | Tracks + checkpoints + lap counting | ✅ |
| M4 | AI racers | ✅ (rough cornering remains) |
| M5 | Combat | ✅ — boost, shield, mine, homing missile, hit reaction |
| M6 | Polish to MVP | partial — sky/water/UI in; audio + 2nd track open |
| M7 | Real loop track | ✅ |
| M8 | Stadium track + spawn on loop + gate-state fix | ✅ |
| M9 | Smoothed kb + pitch + respawn + arrow + flip recovery | ✅ |
| M9.4 | Kinematic roll lock — pitch+steer no longer rolls the bike | ✅ |
| M9.5 | Bank into turns + lean sign correction | ✅ |
| M9.6 | Surface alignment (kinematic pitch + roll on the wave normal) | ✅ |
| M9.7 | surfaceFollow per-bike stat + per-bike motion trails | ✅ |
| M9.8 | Camera-facing ribbon trails + arrow legibility | ✅ |
| M9.9 | M5 combat bundle (shield, mine, missile, hit reaction) | ✅ |
| M9.10 | AI fires pickups (boost / shield / mine / missile heuristics) | ✅ |
| M9.11 | Jump ramp on right straight — verifies non-water surface behavior | ✅ |
| M9.12 | Procedural audio (engine + ambient + pickup chime + weapon SFX) | ✅ |
| M9.13 | Cliffside track (mesa + ramp + cliff drop) + gate/lap audio | ✅ |

## File / system map

```
src/
├── main.ts                    # boot + per-frame loop + key bindings
├── debug.ts                   # window.__hover dev API
├── engine/
│   ├── sim/                   # NO Three.js imports
│   │   ├── ecs/               # bitECS world + side-table stores
│   │   ├── physics/           # Rapier wrapper + vec/quat utils
│   │   └── water/             # Gerstner wave field + sampler
│   ├── render/                # Three.js layer
│   │   ├── renderer.ts        # WebGPU/WebGL2 detect
│   │   ├── camera.ts          # chase cam with orbit
│   │   ├── scene.ts           # sky, lighting, island
│   │   ├── water.ts           # CPU-driven faceted water mesh
│   │   ├── sky.ts             # gradient sky dome
│   │   ├── direction-arrow.ts # 3D Crazy-Taxi arrow
│   │   ├── track-mesh.ts      # gates + beacons
│   │   ├── arena-mesh.ts      # infield island
│   │   ├── bike-mesh.ts       # bike body, fin, tail light, hover puck
│   │   ├── pickup-mesh.ts     # rotating glowing crate
│   │   ├── pickup-render.ts
│   │   └── render-systems.ts  # ECS → Three.js sync
│   └── input/
│       ├── intent.ts          # Intent type
│       ├── keyboard.ts        # smoothed WASD/arrows + Q/E
│       ├── gamepad.ts         # standard mapping
│       ├── camera-look.ts     # mouse drag + right stick orbit
│       └── index.ts           # merge keyboard + gamepad
├── game/
│   ├── components/            # bitECS tags + side-table data types
│   ├── systems/               # all sim-side ticking logic
│   │   ├── hover.ts           # ride-height + thrust + steer + pitch + roll/yaw stabilizers
│   │   ├── input-apply.ts
│   │   ├── ai-control.ts      # spline follower with PD steering
│   │   ├── rubber-band.ts     # AI top-speed adjusts to leader gap
│   │   ├── race.ts            # checkpoint crossing detection + lap count
│   │   ├── pickup.ts          # pickup detection, use, boost effect
│   │   ├── standings.ts       # rank ordering
│   │   └── sync-from-physics.ts
│   ├── entities/              # factories
│   ├── tracks/                # track type + procedural Lagoon Loop
│   ├── bikes/                 # default stats
│   └── ai/                    # (currently used only by ai-control.ts)
└── ui/                        # (empty — HUD lives in index.html for now)
tools/                          # Blender Python scripts (untouched since M3)
tests/
├── unit/                       # Vitest, sim only
└── e2e/                        # Playwright via real Vite server
```

## Important conventions

These are the load-bearing decisions that future work needs to respect.

1. **Sim layer cannot import Three.js.** Anything under `src/engine/sim/` or `src/game/systems/` must be Three-free. Render systems read from the ECS world and write to Three.js objects, never the other way. Keeps headless tests + future multiplayer rollback netcode possible.

2. **bitECS 0.4 components are tags only — data lives in side-table stores.** See `engine/sim/ecs/store.ts`. The component itself (e.g. `Transform`) is a unique object reference used for queries. The data (`TransformData`) lives in `TransformStore` keyed by entity id. This was a refactor after M0 because bitECS 0.4 doesn't store data on components without observable hooks.

3. **Steer convention is empirical, NOT standard math.** `aTurn = -intent.steer * turnTorque` and yaw torque is applied along the bike's local up axis. Don't change the sign without playtesting on real hardware — the chase cam makes "physical-left = perceived-right" the natural feel. Same for pitch (`aPitch = (current - target) * spring`).

4. **Debug API is the testing surface.** `window.__hover` exposes `player()`, `race()`, `bikes()`, `setIntentOverride()`, `toggleAutoPlay()`, etc. This is how Playwright tests drive the game and how Claude inspects state. Keep it consistent with new features.

5. **Player and AI share the same `ControlIntent` plumbing.** Auto-play mode just adds `AITag` to the player so `aiControlSystem` writes their intent. Player intent path (`applyPlayerIntent`) is suppressed while auto-play is on. Don't fork these paths.

6. **Coordinate convention.** +Z is forward, +Y is up, +X is right of a forward-facing bike. The bike's mesh has a yellow fin pointing +Z (forward) and a red tail light at -Z (back) — visual cue that matches the physics.

## How to develop

```bash
pnpm install
pnpm dev              # http://localhost:5191 (auto-falls-through to 5192+ if taken)
pnpm test             # vitest unit
pnpm e2e              # playwright (4 workers, real WebGPU/WebGL2)
pnpm typecheck
pnpm exec biome check --write .   # format + lint
```

## Picking this up in a fresh Claude session

The conventions, bugs, and gotchas above are the load-bearing context. Some specific tips:

- The `window.__hover` debug API + the Claude Preview MCP (`preview_eval`, `preview_screenshot`) are how to inspect runtime state. Use them eagerly.
- E2E tests double as integration tests. When changing physics or input, run `pnpm e2e` rather than just typechecking.
- The `tests/e2e/m6-autoplay.spec.ts` test prints the player trajectory — invaluable for debugging AI behaviour and physics edge cases.
- Vercel auto-deploys on push to `main`. There is no preview-deploy gate, so don't push half-broken code.
- The user (matt / occ-matt) prefers tight, focused commits with explicit "why" in the message. Co-author tag is `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- The user is OK with auto mode pushing through routine tasks but wants to be the empirical source of truth on "feel" — playtest reports trump my analysis.
