/**
 * Hitch profiler — a measurement harness, not a pass/fail gate. Records every
 * rAF frame delta from the moment boot completes through the first ~26 s of
 * the live race: the window where the progressive scenery warm
 * (progressive-warm.ts) reveals deferred meshes and the running loop compiles
 * each on first sight. Runs the same boot twice — default vs ?progwarm=0
 * (full upfront warm) — so deferred-compile hitches are isolated by A/B.
 *
 *   E2E_PORT=5407 pnpm e2e tests/e2e/hitch-profile.spec.ts
 *   HITCH_TRACK=texcoco-rising E2E_PORT=5407 pnpm e2e tests/e2e/hitch-profile.spec.ts
 *
 * Prints a per-second worst-frame table per case and writes the raw samples
 * to artifacts/hitch/ (test-results/ is wiped per run; artifacts/ survives).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { waitForPerfReady } from './helpers/boot'

const TRACK = process.env.HITCH_TRACK ?? 'sandbar'
const WINDOW_MS = 32_000

type HitchRec = {
  start: number
  /** Frame-to-frame rAF deltas, ms. */
  dts: number[]
  /** Sample timestamps relative to recorder start, ms. */
  ts: number[]
  /** [t, renderer.info.textures, renderer.info.geometries] every 15th frame. */
  tex: [number, number, number][]
  /** When the boot trace gained its 'scenery' mark (reveal finished), or null. */
  sceneryAtMs: number | null
  /** First sample time where race().raceTime > 0 — the green light. */
  greenAtMs: number | null
  done: boolean
}

type BootTraceLite = {
  totalMs: number
  phases: { label: string; sinceStartMs: number; deltaMs: number }[]
  stats: Record<string, number>
} | null

function installRecorder(windowMs: number): void {
  const w = window as unknown as {
    __hitchRec?: HitchRec
    __bootTrace?: { phases: { label: string }[] }
    __hover?: {
      perf?: { renderInfo(): { textures: number; geometries: number } }
      race?: () => { raceTime: number } | null
    }
  }
  const rec: HitchRec = {
    start: performance.now(),
    dts: [],
    ts: [],
    tex: [],
    sceneryAtMs: null,
    greenAtMs: null,
    done: false,
  }
  w.__hitchRec = rec
  let last = rec.start
  let n = 0
  const tick = (now: number): void => {
    rec.dts.push(now - last)
    rec.ts.push(now - rec.start)
    last = now
    n++
    if (rec.sceneryAtMs === null) {
      const phases = w.__bootTrace?.phases
      if (phases?.some((p) => p.label === 'scenery')) rec.sceneryAtMs = now - rec.start
    }
    if (rec.greenAtMs === null) {
      try {
        const race = w.__hover?.race?.()
        if (race && race.raceTime > 0) rec.greenAtMs = now - rec.start
      } catch {
        /* race snapshot not ready */
      }
    }
    if (n % 15 === 0) {
      try {
        const info = w.__hover?.perf?.renderInfo()
        if (info) rec.tex.push([now - rec.start, info.textures, info.geometries])
      } catch {
        /* perf API not ready — skip the sample */
      }
    }
    if (now - rec.start < windowMs) requestAnimationFrame(tick)
    else rec.done = true
  }
  requestAnimationFrame(tick)
}

