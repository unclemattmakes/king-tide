/**
 * Fresh-load (cold-boot menu) timing diagnostic — measures the path a player
 * actually hits when they open the app with no URL params:
 *
 *   loading screen → manifest → menu paints (CSS) → attract-mode race boots
 *   in the background → first attract frame promotes the live backdrop.
 *
 * Captures, per run:
 *   - menuInteractiveMs: loading screen hidden (menu DOM is up + clickable
 *     in principle)
 *   - attractLiveMs: body.attract-live set (first attract frame rendered)
 *   - longTasks: main-thread tasks > 50 ms between nav start and attract-live
 *     (the "menu is frozen" evidence — clicks/hover do nothing during these)
 *
 * Like boot-timing.spec.ts: first navigation warms Vite's transform, then we
 * report the median of MENU_RUNS reloads.
 *
 *   E2E_PORT=5423 pnpm e2e tests/e2e/menu-boot-timing.spec.ts
 */
import { expect, test } from '@playwright/test'

const RUNS = Math.max(1, Number(process.env.MENU_RUNS ?? 3))

type MenuTrace = {
  menuInteractiveMs: number
  attractLiveMs: number
  longTasks: { startMs: number; durMs: number }[]
}

test.describe('menu fresh-load timing', () => {
  test(`cold-boot menu: time-to-interactive + attract freeze profile (median of ${RUNS})`, async ({
    page,
  }) => {
    test.setTimeout(600_000)

    // Arm the long-task observer before any app code runs — registered ONCE
    // (init scripts re-run on every navigation; registering per-run stacks
    // duplicate observers and double-counts every task).
    await page.addInitScript(() => {
      const w = window as unknown as {
        __menuProbe?: { longTasks: { startMs: number; durMs: number }[] }
      }
      w.__menuProbe = { longTasks: [] }
      try {
        const obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            w.__menuProbe?.longTasks.push({
              startMs: Math.round(e.startTime),
              durMs: Math.round(e.duration),
            })
          }
        })
        obs.observe({ entryTypes: ['longtask'] })
      } catch {
        /* longtask unsupported — leave empty */
      }
    })

    // Warm-up navigation — pays Vite's first-request transform.
    await page.goto('/')
    await page.waitForFunction(() => document.body.classList.contains('attract-live'), null, {
      timeout: 240_000,
    })

    const traces: MenuTrace[] = []
    for (let i = 0; i < RUNS; i++) {
      // Park on about:blank between runs so the PREVIOUS page's teardown
      // (WebGPU device + buffers) finishes before the measured navigation —
      // reloading over a live attract page contends with its destruction in
      // the same renderer process and shows up as a multi-second main-thread
      // blob at the start of the new page, which is a measurement artifact
      // of back-to-back reloads, not the player-facing fresh-load path.
      await page.goto('about:blank')
      await page.waitForTimeout(2_000)
      await page.goto('/')

      // Menu interactive = loading screen hidden.
      await page.waitForFunction(
        () => document.getElementById('loading-screen')?.classList.contains('loading-hidden'),
        null,
        { timeout: 120_000 },
      )
      const menuInteractiveMs = await page.evaluate(() => Math.round(performance.now()))

      // Attract backdrop live = first background-race frame rendered.
      await page.waitForFunction(() => document.body.classList.contains('attract-live'), null, {
        timeout: 240_000,
      })
      const attractLiveMs = await page.evaluate(() => Math.round(performance.now()))

      const longTasks = await page.evaluate(() => {
        const w = window as unknown as {
          __menuProbe?: { longTasks: { startMs: number; durMs: number }[] }
        }
        return (w.__menuProbe?.longTasks ?? []).filter((t) => t.durMs >= 50)
      })
      traces.push({ menuInteractiveMs, attractLiveMs, longTasks })
      const freezeTotal = longTasks.reduce((s, t) => s + t.durMs, 0)
      const worst = longTasks.reduce((m, t) => Math.max(m, t.durMs), 0)
      console.log(
        `run ${i + 1}: menu ${menuInteractiveMs}ms · attract-live ${attractLiveMs}ms · ` +
          `${longTasks.length} long tasks (worst ${worst}ms, total frozen ${freezeTotal}ms)`,
      )
      console.log(
        `  long tasks: ${longTasks.map((t) => `@${t.startMs}ms+${t.durMs}ms`).join(' · ')}`,
      )
    }

    const median = (xs: number[]): number =>
      xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
    console.log(
      `\n=== menu fresh-load: median over ${RUNS} runs ===\n` +
        `  menu interactive ${median(traces.map((t) => t.menuInteractiveMs))}ms\n` +
        `  attract live     ${median(traces.map((t) => t.attractLiveMs))}ms\n` +
        `  worst long task  ${median(traces.map((t) => t.longTasks.reduce((m, x) => Math.max(m, x.durMs), 0)))}ms\n` +
        `  frozen total     ${median(traces.map((t) => t.longTasks.reduce((s, x) => s + x.durMs, 0)))}ms`,
    )
    expect(traces.length).toBe(RUNS)
  })
})
