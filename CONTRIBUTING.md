# Contributing to Hoverbike

Thanks for the interest! This is a small project run as a hobby, so the
process is light. The summary:

- Fork, branch, PR.
- Run `pnpm typecheck && pnpm lint && pnpm test && pnpm build` locally
  before pushing — CI runs the same checks.
- Keep PRs small. One concern per PR is best.

The rest of this file is the longer answer.

## Setup

See the [README's Develop section](README.md#develop) for the dev-server
commands. Prerequisites:

- **Node ≥ 20** and **pnpm ≥ 10** (see `engines` in `package.json`).
- **A WebGPU-capable browser** for the best feel. Recent Chrome / Edge work
  out of the box; Firefox runs the WebGL2 fallback.
- **Playwright Chromium** for end-to-end tests — one-time install via
  `pnpm e2e:install`.
- **PartyKit dev server** for multiplayer work — `pnpm party:dev`
  alongside `pnpm dev`. Not needed for single-player development.
- **Blender 5.1** for asset authoring (bikes, props, tracks). Set
  `BLENDER_EXE` if Blender isn't on your `PATH`. See
  [`docs/blender-pipeline-guide.md`](docs/blender-pipeline-guide.md).
  Skip this if you're only touching code, not assets.

## What's a good first PR?

- Look at issues labelled `good first issue` or `help wanted`.
- The roadmap of Blender automation lives in
  [`docs/blender-wishlist.md`](docs/blender-wishlist.md) — pick an item
  and open a draft PR / issue to claim it.
- The active v1 execution plan is in
  [`docs/v1-work-breakdown.md`](docs/v1-work-breakdown.md); unchecked
  rows in the convention table are fair game.

If in doubt, open a draft PR or a discussion issue early — it's much
easier to course-correct before you've written a thousand lines.

## Workflow

1. **Fork** the repo and create a feature branch off `main`.
2. Use a short, descriptive branch name. Suggested shapes:
   `feat/...`, `fix/...`, `refactor/...`, `docs/...`, `chore/...`.
3. Make your change. Keep the diff focused.
4. Run the local checks (next section).
5. **Open a PR** against `main`. Fill in the template — the "Test plan"
   section matters; reviewers use it to know what was verified.
6. Address review comments by pushing new commits to the same branch.
   Don't force-push to `main`; force-push to your own branch only if it
   helps clean up history.

### Commits

We loosely follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(scope): ...` — new player-facing feature.
- `fix(scope): ...` — bug fix.
- `perf(scope): ...` — visible perf win.
- `refactor(scope): ...` — internal cleanup, no behavior change.
- `docs(scope): ...` — docs only.
- `chore(scope): ...` — tooling, deps, CI.
- `test(scope): ...` — tests only.

Common scopes you'll see: `sim`, `render`, `net`, `hud`, `menu`, `editor`,
`audio`, `controls`, `ai`, `combat`, `track`, `bike`, `blender`. Pick the
one that best describes the area; invent a new scope if needed.

The body is for the **why**; the subject is for the **what**. Keep subjects
under ~70 characters.

## Local checks (what CI runs)

```bash
pnpm typecheck   # tsc --noEmit, strict + exactOptionalPropertyTypes
pnpm lint        # biome check . — formatting and lint
pnpm test        # vitest run — unit tests, sim layer only
pnpm build       # tsc -p tsconfig.build.json && vite build
pnpm docs:build  # only if you touched docs-site/
```

For changes to sim, physics, race, or netcode, also run:

```bash
pnpm e2e         # Playwright, real Vite + WebGPU/WebGL2
```

E2E is **informational in CI today** (allowed to fail) — run it locally
before submitting if your change could affect those areas.

If lint fails, `pnpm format` will fix most issues.

## Architecture rules

A few rules that aren't negotiable. They unlock determinism, headless
tests, and replays / future rollback netcode.

- **The sim layer must not import Three.js.** Anything under
  `src/engine/sim/` or `src/game/systems/` is Three-free. Render systems
  read from the ECS world and write to Three.js objects, never the
  other way around. See [ADR 0002](docs/adr/0002-sim-render-separation.md).
- **The simulation must be deterministic** for a fixed input sequence at
  a fixed tick rate. Rapier is configured for determinism; don't reach
  for `Math.random()` in sim code (use a seeded PRNG if you need
  randomness).
- **No global mutable singletons in sim code.** All sim state lives in
  the bitECS world or in pure functions over it.
- **The relay (`party/relay.ts`) stays stateless.** No per-room state on
  the server. See [`docs/m10-11-state-sync.md`](docs/m10-11-state-sync.md).

The full set of architecture decisions is in
[`docs/adr/`](docs/adr/README.md). Read those before swapping out a major
dependency or moving a layer boundary.

## Testing strategy

| What | Where | Notes |
|---|---|---|
| Pure sim logic | `tests/unit/*.test.ts` (Vitest) | No Three.js, no browser. Fast. |
| Codec / wire formats | `tests/unit/*-snapshot.test.ts`, `input-frame.test.ts` | Binary round-trip + clamping. |
| Track / asset loaders | `tests/unit/*-loader.test.ts` | Parse + serialize round-trip. |
| Gameplay end-to-end | `tests/e2e/*.spec.ts` (Playwright) | Real dev server, real GPU. |

If you're adding a new system to `src/game/systems/`, the default
expectation is a Vitest unit test that exercises it against a tiny ECS
world. If you're adding a new track / pickup / combat behavior, an e2e
test of the player-visible outcome is preferred over fine-grained mocks.

## Reporting bugs

Use the [bug template](.github/ISSUE_TEMPLATE/bug.yml). The repro section
matters — include the URL params you used (`?track=...&bike=...`,
`?edit=1`, `?room=...`, `?replay=...`), browser + OS, and the commit SHA
or Vercel preview URL.

## Security

See [`SECURITY.md`](SECURITY.md). Don't open public issues for security
problems.

## Code of conduct

Be kind and assume good faith. Disagreements are fine; personal attacks
aren't. The project owner has the final call on what crosses the line.

## License

By contributing you agree that your contribution is licensed under the
MIT License (see [`LICENSE`](LICENSE)).
