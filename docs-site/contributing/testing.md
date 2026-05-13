# Testing

| Layer | Tool | Lives in | Runs in CI? |
|---|---|---|---|
| Unit (sim, codecs, loaders) | Vitest | `tests/unit/` | yes (`pnpm test`) |
| End-to-end (real Vite + GPU) | Playwright | `tests/e2e/` | yes (informational — allowed to fail) |
| Asset pipeline | Blender headless | `pnpm gen:all` in `asset-pipeline.yml` | only on `specs/**` and `tools/blender/**` changes |

## Unit tests — sim layer

The unit suite runs **without a browser** and **without Three.js**. It
tests pure sim modules: physics-free math, wire codecs, parsers,
ECS-only systems.

Pattern:

```ts
import { describe, it, expect } from 'vitest'
import { encodeInputFrameInto, decodeInputFrameFrom } from '../../src/engine/net/input-frame'

describe('input-frame', () => {
  it('round-trips a frame', () => {
    const view = new DataView(new ArrayBuffer(11))
    encodeInputFrameInto(view, 0, { tick: 42, peerId: 1, /* … */ })
    const out = decodeInputFrameFrom(view, 0)
    expect(out.tick).toBe(42)
  })
})
```

If your file imports Three.js, it can't live in the unit suite. That's
usually a smell — extract the pure piece into a sim module and test
that.

## End-to-end tests — real game

Playwright opens a real dev server and a real browser. They're
slow-ish, GPU-dependent, and the source of truth for "does the game
actually work."

Pattern: drive the game through the same `__hover.*` debug API the
manual playtest uses, then assert observable state.

```ts
test('player crosses the first gate after boost', async ({ page }) => {
  await page.goto('/?track=lagoon&autoplay=1')
  await page.waitForFunction(() => globalThis.__hover?.ready === true)
  // ...
})
```

E2E tests are **informational in CI right now** — they're allowed to
fail. Run them locally before submitting if your change could affect
sim, physics, race, or netcode:

```bash
pnpm e2e:install   # one-time
pnpm e2e
```

The first run pulls a few hundred MB of Chromium. Subsequent runs
re-use it.

## When to add a test

| Change | Test |
|---|---|
| New ECS system in `src/game/systems/` | Vitest unit test against a tiny world. |
| New wire format or codec | Vitest round-trip + bounds test. |
| New gameplay rule (race, combat, pickup) | E2E test of the player-visible outcome. |
| New menu screen | Manual play through is OK; e2e if the flow is gating something else. |
| New render-only effect | Manual screenshot. Don't unit-test particles. |
| Bug fix | Regression test (unit if the bug is in sim; e2e if it's player-visible). |

## What CI runs

See [`.github/workflows/ci.yml`](https://github.com/occ-matt/hoverbike/blob/main/.github/workflows/ci.yml).
On every PR:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm docs:build` (separate job)
- `pnpm e2e` (separate job, informational)

The asset pipeline workflow runs separately, only on PRs that touch
`specs/**` or `tools/blender/**`.
