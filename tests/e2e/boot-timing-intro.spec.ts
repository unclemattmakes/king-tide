/**
 * Intro-path boot-timing diagnostic — the sibling of `boot-timing.spec.ts` for
 * the path that gates the single-player loading screen. That spec boots
 * `?skipintro=1`, where scenery is deferred and streams in at concurrency 1
 * during racing; here the cinematic plays, so scenery is NOT deferred
 * (race-boot.ts `deferScenery` keys on introMode) and the whole dressed scene
 * compiles inside the boot pre-warm, under the loader. `totalMs` IS the
 * loading screen the player waits out. Use this to A/B content-side
 * material/pipeline-group changes on a dressed track:
 *
 *   E2E_PORT=5397 BOOT_TRACK=mexico-city pnpm e2e tests/e2e/boot-timing-intro.spec.ts
 *
 * Measurement harness, not a pass/fail gate — same warm-up-then-median-of-runs
 * shape as boot-timing.spec.ts. Key stats: `vinylMaterials` (distinct vinyl
 * twins built — the pre-warm compiles ~one pipeline per twin), plus
 * `deferredScenery`/`warmGroups` on any path that still defers.
 */
import { expect, test } from '@playwright/test'

type BootTrace = {
  totalMs: number
  phases: { label: string; sinceStartMs: number; deltaMs: number }[]
  stats: Record<string, number>
}

const TRACK = process.env.BOOT_TRACK ?? 'mexico-city'
const RUNS = Math.max(1, Number(process.env.BOOT_RUNS ?? 3))

/** Boot settled: ready, AND — when a deferred warm exists (future paths /
 *  `?skipintro`-style boots) — its `scenery` phase has landed, so the trace
 *  we read covers the full warm either way. */
function bootSettled(): boolean {
  const w = window as unknown as {
    __bootTrace?: BootTrace
    __hover?: { ready?: boolean }
  }
  if (w.__hover?.ready !== true) return false
  const t = w.__bootTrace
  if (!t) return false
  const deferred = (t.stats.deferredScenery ?? 0) > 0
  return !deferred || t.phases.some((p) => p.label === 'scenery')
}

function readTrace(): BootTrace | null {
  return (window as unknown as { __bootTrace?: BootTrace }).__bootTrace ?? null
}

test.describe('boot timing (intro path)', () => {
  test(`${TRACK}: loader breakdown with the cinematic on (median of ${RUNS})`, async ({ page }) => {
    test.setTimeout(120_000 + RUNS * 120_000)
    // No `skipintro` — the cinematic (and its undeferred whole-scene warm) is
    // the path under measurement.
    const url = `/?autostart=1&track=${TRACK}`

    // Warm-up navigation pays Vite's first-request transform cost.
    await page.goto(url)
    await page.waitForFunction(bootSettled, undefined, { timeout: 110_000 })

    const traces: BootTrace[] = []
    for (let i = 0; i < RUNS; i++) {
      await page.reload()
      await page.waitForFunction(bootSettled, undefined, { timeout: 110_000 })
      const trace = await page.evaluate(readTrace)
      expect(trace, '__bootTrace published').not.toBeNull()
      if (trace) {
        traces.push(trace)
        const prewarm = trace.phases.find((p) => p.label === 'prewarm')?.deltaMs ?? 0
        console.log(`run ${i + 1}: total ${trace.totalMs}ms · prewarm ${prewarm}ms`)
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
      `\n=== ${TRACK} intro-path boot: median ${medianTotal}ms over ${RUNS} runs ===\n${medianPhases
        .map((p) => `  ${p.label.padEnd(14)} ${p.deltaMs}ms`)
        .join('\n')}\nstats: ${JSON.stringify(traces[traces.length - 1]?.stats ?? {})}`,
    )

    expect(traces.length).toBe(RUNS)
    expect(medianTotal).toBeGreaterThan(0)
  })
})