function summarize(label: string, rec: HitchRec, trace: BootTraceLite): void {
  const { dts, ts } = rec
  const over = (ms: number): number => dts.filter((d) => d > ms).length
  const stallMs = dts.filter((d) => d > 50).reduce((a, b) => a + b, 0)
  let worst = 0
  let worstAt = 0
  for (let i = 0; i < dts.length; i++) {
    const d = dts[i] ?? 0
    if (d > worst) {
      worst = d
      worstAt = ts[i] ?? 0
    }
  }
  // Per-second worst frame + count of >50 ms frames in that second.
  const secs = Math.ceil(WINDOW_MS / 1000)
  const rows: string[] = []
  for (let s = 0; s < secs; s++) {
    let w = 0
    let c = 0
    for (let i = 0; i < dts.length; i++) {
      const t = ts[i] ?? 0
      if (t >= s * 1000 && t < (s + 1) * 1000) {
        const d = dts[i] ?? 0
        if (d > w) w = d
        if (d > 50) c++
      }
    }
    if (w > 25) rows.push(`  s${String(s).padStart(2, '0')}  worst ${w.toFixed(0)}ms  >50ms×${c}`)
  }
  const deferred = trace?.stats?.deferredScenery ?? 0
  // Post-green split — the frames that land during actual racing.
  const green = rec.greenAtMs
  let postGreen50 = 0
  let postGreenWorst = 0
  if (green !== null) {
    for (let i = 0; i < dts.length; i++) {
      if ((ts[i] ?? 0) >= green) {
        const d = dts[i] ?? 0
        if (d > 50) postGreen50++
        if (d > postGreenWorst) postGreenWorst = d
      }
    }
  }
  console.log(
    `\n=== ${label} ===\n` +
      `frames ${dts.length} over ${((ts[ts.length - 1] ?? 0) / 1000).toFixed(1)}s · ` +
      `>33ms×${over(33.4)} · >50ms×${over(50)} · >100ms×${over(100)} · >250ms×${over(250)}\n` +
      `stall(Σ frames>50ms) ${(stallMs / 1000).toFixed(2)}s · worst ${worst.toFixed(0)}ms @ ${(worstAt / 1000).toFixed(1)}s\n` +
      `sceneryRevealDone ${rec.sceneryAtMs === null ? 'n/a' : `${(rec.sceneryAtMs / 1000).toFixed(1)}s`} · deferredScenery ${deferred}\n` +
      `greenLight ${green === null ? 'n/a' : `${(green / 1000).toFixed(1)}s`}` +
      (green === null
        ? ''
        : ` · post-green >50ms×${postGreen50} · post-green worst ${postGreenWorst.toFixed(0)}ms`) +
      `\n` +
      (rows.length ? `${rows.join('\n')}` : '  (no second with a frame >25ms)'),
  )
}

test.describe('hitch profile', () => {
  test(`${TRACK}: race-start frame deltas, default vs progwarm=0`, async ({ page }) => {
    test.setTimeout(300_000)
    mkdirSync('artifacts/hitch', { recursive: true })

    // 'intro' cases run the real flow (full race intro + countdown before the
    // green light) — that's the window the progressive warm is meant to hide
    // in. The skipintro case is the worst case: warm overlapping live racing.
    const cases: Array<{ label: string; query: string }> = [
      { label: 'default-intro', query: '' },
      { label: 'default-skipintro', query: '&skipintro=1' },
      { label: 'progwarm-off-intro', query: '&progwarm=0' },
    ]

    for (const c of cases) {
      await page.goto(`/?autostart=1&track=${TRACK}${c.query}`)
      // Headed Chromium throttles rAF for unfocused windows — keep it front.
      await page.bringToFront()
      await waitForPerfReady(page, { timeout: 90_000 })
      await page.evaluate(installRecorder, WINDOW_MS)
      await page.waitForFunction(
        () => (window as unknown as { __hitchRec?: HitchRec }).__hitchRec?.done === true,
        null,
        { timeout: WINDOW_MS + 30_000 },
      )
      const rec = await page.evaluate(
        () => (window as unknown as { __hitchRec?: HitchRec }).__hitchRec ?? null,
      )
      const trace = await page.evaluate(
        () => (window as unknown as { __bootTrace?: BootTraceLite }).__bootTrace ?? null,
      )
      expect(rec, `${c.label}: recorder ran`).not.toBeNull()
      if (!rec) continue
      summarize(`${TRACK} · ${c.label}`, rec, trace)
      writeFileSync(
        `artifacts/hitch/${TRACK}-${c.label}.json`,
        JSON.stringify({ track: TRACK, case: c.label, rec, trace }, null, 1),
      )
      // The recorder must have seen a real run, not a throttled background tab.
      expect(rec.dts.length, `${c.label}: enough frames recorded`).toBeGreaterThan(200)
    }
  })
})
