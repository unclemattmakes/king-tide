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

| Gate | Runner | Threshold | Today |
|---|---|---|---|
| Typecheck | `pnpm typecheck` | 0 errors | ✅ |
| Lint | `pnpm lint` | 0 errors | ✅ |
| Unit tests | `pnpm test` | 100% pass | ✅ 624/624 |
| Track lint | `pnpm gen:tracks:validate` | 0 errors (advisory warnings ok) | ✅ |
| E2E smoke | `pnpm e2e` | 100% pass on Chromium | ✅ |
| QA matrix | `QA_MATRIX=1 pnpm e2e tests/e2e/qa-track-matrix.spec.ts` | every enabled cell boots + autoplays 5 s + holds fps ≥ 30 / p95 ≤ 50 ms | ⏳ calibrating |
| QA soak | `QA_SOAK=1 pnpm e2e tests/e2e/qa-soak.spec.ts` | 60 s autoplay clean (no console errors, hitch fraction < 5%, heap end/mid ratio < 1.5) | ⏳ calibrating |
| Cross-browser smoke | `E2E_BROWSERS=all pnpm e2e tests/e2e/cross-browser-smoke.spec.ts` | menu cathedral renders on Chromium / Firefox / WebKit | ✅ |

`pnpm qa` runs the full sweep (everything except cross-browser, which
is opt-in) and emits a Markdown + JSON report under `qa-report/`. Add
`--soak` to include the stability soak.

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

### Local — one-shot

```bash
pnpm qa                # typecheck + lint + unit + track lint + matrix
pnpm qa --soak         # … + soak run
pnpm qa --skip-typecheck --skip-lint   # if you've already iterated those
```

The report lands at:

- `qa-report/qa-report.md` — human-readable summary + per-step log tails
- `qa-report/qa-report.json` — same shape as the artifact CI uploads
- `qa-report/<step>.log` — raw stdout/stderr per step

### Local — targeted

```bash
pnpm qa:smoke          # just the parameterised track × bike matrix
pnpm qa:soak           # just the 60s stability soak
```

These don't generate a report — they're for re-running a single gate
after a fix.

### CI

The `.github/workflows/qa.yml` job runs `pnpm qa` (without soak) on
every push + PR, uploads the report as a build artifact, and writes
the Markdown summary into the job's GitHub Step Summary so it's
visible from the Actions tab without unzipping artifacts. Failures
**do not** block the PR today — the existing `ci.yml` is the
gating workflow.

The same job ships a `qa-soak` step that runs `pnpm qa:soak`
nightly on `main` only.

## Matrix details

`tools/qa/matrix.mjs` is the single source of truth for which
(track × bike) cells the QA matrix exercises. Two principles:

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
├── track-lint.log
├── matrix.log
└── soak.log         # only if --soak was passed
```

The Markdown report has three sections:

1. **Shippability** — single line, "✅ no gated failures." or "❌ one
   or more gated steps failed".
2. **Summary** — one row per step with status / duration / gate / log
   path.
3. **Per-step detail** — for failed steps, inlines the last 40 log
   lines under a `<details>` block so the report itself contains the
   triage starting point.

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

### Determinism remains its own thing

The determinism harness (`__hover.determinism.run()`) and the
m10-determinism spec are deliberately separate from the QA matrix.
QA is about "does it boot and stay up"; determinism is about "does it
boot up the *same* every time". The two gates protect different
properties.

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
- [ ] Anti-grav entry / exit visuals fire; camera intensity setting
      respected.
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

These are tracked as comments on the Polish/QA row in
`v1-work-breakdown.md`.
