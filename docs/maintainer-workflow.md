# Maintainer workflow — pushing to `main`

*For people with write access. Contributors fork and open PRs; that path is in
[CONTRIBUTING.md](../CONTRIBUTING.md) and is unchanged by anything here.*

Short answer: **direct pushes to `main` are fine on this repo, once the local
hook is enabled.** Being public does not by itself make them wrong — plenty of
solo-maintained OSS works this way. What makes them risky *here* is specific and
fixable, and this page is the fix.

## What actually gates a push today

| | pre-push hook | PR checks | direct push |
|---|---|---|---|
| typecheck | ✅ | ✅ | ✅ *once the hook is on* |
| lint | ✅ | ✅ | ✅ *once the hook is on* |
| unit tests | ✅ | ✅ | ✅ *once the hook is on* |
| production build (`check-and-build`) | ❌ | ✅ | ❌ |
| docs build (`docs`) | ❌ | ✅ | ❌ |
| Vercel preview to eyeball | ❌ | ✅ both projects | ❌ |
| e2e · determinism · QA matrix | ❌ | ⚠️ skip — no GPU on runners | ❌ |
| `partykit-deploy` | ❌ | ❌ **main-only** | runs *after* the push |

Three things follow from that table.

1. **The hook is opt-in and off by default.** `.githooks/pre-push` is committed,
   but git ignores it until you point at it. Until you do, a direct push runs
   *no* checks at all.
2. **Branch protection does not stop a maintainer.** `main` requires
   `check-and-build` + `docs`, but `enforce_admins` is off, so an admin push is
   waived with `remote: Bypassed rule violations`. That is a deliberate escape
   hatch, not a bug — but it means the protection is a convention for you and a
   hard rule only for everyone else.
3. **A push to `main` is a production deploy.** Both Vercel projects and the
   PartyKit relay deploy from it. There is no staging step in between.

## Do this once per clone

```bash
git config core.hooksPath .githooks
```

That turns on `pnpm verify` (typecheck + lint + test) before every push. It is
the single highest-value line in this document: it closes three of the five CI
gates on the direct-push path, costs one command, and is per-clone so it cannot
surprise a contributor.

## When to push directly, when to open a PR

**Push directly** when the change is small and you have run what the hook does
not:

- docs, comments, `*.md`, changelog entries → just push (add `pnpm docs:build`
  if you touched `docs-site/`, since the `docs` job is the only thing that
  compiles it)
- a small code fix where you have already run `pnpm verify && pnpm build`

**Open a PR** when you want a gate the hook cannot give you:

- anything touching `package.json` / `pnpm-lock.yaml` — see
  [dependency-triage.md](dependency-triage.md)
- anything under `party/`, `.github/workflows/`, or `vercel.json`
- render/water/physics work, where you want the Vercel preview to look at
  before it is the live site
- anything you want a reviewable record of, or that a contributor is involved in

**Never**, regardless:

- `git push --force` to `main`. History was rewritten once, during the
  open-sourcing cut; that phase is over. Branch protection blocks it — do not
  route around it.
- push straight to `main` on a red tree because "CI will tell me". On this repo
  CI telling you means the broken build is already deployed.

## After anything lands on `main`

The gap PRs cannot close is the **main-only** jobs — `partykit-deploy` is
`if: github.event_name == 'push' && github.ref == 'refs/heads/main'`, so its
first run is always against merged code. A green PR says nothing about it.

```bash
gh api repos/unclemattmakes/king-tide/commits/$(git rev-parse HEAD)/check-runs \
  --jq '.check_runs[] | "\(.name)  \(.status)/\(.conclusion // "-")"'
```

This is not hypothetical: `partykit-deploy` failed on five consecutive main
commits in August 2026 before anyone looked, because every PR in that stretch
was green. See the postmortem in
[dependency-triage.md](dependency-triage.md#the-gap-a-lockfile-refresh-can-fall-through).

## Reading the CI results honestly

`check-and-build` and `docs` are the only checks that both gate PRs and actually
exercise the code. `e2e`, `determinism` and the QA matrix boot real tracks, so
they hydrate assets from R2 and **skip** when `RCLONE_CONF_BASE64` is absent —
which it always is. A green tick on those means *"not exercised"*, not
*"passed"*. Do not add that secret expecting them to light up; it has been
measured, and GitHub's GPU-less runners just turn a green skip into a permanent
red. Full detail in [CLAUDE.md](../CLAUDE.md) hard rule 1.

### Why `e2e` used to read `cancelled`, and what changed

*(2026-08-21. Until this date `e2e` did **not** skip, and both this page and
CLAUDE.md wrongly said it did.)*

`determinism` and `QA report` have always ended in a `Skip notice (no asset
secret)` step, with every real step gated behind `HAS_ASSET_SECRET == 'true'`.
`e2e` had no such step: only its *Install rclone* and *Hydrate assets from R2*
steps were gated, so `Run e2e` fired unconditionally, drove the whole suite
against a bare `public/assets`, failed every asset- or GPU-dependent spec, and
got killed by its own `timeout-minutes: 25`.

Two things fell out of that, and both are worth recognising if you are reading
runs from before this date:

- **`e2e` read `cancelled` on essentially every push.** That was its steady
  state, not a signal. It is `continue-on-error: true` — informational by
  design — so it gated nothing either way.
- **The *run-level* conclusion read `cancelled` too.** A cancelled job
  propagates to the workflow run, so the runs list showed `cancelled` for
  healthy commits and broken ones alike. Verified on `main` at `90f95b7`
  (PR #26's merge, where `check-and-build`, `docs`, `determinism` and
  `partykit-deploy` all passed) and on every recent main run back through #22.

`e2e` now takes the same skip path as its two siblings, so a run's conclusion
tracks the jobs that actually ran and a 25-minute runner slot per push comes
back. **The habit still holds regardless: judge a commit by `check-and-build`
+ `docs`, not by the run-level badge.** That badge can go red or cancelled for
reasons that have nothing to do with the diff, and three of the five jobs are
non-gating by design.

Setting `RCLONE_CONF_BASE64` would turn `e2e`'s skip into a red, not a green —
the specs hit the same GPU-less-runner wall the determinism gate does. Real
coverage for sim/render/feel work is headed Playwright on your own machine
(hard rule 2), not CI.

## If you would rather remove the escape hatch

Turning on **Settings → Branches → `main` → "Do not allow bypassing the above
settings"** (`enforce_admins`) makes every change — yours included — go through
a PR. That is a legitimate choice and it is what the table above would otherwise
be arguing for.

It is not the recommendation here: for a solo maintainer it adds a branch, a
push, a ~90 s wait and a merge to every typo fix, and the same safety is
available from the hook plus the judgment above. Revisit it when a second person
gets write access — at that point the convention stops being self-enforcing.
