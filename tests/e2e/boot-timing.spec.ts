/**
 * Boot-timing diagnostic — a measurement harness, not a pass/fail gate. Boots a
 * dressed track and dumps `window.__bootTrace` (the per-phase load breakdown
 * from `src/boot/boot-trace.ts`) so a load-time regression has hard numbers.
 * Drive it headed on the real GPU:
 *
 *   E2E_PORT=5393 BOOT_TRACK=sandbar pnpm e2e tests/e2e/boot-timing.spec.ts
 *
 * The first navigation warms Vite's on-demand transform (a dev-only cost, not
 * representative of prod); each subsequent reload recompiles shaders + re-fetches
 * (browser-cached) assets fresh — the production-shaped load. We report the
 * median of BOOT_RUNS reloads so a single noisy boot doesn't mislead.
 */
import { expect, test } from '@playwright/test'
import { waitForReady } from './helpers/boot'

type BootTrace = {
  totalMs: number
  phases: { label: string; sinceStartMs: number; deltaMs: number }[]
  stats: Record<string, number>
}

const TRACK = process.env.BOOT_TRACK ?? 'sandbar'
const RUNS = Math.max(1, Number(process.env.BOOT_RUNS ?? 3))

function readTrace(): BootTrace | null {
  return (window as unknown as { __bootTrace?: BootTrace }).__bootTrace ?? null
}

test.describe('boot timing', () => {
  test(`${TRACK}: per-phase load breakdown (median of ${RUNS})`, async ({ page }) => {
    test.setTimeout(180_000)
    const url = `/?autostart=1&track=${TRACK}&skipintro=1`

    // Warm-up navigation — pays Vite's first-request transform so it doesn't
    // pollute the measured runs.
    await page.goto(url)
    await waitForReady(page, { timeout: 60_000 })

    const traces: BootTrace[] = []
    for (let i = 0; i < RUNS; i++) {
      await page.reload()
      await waitForReady(page, { timeout: 60_000 })
      const trace = await page.evaluate(readTrace)
      expect(trace, '__bootTrace published before ready').not.toBeNull()
      if (trace) {
        traces.push(trace)
        console.log(`run ${i + 1}: total ${trace.totalMs}ms`)
      }
    }

    const median = (xs: number[]): number =>
      xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
    const labels = traces[0]?.phases.map((p) => p.label) ?? []
    const medianPhases = labels
      .map((label) => ({
        label,
        deltaMs: median(traces.map((t) => t.phases.find((p) => p.label === label)?.deltaMs ?? 0)),
      }))
      .sort((a, b) => b.deltaMs - a.deltaMs)
    const medianTotal = median(traces.map((t) => t.totalMs))

    console.log(
      `\n=== ${TRACK} boot: median ${medianTotal}ms over ${RUNS} runs ===\n${medianPhases
        .map((p) => `  ${p.label.padEnd(14)} ${p.deltaMs}ms`)
        .join('\n')}\nstats: ${JSON.stringify(traces[traces.length - 1]?.stats ?? {})}`,
    )

    expect(traces.length).toBe(RUNS)
    expect(medianTotal).toBeGreaterThan(0)
  })
})
