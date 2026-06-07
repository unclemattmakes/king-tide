# Hoverbike QA Playbook

> Companion to [docs/v1-work-breakdown.md](./v1-work-breakdown.md). The
> work-breakdown declares what we ship; this doc declares what we
> ship-block on. Lives outside the milestone log so the convention
> doesn't churn when individual systems land.

This is the **QA contract** for the Hoverbike project — what every
build is graded against, how those gates run, and how a regression
gets from "noticed" to "fixed". Modeled on the
definition-of-done convention in `v1-work-breakdown.md`: every gate
declares its scope, its threshold, and its surfacing path before it's
counted.

## TL;DR

| Gate | Runner | Threshold |
|---|---|---|
| Typecheck | `pnpm typecheck` | 0 errors |
| Lint | `pnpm lint` | 0 errors |
| Unit tests | `pnpm test` | 100% pass |
| Track lint (opt-in) | `pnpm gen:tracks:validate` | 0 errors (advisory warnings ok) |
| E2E smoke | `pnpm e2e` | 100% pass on Chromium |
| QA matrix | `QA_MATRIX=1 pnpm e2e tests/e2e/qa-track-matrix.spec.ts` | every enabled cell boots + autoplays 5 s + holds fps ≥ floor / p95 ≤ ceiling (see `tools/qa/matrix.mjs`) |
| QA soak | `QA_SOAK=1 pnpm e2e tests/e2e/qa-soak.spec.ts` | 60 s autoplay clean (no console errors, hitch fraction < 5%, heap end/mid ratio < 1.5) |
| QA boot loop | `QA_BOOT_LOOP=1 pnpm e2e tests/e2e/qa-boot-loop.spec.ts` | 5 cold boots without console errors and heap growth < 2× |
| Cross-browser smoke | `E2E_BROWSERS=all pnpm e2e tests/e2e/cross-browser-smoke.spec.ts` | menu cathedral renders on Chromium / Firefox / WebKit |

Current pass-state per gate is whatever the latest CI run on `main`
says — don't trust a hand-maintained ✅ here, check
[GitHub Actions](https://github.com/occ-matt/hoverbike/actions) (or
`gh run list --workflow=ci.yml --branch=main` from a shell).

