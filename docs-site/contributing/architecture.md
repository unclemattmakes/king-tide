# Architecture

The load-bearing decisions live as
[ADRs](https://github.com/occ-matt/hoverbike/tree/main/docs/adr) in the
repo:

| #    | Decision                                       |
|------|------------------------------------------------|
| 0001 | ECS — bitECS 0.4 with side-table stores        |
| 0002 | Sim layer must not import Three.js             |
| 0003 | Renderer — Three.js, WebGPU-first              |
| 0004 | Physics — Rapier3D-compat (deterministic)      |

Read those before swapping out a major dependency or moving a layer
boundary.

## The one rule

**The sim layer cannot import Three.js.**

Anything under `src/engine/sim/` or `src/game/systems/` is Three-free.
Render systems read from the ECS world and write to Three.js objects,
never the other way around.

This unlocks:

- Headless unit tests for sim logic (no DOM, no GPU).
- Deterministic replays.
- Future rollback / lockstep netcode.

If you find yourself wanting to `import { Vector3 } from 'three'`
inside a sim file, use `gl-matrix` instead, or define a tiny plain
struct.

## Folder map

```
src/
  boot/        # one-shot startup helpers (track loader, loading screen, spawn)
  engine/
    audio/     # Web Audio buses, procedural engine sound
    editor/    # in-app track editor (?edit=1)
    input/     # gamepad / keyboard / touch / camera orbit
    menus/     # menu DOM, lobby, pause, finish card
    net/       # PartyKit room wrapper, codecs, host election
    render/    # Three.js — meshes, materials, water, sky, HUD, FX
    replay/    # ?replay= recorder + playback
    sim/       # PURE simulation — ECS, physics wrapper, water field, time
  game/
    assets/    # GLB loaders
    bikes/     # bike specs + variants
    components/ # bitECS component schemas
    entities/  # entity factories
    systems/   # ECS systems (sim — Three-free)
    tracks/    # track types + loaders (lagoon, cliffside, JSON, GLB)
  viewer/      # standalone bike viewer (?viewer=...)
  main.ts      # boot orchestrator — wires everything together
```

Anything in `engine/render/`, `engine/menus/`, `engine/editor/`,
`engine/audio/`, `boot/`, `viewer/`, and `main.ts` is allowed to import
Three.js. Anything else isn't.

## ECS conventions

- **Components** are bitECS schemas in `src/game/components/`. They store
  numeric arrays only. Anything richer (Maps, classes) lives in a
  side-table keyed by `eid`.
- **Systems** are pure functions in `src/game/systems/` that take
  `(sim, phys, track, …)` and mutate the world. They're called in a
  fixed order from `src/game/sim-step.ts`.
- **Entities** are integers. Factories in `src/game/entities/` create
  them and stamp on the right components.

## Determinism contract

The simulation must be deterministic for a fixed input sequence at a
fixed tick rate. Specifically:

- Rapier is configured for deterministic stepping.
- Don't reach for `Math.random()` in sim code. If you need randomness,
  use a seeded PRNG that lives in the world.
- Don't read `Date.now()` / `performance.now()` from sim code. Time
  comes in as the fixed `dt` argument.

The Playwright determinism probe (`?determinism=1`) replays the same
intents twice and asserts bit-identical bike poses. If your change
breaks it, you've introduced non-determinism.

## Netcode shape

- The PartyKit relay (`party/relay.ts`) is **stateless** — peers
  broadcast, server fans out. Don't add per-room state on the server.
- Every peer runs the full sim locally. The relay only carries
  `InputFrame` (60 Hz, 11 B) and `TransformSnapshot` (20 Hz) messages.
- The lowest-slot peer is the **AI host** — only it runs
  `aiControlSystem`. Non-hosts apply received AI poses to kinematic
  rigid bodies.

Full design: [`docs/m10-11-state-sync.md`](https://github.com/occ-matt/hoverbike/blob/main/docs/m10-11-state-sync.md).
