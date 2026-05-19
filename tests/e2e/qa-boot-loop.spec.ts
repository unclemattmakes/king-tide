/**
 * QA — boot-loop regression probe.
 *
 * The 5 s matrix and 60 s soak both run a *single* boot. Neither catches
 * the class of regression where the **second** boot leaks something:
 *
 *  - Three.js WebGLRenderer / WebGPURenderer doubles its texture cache
 *    because dispose() never ran on tab navigation
 *  - AudioContext listeners pile up across goto() calls
 *  - Rapier WASM module re-initialises and leaks 200 KB of heap each time
 *  - Settings localStorage write races a second-tab open
 *
 * This spec navigates to `?autostart=1` five times in the same context,
 * asserts each boot succeeds, and asserts heap doesn't grow monotonically
 * across iterations. Gated on `QA_BOOT_LOOP=1` so plain `pnpm e2e` stays
 * fast — orchestrate this from `pnpm qa` when we wire it up there.
 */
import { waitForReady } from './helpers/boot'
import { expect, test } from './helpers/console-errors'

const ITERATIONS = parseInt(process.env.QA_BOOT_LOOP_ITERATIONS ?? '5', 10) || 5

/** Max heap growth ratio iteration[N] / iteration[1] before we fail.
 *  Three.js + Rapier pre-allocate a lot on first boot, so the early
 *  ratio is meaningless — we compare from iteration 1 forward. 2× is
 *  the loose floor; a real leak typically shows 3-10×. */
const HEAP_GROWTH_CEILING = 2.0

test.describe('QA boot loop', () => {
  test.skip(process.env.QA_BOOT_LOOP !== '1', 'gated on QA_BOOT_LOOP=1')

  test(`survives ${ITERATIONS} cold boots without console errors or heap drift`, async ({
    page,
    consoleErrors,
  }) => {
    test.setTimeout(ITERATIONS * 25_000 + 30_000)
    consoleErrors.allow(/^\[vite\]/)

    const heaps: number[] = []
    for (let i = 0; i < ITERATIONS; i++) {
      await page.goto('/?autostart=1')
      await waitForReady(page, { timeout: 20_000 })
      const heap = await page.evaluate(() => {
        // performance.memory is Chromium-only. Absent in Firefox / WebKit;
        // the gate below skips heap checks when we got zeroes.
        const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
        return m?.usedJSHeapSize ?? 0
      })
      heaps.push(heap)
      // biome-ignore lint/suspicious/noConsole: diagnostic for QA report
      console.log(`qa-boot-loop:iteration:${i + 1} heap=${heap}`)
    }

    // Position sanity on the final iteration — last boot still produced a
    // live bike.
    const player = await page.evaluate(() => window.__hover!.player())
    expect(player, 'final boot produced a player').not.toBeNull()

    // Heap drift gate. Only run when Chromium gave us numbers and we have
    // at least the iteration-1 baseline.
    const baseline = heaps[1] ?? heaps[0]
    const final = heaps[heaps.length - 1]
    if (baseline != null && final != null && baseline > 0 && final > 0) {
      const ratio = final / baseline
      // biome-ignore lint/suspicious/noConsole: diagnostic for QA report
      console.log(`qa-boot-loop:heap-ratio ${ratio.toFixed(2)} (final/baseline)`)
      expect(
        ratio,
        `heap grew ${ratio.toFixed(2)}× from iteration 1 to ${ITERATIONS} (limit ${HEAP_GROWTH_CEILING}×)`,
      ).toBeLessThan(HEAP_GROWTH_CEILING)
    }

    consoleErrors.assertNone()
  })
})