`pnpm qa` runs the orchestrator end-to-end (typecheck + lint + unit +
matrix) and emits a Markdown + JSON report under `qa-report/`. Add
`--soak` to include the stability soak. Track lint is opt-in via
`--track-lint` (off by default since CI runners don't ship Blender).

## Shippability — what "PASS" means

A build is **shippable** when every gated step on `pnpm qa --soak`
reports ✅ on Chromium and the cross-browser smoke is green on
Firefox + WebKit. Track lint is advisory (won't fail the report) since
it depends on a Blender toolchain that CI doesn't ship by default.

A build is **mergeable to main** when:

1. CI (typecheck / lint / unit / build / docs / Chromium e2e) is
   green.
2. The QA workflow's `qa-report.md` has no new gated failures vs the
   baseline on `main`. Today the workflow runs non-blocking — a PR can
   merge while the matrix is red, but the failure has to be triaged
   (filed as a `qa-regression` issue or labeled `qa-known-gap`) before
   merging.

The non-blocking stance is a **calibration period**. Per-track perf
budgets and the matrix's enabled cells are still settling as v1 art
lands; once a track flips to `status: 'ship'` in the catalog its
cells get their own per-track budget and start gating PRs.

## Running QA

### First-time setup

```bash
pnpm install              # installs deps
pnpm e2e:install          # downloads the Playwright Chromium binary
pnpm qa --doctor          # verifies the above + checks dev port 5391 is free
```

`pnpm qa --doctor` is a preflight-only run — no gates execute, just
the dep / Playwright / port checks. Use it when picking up the repo
on a new machine, or after a long pause.

### Local — one-shot

```bash
pnpm qa                # typecheck + lint + unit + matrix
pnpm qa --soak         # … + soak run
pnpm qa --track-lint   # … + Blender-side gen:tracks:validate (needs BLENDER_EXE)
pnpm qa --skip-typecheck --skip-lint   # if you've already iterated those
```

The report lands at:

- `qa-report/qa-report.md` — human-readable summary + preflight table
  + per-cell perf table + per-step log tails
- `qa-report/qa-report.json` — same shape as the artifact CI uploads,
  `schemaVersion: 1`
- `qa-report/<step>.log` — raw stdout/stderr per step

### Local — targeted

```bash
pnpm qa:smoke          # just the parameterised track × bike matrix
pnpm qa:soak           # just the 60s stability soak
pnpm test:coverage     # vitest with V8 coverage → coverage/index.html
```

`pnpm qa:smoke` and `pnpm qa:soak` don't generate a report — they're
for re-running a single gate after a fix.

### CI

`.github/workflows/qa.yml` runs `pnpm qa` on every push + PR, uploads
two artifacts (`qa-report/` and `playwright-report/` — the latter lets
a triager open a trace.zip in the Playwright trace viewer without
re-running locally), and writes the Markdown summary into the job's
GitHub Step Summary so it's visible from the Actions tab without
unzipping. Failures **do not** block the PR today — the existing
`ci.yml` is the gating workflow. The `qa.yml` job carries
`continue-on-error: true`; we no longer double-mask with `|| true`.

The same workflow ships a `qa-soak` step that runs `pnpm qa --soak`
nightly on `main` only.

## Matrix details

`tools/qa/matrix.mjs` is the single source of truth for which
(track × bike) cells the QA matrix exercises **and** the global
fps/p95 floor (`GLOBAL_PERF_BUDGET`). `tests/e2e/perf-budget.spec.ts`
imports the same constant, so a budget tweak lives in one place.

Two principles:

1. **Procedural tracks are the floor.** `lagoon` and `cliffside` are
   tested against every bike. If they regress, the QA pass fails
   regardless of anything else.

2. **Ship tracks expand outward.** When a v1 track lands its GLB +
   JSON, its `racer` cell flips to `enabled: true`. When the track
   flips to `status: 'ship'` in `tracks-catalog.ts`, its `cruiser` +
   `stunt` cells join too.

To add a track to the matrix:

```js
// tools/qa/matrix.mjs
{ id: 'liberty-drowned', bike: 'racer', enabled: true },
```

Per-track perf budgets are optional. The global default (`fps >= 30`,
`p95 <= 50ms`) is used unless `perfBudget` is set on the cell.
Wave-heavy tracks (The Maw, Aqualand) will likely get their own
ceiling once art tuning lands; until then, the global default applies.

The matrix log emits structured `qa-matrix:<track>:<bike>:perf {...}`
JSON lines per cell. The orchestrator parses these and renders a perf
table in `qa-report.md` so triagers see actual fps / p95 / hitch
counts without grepping the log.

## Bug repro bundle

When a tester reproduces an issue in a running session (any URL),
they can run:

```js
window.__hover.qa.downloadBundle()
```

The download is a single JSON file containing:

- timestamp, full URL, user agent, viewport size + DPR
- selected renderer backend
- current perf stats (P50 / P95 / P99 / hitch count)
- player + race ECS snapshot
- sanitised player settings (leaderboard handle masked to length only)
- last 200 console messages (errors, warnings, page errors, unhandled
  rejections — whichever is currently in the trap ring)
- a hint at the replay availability + size (the replay binary itself
  isn't bundled; use `window.__hover.perf.downloadCsv()` /
  `downloadReplay()` for separate downloads when needed)

The bundle is gated to dev / test builds — production has no `qa`
surface, so no settings or console data leaks via this path.

### Filing a bug

1. From the running tab: `window.__hover.qa.downloadBundle()`.
2. Open the [QA issue template](https://github.com/occ-matt/hoverbike/issues/new?template=qa.yml).
3. Drag the bundle JSON into the "QA bundle" field. The template's
   triage workflow reads the timestamp / URL / commit out of the
   bundle so triagers don't have to chase them.

## Reporting

The full layout under `qa-report/`:

```
qa-report/
├── qa-report.md     # rendered human report (committable diff target)
├── qa-report.json   # machine-readable, schemaVersion=1
├── typecheck.log    # raw stdout/stderr per step
├── lint.log
├── unit.log
├── matrix.log
└── soak.log         # only if --soak was passed
```

The Markdown report has these sections:

1. **Shippability** — single line, "✅ no gated failures." or "❌ one
   or more gated steps failed".
2. **Preflight** — dep / browser / port check status.
3. **Summary** — one row per step with status / duration / gate /
   log path (paths are repo-relative on both POSIX and Windows).
4. **Matrix perf** — per-cell fps / p50 / p95 / p99 / hitch / sample
   counts, parsed out of the matrix log.
5. **Per-step detail** — for failed steps, inlines the last 40 log
   lines under a `<details>` block.

## Test conventions

### Console-error gate is universal

Every new Playwright spec should opt into the `consoleErrors`
fixture (`tests/e2e/helpers/console-errors.ts`):

```ts
import { expect, test } from './helpers/console-errors'

test('my spec', async ({ page, consoleErrors }) => {
  await page.goto('/?autostart=1')
  // … assertions …
  consoleErrors.assertNone()
})
```

Allow specific known-noisy lines with `consoleErrors.allow(/regex/)`.
Every allowlist entry is a TODO — surface them in code review.

Reset the collector after the boot / settle-in window with
`consoleErrors.reset()` if you want the assertion to grade only the
post-reset interval (the matrix spec does this so cold-load shader
compile warnings don't flunk a cell).

### Boot probes

Three readiness helpers live in `tests/e2e/helpers/boot.ts`:

- `waitForReady(page)` — debug API mounted (`__hover.ready === true`)
- `waitForPerfReady(page)` — adds `__hover.perf != null`
- `waitFullyBooted(page)` — adds bike spawned + grounded

Use the strictest one your spec actually depends on. A spec that
asserts on physics state should always call `waitFullyBooted` so a
boot-sequence regression has a single place to surface.

### Platform skips

WebKit on Linux gets software WebGL only — any GPU-bound spec uses:

```ts
import { skipWebKitLinux } from './helpers/platform-skips'

test.describe('M9 cliffside', () => {
  skipWebKitLinux(test)
  // …
})
```

### Determinism remains its own thing

The determinism harness (`__hover.determinism.run()`) and the
m10-determinism spec are deliberately separate from the QA matrix.
QA is about "does it boot and stay up"; determinism is about "does it
boot up the *same* every time". The two gates protect different
properties.

The determinism spec doesn't use the `consoleErrors` fixture — it
spins up its own browser contexts per probe so it can run two cold
boots in parallel. The inline `page.on()` capture there is
intentional, not a migration oversight.

### Visual regression — not done yet

A future iteration will add menu / hero-shot golden snapshots
(probably under `tests/visual/`). Until then, the cross-browser
smoke's screenshot attachment is the only visual-side signal we
collect, and it's eyeball-only.

## Playtest checklist — manual QA

Automated gates can't catch "the bike feels heavy" or "the music
clashes with the wave-pump chime". For pre-release sweeps, walk
through this list once per track:

- [ ] Boots to first race in < 5 s on a reference machine (M1 / Ryzen
      5000-class).
- [ ] Wave-pump signal triggers on a clean crest launch; audio cue is
      distinct from gate / lap dings.
- [ ] Wave-line shimmer fans forward of the bike; lock pip turns
      yellow on a strong swell.
- _Anti-grav: **cut for v2** (parked for a possible DLC). No shipped track
      places anti-grav zones, so there's nothing to verify here._
- [ ] AI completes a full lap on each difficulty (Casual / Standard /
      Hard) within the lap-target window.
- [ ] Rubber-band assist toggle takes effect mid-race without
      snapping.
- [ ] Tutorial mode boots from menu + Settings → "Replay tutorial".
- [ ] All settings rows persist across reload (close tab, reopen).
- [ ] Multiplayer lobby auto-joins on `?room=<id>`; ping badge
      surfaces.
- [ ] Leaderboard submission lights up on PB; profanity filter
      catches obvious cases.
- [ ] Pause menu → resume; pause menu → exit returns to main menu
      cleanly.
- [ ] Backspace respawn works at start gate.
- [ ] Garage / settings tabs all reachable via keyboard alone (no
      mouse).
- [ ] Every menu / overlay is fully navigable by **controller alone** —
      main menu + sub-screens, bike / track / cup select, pause, Settings,
      Rebind modal, post-race finish + cup-results, multiplayer lobby, credits
      (mode → CREDITS). D-pad moves focus, A activates, B/back exits. Pay special attention
      to **stacked overlays** (Settings over the pause card, Rebind over
      Settings): opening the top one must not strand the cursor or swallow
      the A press — see the input-navigability convention in
      [v1-work-breakdown.md](./v1-work-breakdown.md).
- [ ] Every menu / overlay is fully navigable by **touch** — buttons
      tappable, and the in-race joystick / face buttons never sit over (or
      intercept taps meant for) a results / pause / menu card. Verify the
      finish + cup-results screens drop the touch overlay
      (`body.touch-ui-hidden`).
- [ ] Accessibility — colorblind palettes swap warning / success +
      leader / opponent channels on the minimap.
- [ ] Audio sliders feel right — master / music / SFX / ambient at
      50% should still be audible.

Any failure here gets a `qa-manual` label on the issue.

## Roadmap

- Per-track perf budgets, calibrated from a baseline run on each
  reference machine (M1 Mac, Steam Deck, mid-range Ryzen) — gates
  flip from advisory to mandatory as each track ships.
- Visual regression for menu surfaces (low-volatility, deterministic).
- Determinism matrix — extend `m10-determinism.spec` across every
  track.
- Replay-driven regression — pin a known-good replay per track, drive
  the determinism harness through it, assert final snapshot matches.
- Lighthouse / a11y audit harness (axe-core against the menu DOM).
- Coverage signal — `pnpm test:coverage` produces HTML now; CI doesn't
  yet enforce a floor. Add a soft target (e.g. 70% lines on `src/game/`)
  once we've eyeballed where the natural baseline sits.

These are tracked as comments on the Polish/QA row in
`v1-work-breakdown.md`.
