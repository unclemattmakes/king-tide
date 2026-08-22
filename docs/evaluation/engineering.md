# King Tide — Engineering Evaluation

> Evaluated 2026-08-22 · full-project review · perspective: Engineering

## Scope & method

Read: `CLAUDE.md`, `README.md`, `docs/status.md` (v2 banner), ADRs 0001–0005,
`docs/maintainer-workflow.md`, `docs/dependency-triage.md`, `docs/perf-baseline.md`,
`docs/jitter-investigation.md`. Opened the actual source for the systems judged:
`src/game/sim-step.ts`, `src/engine/sim/**` (world, rng, snapshot, store, rapier),
`src/boot/game-loop.ts` (accumulator + interpolation), `src/game/systems/*` (sizes +
anti-grav early-exit), `src/engine/render/water.ts` (head + `as any` sites),
`vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `biome.json`,
`electron/main.cjs`, `tools/build-deck.mjs`, all four `.github/workflows/*.yml`,
representative tests (`sim-purity-guard`, `sim-determinism`, `combat-determinism`,
`m10-determinism.spec`, `field-completion.spec`, `tests/unit/helpers/assets.ts`).
Ran for real on this machine: `pnpm typecheck`, `pnpm lint`, `pnpm test` (results below).
Did **not** run e2e/QA/Blender/dev-server — no GPU here, per hard rule 2 / trap 4.

## Executive summary

This is an unusually disciplined codebase for a solo-maintained hobby game. The
architecture the docs claim is the architecture the code has: a genuinely Three-free,
seeded-RNG, fixed-timestep sim (`src/game/sim-step.ts`, `src/engine/sim/`), enforced
*mechanically* by `tests/unit/sim-purity-guard.test.ts` (ADR 0002's "not enforced by
tooling" consequence is now stale — the guard exists and bans Three, render imports,
`Math.random`, wall clocks, and the mutable settings singletons). All three local gates
are green: typecheck clean, lint exit 0, 1451/1451 unit tests passing in 17s. The
documentation of CI's honest state (which jobs gate, which skip, why the badge lied
before 2026-08-21) is the best I've seen in a repo this size. The weaknesses are
concentrated, not diffuse: the determinism and e2e gates **cannot run in CI at all**
(no GPU runners, R2 secret never set), so the project's two most important invariants
— sim determinism and "the game boots and a field finishes" — are enforced only by
maintainer discipline on a repo where a maintainer push to `main` runs zero checks and
deploys to production. Secondary issues: a 5,838-line `water.ts` god-module holding 55
of the repo's 73 `as any`s, boot-layer monoliths (`game-loop.ts` 2,615 / `race-boot.ts`
2,118 lines) with almost no direct test coverage, and a lint gate that passes green
while carrying 1,358 warnings, including correctness-class ones. None of these are
rotting — but the top fix below (a Node-side determinism golden) would convert the
project's biggest paper gate into a real one for roughly a day's work.

## Verification runs (2026-08-22, this machine)

| Command | Result | Detail |
|---|---|---|
| `pnpm typecheck` | ✅ exit 0 | `tsc --noEmit`, zero diagnostics |
| `pnpm lint` | ✅ exit 0 | `biome check .`, 653 files — **1,358 warnings + 4 infos** (warnings don't fail); config-schema mismatch: `biome.json` declares schema **2.4.16**, CLI is **2.5.9**, and the `recommended` field is deprecated — `biome migrate` wanted |
| `pnpm test` | ✅ exit 0 | Vitest: **150 files passed, 1 skipped (151)** · **1,451 tests passed, 6 skipped (1,457)** · 17.4s |

The 6 skipped tests are the asset-byte contract suites (`tests/unit/glb-loader.test.ts`,
`tests/unit/bike-loader.test.ts`) skipping via `tests/unit/helpers/assets.ts` because
`public/assets/` is unhydrated here — by design, with self-explaining skip labels
(trap 1: expected, not a finding). Warning breakdown from a full `--max-diagnostics`
run: 1,291 `noNonNullAssertion`, 46 `noConsole`, 16 `noExplicitAny`, 11
`noDescendingSpecificity`, 7 `useOptionalChain`, **3 `noUnusedImports`** (e.g. `leashFor`
in `src/boot/game-loop.ts:139`), 2 `useTemplate`, 2 `useConst`, 2
`noUnusedFunctionParameters`, 1 `noConfusingVoidType`, **1 `noUnusedVariables`**.

## Architecture

### ECS and data stores — pragmatic and self-defending

bitECS 0.4 components are tags; hot data lives in Map-backed side stores
(`src/engine/sim/ecs/store.ts`), exactly as ADR 0001 says. The store module is a small
gem: every store self-registers so `destroyEntity` wipes an entity from *all* stores
(closing the recycled-eid stale-data leak the comment describes), and
`serializeSimStores()` emits a name-then-eid-sorted serialization with `renderOnly`
stores excluded — so gameplay state (drift charge, lap counts, cooldowns) enters the
determinism hash while interpolated render transforms can't manufacture false desyncs
(`store.ts:56-73`). This is the kind of infrastructure that usually only exists in
teams that have already been burned; here it was built ahead of the burn.

### Sim/render separation — verified, and mechanically enforced

I re-verified the rule myself: `grep "from 'three'"` over `src/engine/sim/` and
`src/game/systems/` → **zero matches**. Better, `tests/unit/sim-purity-guard.test.ts`
enforces it on every `pnpm test`: comment-stripped source matching bans Three imports,
`@/engine/render` imports, `Math.random()`, `Date.now()`, `performance.now()`, and —
the subtle one — imports of the mutable `dev-settings`/`player-settings` singletons,
with a vacuous-pass sanity check (`files.length > 20`). ADR 0002's closing line ("the
boundary is conceptual, not enforced by tooling — not done yet") is stale and should be
updated to point at the guard.

The bridge layer is clean: `src/game/sim-step.ts` sits *outside* the guarded dirs and
snapshots the singletons into `StepInputs.tuning` / `rubberBandAssist` once per frame,
outside the accumulator (`game-loop.ts:1124-1130`, `1200-1203`), with SP passing live
sliders and MP passing frozen defaults so peers step identically. The tuning snapshot
is even folded into the determinism hash (`snapshot.ts:23-29`) so a tuning divergence
surfaces as a mismatch instead of a silent desync. System ordering in `simulateStep` is
documented as load-bearing, comment by comment (`sim-step.ts:166-266`).

### Determinism story — excellent design, unenforced in CI

Layers, from bottom up:

- **Seeded PRNG on the world** — `createSimWorld` attaches a mulberry32 `rng`
  (`src/engine/sim/ecs/world.ts`); `sim-determinism.test.ts` covers sequence
  stability, state round-trip, and the zero-seed degenerate case.
- **Tie-break determinism** — `combat-determinism.test.ts` proves `pickMissileTarget`
  breaks exact-distance ties by lowest eid, insulating against peer-divergent query
  order.
- **Whole-sim hash** — `src/engine/sim/snapshot.ts` (114 lines): sorted bodies + sorted
  stores + rng + waveTime + tuning. Deliberately a desync-*detection* hash, not a
  rollback restore point, and says so.
- **Cross-boot probe** — `tests/e2e/m10-determinism.spec.ts` boots twice, drives 600
  ticks of scripted intent, requires bit-identical snapshots; `determinism-snapshot
  .spec.ts` golden-compares against `tests/e2e/fixtures/determinism/lagoon.txt`.

The catch: the last layer — the only one that exercises real Rapier physics over a real
track — runs **only** on a hydrated, GPU-equipped local machine. In CI it has *never
run* (workflow comment, `ci.yml:149-156`, "REALITY CHECK … this gate has never run"),
and the docs honestly measured that setting the secret just converts the skip to a
timeout-red on GPU-less runners. Meanwhile several unit tests already instantiate
**real Rapier WASM in Node** (`await createPhysicsWorld()` in
`tests/unit/collision-corridor.test.ts`, `wave-rider.test.ts`, `apply-snapshot.test.ts`,
`rider-spawn.test.ts`…), and the `lagoon` fixture is a procedural track that needs no
GLB assets (`docs/status.md` 2026-06-21 entry). That combination means a **Node-side
determinism golden is feasible today in Vitest** — see fix #1. It would also dodge the
documented false-positive where the golden's derived-telemetry ULPs move when
Playwright's Chromium updates (`docs/dependency-triage.md:41-44`).

### Fixed timestep & render interpolation — textbook

`FIXED_DT = 1/60` set once (`src/engine/sim/physics/rapier.ts:25`); the rAF loop clamps
dt at 1/15, drains a `while (physAccum >= fixedDt)` accumulator, and renders at
`renderAlpha = physAccum / fixedDt` via `interpolateRenderTransforms`
(`game-loop.ts:1093-1228`). The jitter investigation (`docs/jitter-investigation.md`)
is a model root-cause writeup — zero-order-hold quantisation vs. low-pass-filtered
camera — and its fix (P0 interpolation + P1 camera clock) is implemented, with
`?jitter=1` telemetry retained as a regression instrument. Pause resets the accumulator
so unpause can't burst catch-up steps; multiplayer keeps stepping. One nit: the
single-player intent is sampled once per frame and reused across multiple sim ticks
(documented as deliberate, `game-loop.ts:6-12`) — fine now, flagged for rollback later.

### Parked v1 code — parked correctly, tiny tick cost

`anti-grav.ts` carries a prominent PARKED banner and stays wired into `simulateStep`.
Its early-exit is real (`anti-grav.ts:147-172`) but does allocate a filtered spline
array **every tick** before the exit check — a per-tick garbage nit in the 60 Hz hot
loop that a hoisted boolean would remove. The rest of the parked surface (HUD, debug,
Blender tools, tests like `anti-grav.test.ts`) keeps the DLC-revival option cheap and
the tests keep it from silently rotting. This is the right way to park a feature.

## TypeScript rigor & lint posture

`tsconfig.json` is maximal-strict: `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
`isolatedModules`. Across ~93,500 lines of src TypeScript there are **zero**
`@ts-ignore`/`@ts-expect-error`/`@ts-nocheck` and only 6 TODOs (four of which are the
same rider-clip asset defect, honestly annotated in `src/game/bikes/variants.ts`).
That is elite hygiene.

The escape hatches cluster where you'd predict: 55 of 73 `as any` live in
`src/engine/render/water.ts`, almost all at Three.js TSL node-graph seams
(`texture(tex, (uv as any).add(...))`, `waveEventsUniform.element(i) as any`) where
`three/tsl`'s typings genuinely fall short. Defensible individually; collectively a
signal that water.ts needs both decomposition and a small typed-TSL helper layer.

The lint posture is the soft spot. `biome check` exits 0 on **1,358 warnings** because
only errors fail, so the "Lint" CI step is a weaker gate than it looks: unused imports
(`game-loop.ts:139`), unused variables, and 46 stray `console` calls all ride through
green. 1,291 of the warnings are `noNonNullAssertion` — a coherent consequence of
`noUncheckedIndexedAccess` (loop-indexed `pts[i]!` in `src/boot/respawn.ts:53` is
typical) — but at that volume the warning is pure noise: nobody will spot warning
#1,359 being a real one. Either bless the pattern (`off` with a comment) or burn it
down; don't let it drown the correctness class. Also: `biome migrate` is overdue
(schema 2.4.16 vs CLI 2.5.9, deprecated `recommended` field).

## Test strategy & real coverage

The split is exactly right for the architecture: 151 Vitest files (~24,500 test LOC;
~34,200 across `tests/` once the e2e specs are counted, vs ~93,500 src LOC) run the
Three-free sim in Node — including real Rapier WASM — while 71 Playwright specs cover
boot/render/feel against a real dev server. Unit coverage of
the sim is genuinely deep: hover state machines, drift tiers/yaw, launch grade, tricks,
tuck, OOB, stuck-rescue, rubber-band, race laps/standings/gate-sweep, and the whole
multiplayer data plane (host-election, slot-assign, transform-snapshot,
apply-snapshot, remote-interp, relay-ping, relay-start-barrier, latency) plus the
leaderboard server/HMAC/profanity stack. E2E specs are high quality where I sampled:
`field-completion.spec.ts` polls per-bike checkpoint progress with named-culprit
failure messages, runs the Reef Cup three by default, and carries an honest
`test.fixme` for cape-town-drift's known cp9 terrain stall.

Real gaps:

- **The boot/orchestration layer is test-thin where the bugs actually happen.**
  `game-loop.ts` (2,615), `race-boot.ts` (2,118), `menu-flow.ts` (1,871) have no
  direct unit tests (only extracted satellites like `attract-backdrop.ts` and
  `race-intro.ts` do). The 2026-08-19 playtest fixes were nearly all boot/menu-layer
  bugs, and the warm-restart orchestrator was explicitly deferred because "a missed
  store means corrupted restarts" (`docs/status.md`) — that is a statement about this
  layer's untestability.
- **Multiplayer has no cross-tab e2e.** README's known-issues list says it plainly:
  M10.11 snapshot sync is unit + manual only; cross-tab bugs need manual repro.
- **The asset-contract tests never run where they'd matter.** The 6 skipped GLB tests
  and `tools/validate-track-assets.mjs` only run on hydrated clones; CI's
  `check-and-build` deliberately runs asset-free, so a bad `assets:push` is invisible
  to CI (see fix #3 — these checks need no GPU, only bytes).
- **No coverage reporting in CI.** `vitest.config.ts` wires v8 coverage carefully
  (text/html/json, src-only include) but nothing runs `test:coverage` in any workflow,
  so coverage can regress silently.

## CI/CD health

Four workflows, all four read in full. `check-and-build` (typecheck → lint → unit →
build) and `docs` are real gates and match what I ran locally. `determinism`, `e2e`,
and `qa` all hydrate-from-R2-or-skip; the secret has never been set, so green there
means "not exercised" — and the docs *say so themselves*, with measured evidence:
`ci.yml`'s REALITY CHECK comment records the determinism gate's 2 passed / 1 failed in
7.7 min on SwiftShader, and CLAUDE.md hard rule 1 records the 14/14 failed QA cells
(the `qa.yml` workflow itself doesn't carry that measurement).
The 2026-08-21 fix (#28) giving `e2e` the same skip path its siblings had ended the
era of every run-level badge reading `cancelled`. This level of CI self-documentation
is exemplary; the underlying capability is not: **no workflow can currently exercise
the game**, because GitHub-hosted runners have no GPU. The honest post-fix state is
"CI proves the code compiles, unit-passes, and bundles — nothing more."

Branch protection (per `docs/maintainer-workflow.md`, stated in docs, not
independently verifiable from here): `main` requires `check-and-build` + `docs`, but
`enforce_admins` is off and the `.githooks/pre-push` hook is opt-in per clone — so a
maintainer push to `main` can run **zero checks** and is simultaneously a production
deploy (two Vercel projects + PartyKit relay). The doc's own postmortem shows the
sharp edge: `partykit-deploy` is main-only and failed on five consecutive commits
before anyone looked. The mitigation is one line (`git config core.hooksPath
.githooks`) that depends on remembering to run it — see fix #2.

## Build & release tooling

Surprisingly mature for the project's size. `vite.config.ts` (338 lines) carries three
purposeful dev plugins — a traversal-guarded editor save endpoint (id regex +
`startsWith(TRACKS_DIR)` check, serve-only so prod never ships a write endpoint), a
debounced Blender asset-watch, and a cold-start terminal hint — plus a documented
`optimizeDeps.noDiscovery` cold-boot fix with its trade-off (new bare imports must be
listed) spelled out in both the config and CONTRIBUTING. `electron/main.cjs` (156
lines) is small and battle-scarred in the good sense: `app://` scheme with
path-traversal rejection, Steam-Linux-Runtime sandbox/zygote workarounds, and a NOTE
documenting which ANGLE flags black-screen and must not return. `build-deck.mjs`
bundles a `libcups.so.2` survival kit with a loud warning when the host lacks it.
`release-steam.yml` is manual-dispatch-only with the irreversibility rationale stated.
The one structural risk: none of the desktop path is exercised by any routine gate
(`build-desktop.yml` is tag/dispatch-only), and `dependency-triage.md` already logged
an electron bump shipping "unverified" for exactly that reason.

## Dependency posture

`docs/dependency-triage.md` is the strongest dependency-governance doc I've reviewed
on a project this size: three risk classes, a measured case study (rapier 0.19→0.20
passed *every* test while moving the bike 47 cm and changing hover velocity 45% —
deferred with a scoped `0.20.x` dependabot ignore), and a genuinely instructive
postmortem on the open-ended-override footgun (`undici` floor resolving to v8,
breaking miniflare on main-only deploy, fixed with the scoped `"miniflare>undici":
"^7.29.0"` override now visible in `package.json`). The `pnpm.overrides` block is
security floors + that one scoped fix, all explicable. Versions are current-ish
(three 0.184, vite 8, vitest 4, TS 6, electron 42) with measured-safe majors (TS 7,
types/node 26) parked deliberately. No findings here beyond: the rapier deferral means
the physics engine is pinned to a version whose successor changes solver defaults —
that precision-tuning + golden-reseed pass will only get more expensive the longer the
gap grows.

## Perf posture

The perf story is instrumented rather than vibes: `perf-recorder.ts` (allocation-free
hot-path sampling), `gpu-profiler.ts`, `jitter-telemetry.ts` behind `?jitter=1`,
`perf-budget.spec.ts` / `draw-call-census.spec.ts` / `wave-count-perf.spec.ts` e2e
probes, 17 dated ablation/bench reports in `perf-report/`, and a `?bench=1` in-page
harness spec'd in `docs/perf-baseline.md`. That doc is admirably honest that the
60 fps @ 1080p on M1/Ryzen-5000 target is **still a guess** — measured once on an
RTX 5050 — and pre-commits the decision rule (p95-based, with the 6-bike fallback
hedge) before data arrives. The collision-corridor clipping work (status 2026-06-21,
`src/engine/render/collision-corridor.ts` + unit test with real Rapier ray-cast
verification) shows perf work landing with proofs attached. Remaining engineering
risk: the baseline tables are still mostly blank, and nothing automated will catch a
frame-time regression between now and someone running the harness by hand.

## Top 10 fixes & improvements (ranked)

1. **Stand up a Node-side determinism golden in Vitest — make the paper gate real.**
   The CI `determinism` job has never run and cannot run on GitHub runners; yet unit
   tests already boot real Rapier WASM in Node (`collision-corridor.test.ts`,
   `wave-rider.test.ts`) and the `lagoon` golden track is procedural, needing no GLBs.
   Drive `simulateStep` 600 ticks in Vitest against `serializeSimStores` and a
   committed golden, and the sim-divergence gate runs inside `check-and-build` on
   every PR — also immune to the Chromium-ULP false positives the browser golden has.
   Player impact: a rapier-0.20-class feel regression (bike 47 cm off, hover velocity
   ±45%) gets caught at PR time instead of shipping to the live site.

2. **Close the zero-check path to production: auto-install the pre-push hook and
   revisit `enforce_admins`.** Today a maintainer push to `main` can run no checks and
   is a production deploy for the game, docs, and relay; the mitigating hook is one
   opt-in command a fresh clone won't have run. Add a `prepare` script (or postinstall
   notice) that sets `core.hooksPath .githooks`, and once fix #1 lands, reconsider the
   `enforce_admins` escape hatch since the gates it bypasses will finally be strong.
   Player impact: fewer broken-on-arrival deploys of the live game — the maintainer
   workflow doc itself records five consecutive silent relay-deploy failures.

3. **Hydrate assets in a CI lane with a read-only R2 token and un-skip the byte-level
   checks.** The 6 skipped GLB-contract tests, `tools/validate-track-assets.mjs`, and
   `tools/check-assets-present.mjs` need bytes, not a GPU — the GPU wall only blocks
   the *browser* suites. A read-only rclone credential (the current secret design is
   write-capable, per `ci.yml` comments) lets a cheap job validate the asset store
   against the code on every push. Player impact: asset defects like the standing-rider
   bug (byte-copied `Ride_*` clips, mispositioned `socket_seat`) get caught by CI
   instead of by players noticing riders standing at speed.

4. **Split `src/engine/render/water.ts` (5,838 lines, 55 `as any`) and add a typed TSL
   helper seam.** It is 6× the next-largest render module, concentrates 75% of the
   repo's `any`-escapes, and is the single most-touched surface for the game's
   signature look. Extract the already-cohesive clusters (foam/oil-stroke sampling,
   wave-event rings, contact collars, spectrum uniforms) and wrap the recurring
   `uniformArray.element()`/swizzle casts in a few typed helpers. Player impact: the
   water is the game — lowering the change-risk on this file directly protects the
   most player-visible system from regressions during the ongoing art pass.

5. **Decompose the boot monoliths and ship the warm-restart orchestrator with its own
   e2e.** `game-loop.ts` (2,615) and `race-boot.ts` (2,118) are where the 2026-08-19
   playtest bugs lived (hardcoded respawn listener, teleport re-eject — and the
   2026-08-21 menu-backdrop rework churned the same layer),
   and the warm-restart work is explicitly stalled on "a missed store means corrupted
   restarts" — a symptom of untestable orchestration. Continue the proven extraction
   pattern (`attract-backdrop.ts`, `collision-corridor.ts` are pure and unit-tested).
   Player impact: faster race restarts without corrupted state, and fewer of the
   boot-flow bugs that hit every single session's first minute.

6. **Adopt a lint-debt policy: `biome migrate`, promote correctness rules to error,
   settle the non-null-assertion question.** Lint currently passes green with 1,358
   warnings; 1,291 are `noNonNullAssertion` noise that buries the 4 real
   correctness-class findings (unused imports/variables) and 46 `noConsole` hits. Set
   correctness rules to `error`, then either bless `!` (rule off, comment why, given
   `noUncheckedIndexedAccess`) or fix the hot paths. Player impact: indirect but real —
   a warning channel with signal is how "unused import from an incomplete refactor"
   gets caught before it's a shipped half-refactor.

7. **Automate a two-tab multiplayer e2e probe.** README's known issues concede that
   cross-tab bugs need manual repro; the relay (`party/relay.ts`) runs locally via
   `pnpm party:dev`, and Playwright drives multiple contexts in one test — snapshot
   sync, host election, and the sticky `raceStarted` bit are all assertable through
   `__hover` without pixel-perfect rendering. Player impact: multiplayer is a headline
   mode; today a lobby- or sync-regression can only be discovered by a human opening
   two tabs, which means players find it first.

8. **Get one GPU-attached runner into the loop — even just nightly.** The e2e suite
   (71 specs) and QA matrix are well-built and near-worthless in CI because GitHub
   runners have no GPU (measured: 14/14 QA cells failed on SwiftShader). A self-hosted
   runner on the maintainer's own GPU box, running `e2e` + `qa` nightly against
   `main`, converts ~70 dormant specs into a daily regression net without blocking
   PRs. Player impact: boot-time, draw-call, and field-completion regressions get a
   day-scale detection window instead of a "whenever someone runs it headed" one.

9. **Sweep per-tick allocations out of the 60 Hz sim loop.** Verified examples: the
   parked `antiGravSystem` allocates a filtered spline array every tick before its
   early-exit (`anti-grav.ts:148`), and the per-tick input-frame encode/decode
   round-trip allocates by design (`game-loop.ts:1152-1169`, self-described "~10
   bytes / one alloc"). Individually trivial; collectively they are GC pressure inside
   the loop the jitter investigation worked hard to smooth. Player impact: fewer
   GC-induced micro-hitches — exactly the p95 frame-time spikes the perf baseline doc
   says players feel as stutter.

10. **Wire coverage reporting into CI and ratchet it.** `vitest.config.ts` has a
    carefully-scoped v8 coverage setup that nothing runs; there is no number for what
    the impressive-looking 151-file suite actually covers, and the boot-layer gap
    (fix #5) is invisible in any dashboard. Run `pnpm test:coverage` in
    `check-and-build`, publish the summary to the job, and set a floor that only moves
    up. Player impact: keeps the sim's excellent test discipline from silently eroding
    as the precision-tuning phase touches feel-critical systems weekly.
