# ADR 0002 — Sim layer must not import Three.js

**Status:** Accepted

## Context

Three.js is a heavy module: ~1 MB minified, plus runtime state
(materials, render targets, shaders) that's awkward to construct in
a Node test environment. If sim code imports Three, every unit test
has to either stub out the Three world or run in jsdom — both slow
and brittle.

Beyond test speed, deterministic replay and (eventually) rollback
netcode require the simulation to be a pure function of input +
state. Mixing render-side mutations into sim systems makes that
impossible to guarantee.

## Decision

Code under `src/engine/sim/` and `src/game/systems/` must not
import `three`. Render systems live under `src/engine/render/`
(plus `src/game/assets/` for the Blender → GLB pipeline) and read
from the ECS world via component stores; they never write back to
sim state.

The rule is intentionally simple — easy to enforce in PR review,
easy to grep for (`grep -r "from 'three'" src/game/systems`).

## Consequences

- **Vitest unit tests run without a DOM or GPU.** See
  `tests/unit/ai-combat.test.ts` and `tests/unit/wave-field.test.ts`
  — pure data, no shims.
- **Replay is straightforward.** Recorder samples sim state; player
  feeds sampled poses through the same render systems. No "what was
  the camera doing?" questions during sim playback.
- **Render systems are one-way.** When something needs to flow
  *back* into sim — a click in the editor, a HUD button — it goes
  through input intent or a higher-level orchestrator (`main.ts`,
  `track-editor.ts`), not through the ECS components.
- **Some helpers feel one-sided.** A vector function that's useful
  on both sides (e.g. `Vec3` math in `physics/vec.ts`) lives on the
  sim side; render code imports it. The reverse is forbidden.
- **The boundary is conceptual, not enforced by tooling.** A linter
  rule (`no-restricted-imports`) could codify it; not done yet.
