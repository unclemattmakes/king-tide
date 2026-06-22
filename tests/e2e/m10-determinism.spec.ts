/**
 * M10.2 — same-machine determinism probe.
 *
 * Boots the game twice in `?determinism=1` mode (which freezes the live
 * sim loop) and drives `simulateStep` from the test for a fixed number of
 * ticks with a fixed scripted intent. If two runs produce identical
 * snapshots, the sim is deterministic on this machine — clearing the
 * lockstep prerequisite.
 *
 * Cross-machine determinism is M10.3 — that test is meant to be run by
 * hand on two different machines comparing the printed snapshot. This
 * file only proves intra-machine.
 */
import { type Browser, expect, test } from '@playwright/test'

const SCRIPTED_INTENT = {
  throttle: 1,
  steer: 0.25,
  brake: 0,
  fire: false,
  boost: false,
  pitch: 0,
  trickLeft: false,
  trickRight: false,
}

const TICKS = 600 // 10 seconds at the 60Hz fixed step.

async function probe(browser: Browser): Promise<{ start: string; end: string }> {
  // Deliberately bypasses the `consoleErrors` fixture in
  // tests/e2e/helpers/console-errors.ts — that fixture binds to the
  // page Playwright injects via the test bindings, but this probe
  // spins up its own browser context per call so it can run two cold
  // boots in parallel. The minimal inline capture here is intentional;
  // don't migrate to the fixture without first refactoring `probe` to
  // accept a Page argument.
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  })

  await page.goto('/?determinism=1')
  await page.waitForFunction(() => window.__hover?.determinism?.ready === true, null, {
    timeout: 30000,
  })

  const start = await page.evaluate(() => window.__hover!.determinism!.snapshot())
  const end = await page.evaluate(
    ({ intent, ticks }) => window.__hover!.determinism!.run([intent], ticks),
    { intent: SCRIPTED_INTENT, ticks: TICKS },
  )

  expect(errors, errors.join('\n')).toEqual([])
  await ctx.close()
  return { start, end }
}

test.describe('M10.2 determinism', () => {
  // Physics-heavy probe needs a generous budget; default 30s isn't enough
  // for two cold boots + 600 ticks each.
  test.setTimeout(120_000)

  test('boot state is identical across two page loads', async ({ browser }) => {
    const a = await probe(browser)
    const b = await probe(browser)
    expect(a.start).toBe(b.start)
  })

  // Bit-identical across two cold boots on the SAME machine. This is the
  // intra-machine half of the determinism guarantee; the cross-PR / cross-branch
  // half is golden-compared in determinism-snapshot.spec.ts (the lagoon golden),
  // which the CI `determinism` job runs. Keep this assertion exact equality —
  // any tolerance here would mask the non-determinism this gate exists to catch.
  test('simulateStep is bit-identical for the same seed + same inputs', async ({ browser }) => {
    const a = await probe(browser)
    const b = await probe(browser)
    expect(a.end).toBe(b.end)
  })
})
