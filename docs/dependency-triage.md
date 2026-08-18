# Dependency triage — how to judge a dependabot PR here

*Written 2026-08-18, after clearing all 39 alerts and measuring the queue behind
them. The short version: **a green `pnpm verify` is not sufficient evidence for a
runtime bump.** Rapier 0.20 passed typecheck, lint and all 1421 unit tests while
moving the player bike 47 cm and changing hover velocity by 45%.*

## Three risk classes

| Class | Examples | Evidence needed |
|---|---|---|
| **Dev tooling** | biome, vitest, playwright, vite, jsdom, electron-builder | `pnpm verify` + `pnpm build`. Merge on green. |
| **Dev tooling, major** | typescript, `@types/node` | Same, but read the changelog first and land it alone. |
| **Runtime** | `three`, `@dimforge/rapier3d-compat` | The above **plus** the determinism harness, below. `three` is 0.x, so its "minor" bumps are breaking-allowed — treat a minor as a major. |

Dependabot groups mirror this split (`.github/dependabot.yml`), so a compiler
major can never ride in on the back of a routine patch sweep again — which is
exactly what made PR #7 read as already-superseded when it wasn't.

## The objective sim gate

`tests/e2e/determinism-snapshot.spec.ts` steps the sim 600 ticks (10 s at the
fixed 60 Hz step) under a fixed scripted intent and byte-compares against
`tests/e2e/fixtures/determinism/lagoon.txt`. For a physics or render bump this
answers "did the simulation change?" without anyone squinting at a screenshot:

```bash
E2E_PORT=<N> pnpm e2e determinism-snapshot
```

Needs hydrated assets (`pnpm assets:pull`) and a real GPU — headed, per
[CLAUDE.md](../CLAUDE.md) hard rule 2. It skips on GitHub runners by design.

**If the golden is already failing** (a stale golden, or in-flight WIP), it is
still usable: capture the snapshot before and after the bump and diff those two
against each other instead of against the golden. That isolates the dependency's
contribution with the rest of the tree held constant. `sandbar` runs in
write-only mode and lands in `artifacts/determinism/now-sandbar.txt`; the
`lagoon` snapshot can be lifted from the assertion's `Received:` value.

Compare *bodies*, not the whole string — the snapshot also embeds derived
telemetry (smoothed inputs, `groundDistance`) whose last ULP moves when the
Chromium that Playwright ships changes. That is a false positive, not a sim
change; see the reseed in #20.

Render-side, `pnpm e2e draw-call-census` is a cheap objective check. The
`*-look` specs (`water-look`, `wake-look`, `wind-look`) are env-gated and skip
unless explicitly enabled.

## Measurements taken 2026-08-18

Everything below was run against `main` at the time, full gate plus determinism.

| Bump | Gate | Determinism | Verdict |
|---|---|---|---|
| `three` 0.184.0 → 0.185.1 (+ `@types/three` 0.185.4) | ✅ typecheck, lint, 1421 tests, build, draw-call census | ✅ **byte-identical** | Safe. Visual eyeball still outstanding — the `*-look` specs are gated off. |
| `typescript` 6.0.3 → **7.0.2** | ✅ all | ✅ | Safe. Major, so land it alone. |
| `@types/node` 20.19.43 → **26.2.0** | ✅ all | ✅ | Safe. |
| `jsdom` 29.1.1 → **30.0.1** | ✅ 1421 tests | n/a | Safe. |
| `electron` 42.9.2 → **43.4.0** | ✅ install + typecheck | n/a | Unverified — the desktop build (`build-desktop.yml`) is not exercised locally. |
| `@dimforge/rapier3d-compat` 0.19.3 → 0.20.0 | ✅ all | ❌ **all 104 lagoon bodies move** | **Deferred.** Ignored at `0.20.x` in dependabot config. |

All the above were verified together as one tree as well, and stayed green.

### Why rapier is deferred

Its 0.20 changelog reworks the contact solver defaults — `erp` → natural
frequency, a finite `normalized_max_corrective_velocity`, and the internal
fast-contact special case removed. We set none of those explicitly, which is
precisely why the default change lands on us. Measured, same tree, same input:

- **lagoon** — all 104 bodies move. Player bike ends 47 cm off in Z, hover
  height off by 3.8 cm, vertical velocity off by 45% (−0.375 → −0.544 m/s).
- **sandbar** — 104 of 209 bodies move, 39 of them by more than 10 m.

Hover height and vertical velocity *are* wave mastery. It closes no advisory, so
there is nothing to weigh against a feel change. Picking it up means: re-apply,
run the harness headed to see the delta, do a precision-tuning pass on
hover/contact response, then reseed the golden with `UPDATE_GOLDEN=1`.

The ignore is pinned to `0.20.x`, so 0.21+ will still be raised.

## Security alerts

All 39 open alerts were transitive **dev** dependencies whose fixed versions were
already inside the declared ranges — just pinned stale in the lockfile. `pnpm
update` cleared every one (66 audit findings → 0) and wrote the ranges back so a
fresh install cannot regress. Reach for `pnpm.overrides` only when a parent's
range genuinely blocks the fix; the entries already in `package.json` are inert
floors from older advisories.
