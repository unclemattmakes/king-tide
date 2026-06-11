/**
 * Desktop perf-profiling harness (Part of the perf-measurement kit).
 *
 * Drives the REAL app via headed Chromium (real GPU) over the three
 * art-complete tracks at the full 8-bike field, warms up, samples ~10 s of
 * live race, and writes a Markdown results table. This is the desktop-
 * automation piece of a larger perf kit; it does not own the on-device
 * (Deck / phone) measurement.
 *
 * What it captures per track (read from the page's live test surfaces — the
 * SAME ones the perf HUD and e2e specs use, never a parallel mechanism):
 *
 *   - render backend            ← `__hover.backend()`           (webgpu | webgl2)
 *   - mean fps + frame-time pcts ← `__hover.perf.stats()`        (fps, p50Ms, p95Ms, p99Ms, hitchCount)
 *   - draw calls + triangles     ← `__hover.perf.renderInfo()`   (renderer.info.render.calls / .triangles)
 *
 * Headed so Chromium uses the real GPU (matches playwright.config.ts's
 * rationale); Playwright's default launch flags also disable background-tab
 * throttling, so the rAF race loop runs full-speed even unfocused — unlike a
 * hidden Chrome tab, which Chrome pins to ~1 fps and makes every number bogus.
 * Set `E2E_HEADLESS=1` (same escape hatch as the e2e config) to force headless
 * — but note the headless software-GL fallback (SwiftShader) tanks shader work
 * to single-digit fps, so headless numbers are NOT representative.
 *
 * Server: if a dev server is already reachable at BASE it's reused; otherwise
 * this script starts `pnpm dev` on the BASE port (same command shape as
 * playwright.config.ts's webServer) and tears it down on exit.
 *
 * Usage:
 *   pnpm profile                                        # the 3 art-complete tracks, racer bike
 *   node tools/profile-tracks.mjs the-maw sandbar       # explicit ids (still 8-bike racer field)
 *   BASE=http://localhost:5191 node tools/profile-tracks.mjs   # reuse a running dev server
 *   BIKE=stunt node tools/profile-tracks.mjs            # override the bike variant
 *
 * Variants: append `#aa=off` to a track id to add the no-MSAA A/B
 * (e.g. `the-maw#aa=off`). The fragment is forwarded as an extra URL param.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, hostname, platform, release } from 'node:os'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5191'
const BIKE = process.env.BIKE ?? 'racer'
const HEADLESS = process.env.E2E_HEADLESS === '1'
const SCREENSHOT_DIR = 'test-results/profile'
const REPORT_DIR = 'perf-report'

// The art-complete tracks (Sandbar, The Maw). The rest of the catalog is
// greybox route-stubs awaiting the v2 art pass, so profiling them would
// measure unfinished scenes — skip by default. (South Beach Sunken left
// this list when its slot was rebuilt as the greybox-pending Mexico City
// Rising / Mexico City.)
const DEFAULT_TRACKS = ['sandbar', 'the-maw']

const args = process.argv.slice(2)
const TRACKS = args.length > 0 ? args : DEFAULT_TRACKS

// Warm up ~3 s (boot, countdown release, shader warm-up, AI settle) then
// sample a clean ~10 s stretch. The perf ring holds ~10 s @ 60 fps, so we
// reset the window after the warmup and read the whole ring at the end.
const WARMUP_MS = 3000
const SAMPLE_MS = 10_000

mkdirSync(SCREENSHOT_DIR, { recursive: true })
mkdirSync(REPORT_DIR, { recursive: true })

function parseSpec(spec) {
  const [id, frag] = spec.split('#')
  const extra = frag ? `&${frag}` : ''
  return { id, label: spec, extra }
}

/**
 * Probe BASE for a live dev server. Returns true if something answers.
 */
async function serverIsUp(base) {
  try {
    const res = await fetch(base, { method: 'GET' })
    // Any HTTP response (even a 404) means a server is listening.
    return res.ok || res.status > 0
  } catch {
    return false
  }
}

/**
 * Start `pnpm dev` on BASE's port (same command shape as the playwright
 * webServer block) and resolve once it answers. Returns a handle with a
 * `stop()` that kills the process tree. No-op fallback if a server is
 * already up.
 */
async function ensureServer(base) {
  if (await serverIsUp(base)) {
    console.log(`[profile] reusing dev server at ${base}`)
    return { stop: async () => {} }
  }
  const port = new URL(base).port || '5191'
  console.log(`[profile] no server at ${base}; starting \`pnpm dev --port ${port}\` …`)
  // detached so we can signal the whole process group on teardown — Vite
  // spawns child workers that otherwise outlive a bare child.kill().
  const child = spawn('pnpm', ['dev', '--port', port, '--strictPort'], {
    stdio: 'ignore',
    detached: true,
  })
  child.on('error', (e) => {
    console.error(`[profile] failed to spawn dev server: ${String(e)}`)
  })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await serverIsUp(base)) {
      console.log(`[profile] dev server is up at ${base}`)
      return {
        stop: async () => {
          try {
            // Negative pid → signal the process group (Vite + workers).
            process.kill(-child.pid, 'SIGTERM')
          } catch {
            try {
              child.kill('SIGTERM')
            } catch {}
          }
        },
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`dev server did not come up at ${base} within 60s`)
}

async function profileTrack(browser, spec) {
  const { id, label, extra } = parseSpec(spec)
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  })
  const log = []
  const events = []
  page.on('console', (m) => {
    const t = m.text()
    log.push(t)
    if (log.length > 40) log.shift()
  })
  page.on('pageerror', (e) => events.push(`pageerror: ${String(e).split('\n')[0]}`))
  page.on('crash', () => events.push('PAGE CRASHED (renderer/GPU process)'))
  page.on('close', () => events.push('page closed'))
  // ?race=1 boots straight into a live race (skips the cold-boot menu). With
  // no `?tt=1` the field defaults to player + NUM_AI (7) = 8 bikes — exactly
  // the field we want to measure; do NOT pass an aiCount override. ?perf=1
  // shows the HUD (harmless), and reading is done via __hover.perf regardless.
  const url = `${BASE}/?race=1&track=${id}&bike=${BIKE}&perf=1${extra}`
  const result = { label, url, ok: false }
  let phase = 'init'
  try {
    phase = 'goto'
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    // Wait for the debug API + perf recorder (perf attaches after the rAF
    // loop starts, which can race the `ready` flag — same gate as the e2e
    // helpers' waitForPerfReady).
    phase = 'wait-ready'
    await page.waitForFunction(() => window.__hover?.ready === true, null, { timeout: 30_000 })
    await page.waitForFunction(() => window.__hover?.perf != null, null, { timeout: 30_000 })
    const backend = await page.evaluate(() => window.__hover.backend())
    result.backend = backend

    // Skip the intro card(s): Space dismisses the intro, but Space is ALSO
    // the in-race `fire` bind — so only press it until the race clock starts
    // advancing, then stop (no stray weapon fire under the profiler).
    phase = 'skip-intro'
    for (let i = 0; i < 8; i++) {
      const live = await page.evaluate(() => (window.__hover.race?.()?.raceTime ?? 0) > 1.2)
      if (live) break
      await page.keyboard.press('Space')
      await page.waitForTimeout(600)
    }
    // Drive autoplay so the AI takes the player bike around the course —
    // gives a representative moving-camera load instead of a parked bike.
    phase = 'enable-autoplay'
    await page.evaluate(() => {
      if (!window.__hover.isAutoPlay()) window.__hover.toggleAutoPlay()
    })

    // Wait until the race clock is actually advancing (countdown released).
    phase = 'wait-live'
    await page.waitForFunction(
      () => {
        const r = window.__hover.race?.()
        return r && r.raceTime > 1.5
      },
      null,
      { timeout: 30_000 },
    )
    // Confirm time is genuinely moving (not a frozen frame) before sampling.
    phase = 'confirm-clock'
    const t0 = await page.evaluate(() => window.__hover.race().raceTime)
    await page.waitForTimeout(1000)
    const t1 = await page.evaluate(() => window.__hover.race().raceTime)
    result.clockAdvancing = t1 - t0 > 0.3

    // Warm up, then reset the CPU frame window and sample a clean stretch.
    phase = 'warmup'
    await page.waitForTimeout(WARMUP_MS)
    await page.evaluate(() => window.__hover.perf.resetWindow())
    phase = 'sample'
    await page.waitForTimeout(SAMPLE_MS)

    // Read the stats from the exact same surfaces the perf HUD draws from:
    //   perf.stats()      → fps / p50Ms / p95Ms / p99Ms / hitchCount / count
    //   perf.renderInfo() → renderer.info.render.calls / .triangles
    phase = 'snapshot'
    const snap = await page.evaluate(() => ({
      perf: window.__hover.perf.stats(),
      render: window.__hover.perf.renderInfo(),
      standings: window.__hover.standings?.()?.length ?? null,
    }))
    result.perf = snap.perf
    result.render = snap.render
    result.bikes = snap.standings
    phase = 'screenshot'
    await page
      .screenshot({ path: `${SCREENSHOT_DIR}/${label.replace(/[^a-z0-9-]/gi, '_')}.png` })
      .catch(() => {})
    result.ok = true
  } catch (e) {
    result.error = `[${phase}] ${String(e).split('\n')[0]}`
  } finally {
    result.events = events
    result.consoleTail = log.slice(-12)
    if (!page.isClosed()) await page.close().catch(() => {})
  }
  return result
}

/** Compact triangle counts: 1234 → "1.2k", 384000 → "384k", 1.2e6 → "1.2M". */
function fmtTriangles(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function fmt(n, digits = 1) {
  return n == null || !Number.isFinite(n) ? '—' : n.toFixed(digits)
}

/**
 * Render the results as a GitHub-flavoured Markdown document: a host/date
 * header followed by the metrics table. Returned as a string so we can both
 * print it and write it to disk.
 */
function renderMarkdown(results, meta) {
  const lines = []
  lines.push('# Hoverbike desktop perf profile')
  lines.push('')
  lines.push(`- **Date:** ${meta.date}`)
  lines.push(`- **Host:** ${meta.host}`)
  lines.push(`- **CPU:** ${meta.cpu}`)
  lines.push(`- **Field:** 8 bikes (player + 7 AI), bike \`${meta.bike}\``)
  lines.push(`- **Window:** ${meta.warmupMs / 1000}s warmup, ${meta.sampleMs / 1000}s sample`)
  if (meta.headless)
    lines.push('- **NOTE:** ran headless — software-GL fallback, numbers NOT representative')
  lines.push('')
  lines.push(
    '| Track | Backend | FPS | p50 ms | p95 ms | p99 ms | Hitches | Draw calls | Triangles |',
  )
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const r of results) {
    if (!r.ok) {
      // Keep failed tracks in the table so a partial run is still legible;
      // backend may have been read before the failure, otherwise '?'.
      lines.push(
        `| ${r.label} | ${r.backend ?? '?'} | FAILED: ${r.error ?? 'unknown'} | | | | | | |`,
      )
      continue
    }
    const p = r.perf ?? {}
    const d = r.render ?? {}
    lines.push(
      `| ${r.label} | ${r.backend ?? '?'} | ${fmt(p.fps)} | ${fmt(p.p50Ms, 2)} | ${fmt(p.p95Ms, 2)} | ${fmt(p.p99Ms, 2)} | ${p.hitchCount ?? '—'} | ${d.calls ?? '—'} | ${fmtTriangles(d.triangles)} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

// ───────────────────────────────────────────────────────── main ──────────

const server = await ensureServer(BASE)
const browser = await chromium.launch({ headless: HEADLESS })
console.log(`[profile] base=${BASE} bike=${BIKE} headless=${HEADLESS} tracks=${TRACKS.join(', ')}`)
const results = []
try {
  for (const spec of TRACKS) {
    process.stdout.write(`[profile] ${spec} … `)
    const r = await profileTrack(browser, spec)
    results.push(r)
    console.log(r.ok ? 'ok' : `FAIL (${r.error})`)
  }
} finally {
  await browser.close().catch(() => {})
  await server.stop().catch(() => {})
}

const cpuModel = cpus()[0]?.model?.trim() ?? 'unknown'
const meta = {
  date: new Date().toISOString(),
  host: `${platform()} ${release()} (${hostname()})`,
  cpu: `${cpuModel} × ${cpus().length}`,
  bike: BIKE,
  warmupMs: WARMUP_MS,
  sampleMs: SAMPLE_MS,
  headless: HEADLESS,
}
const markdown = renderMarkdown(results, meta)

// Print the table to stdout …
console.log(`\n${markdown}`)

// … and write it to perf-report/perf-<ISO-timestamp>.md (colons are not
// path-safe on every fs, so swap them out of the timestamp).
const stamp = meta.date.replace(/[:.]/g, '-')
const reportPath = `${REPORT_DIR}/perf-${stamp}.md`
writeFileSync(reportPath, markdown)
console.log(`\n[profile] wrote ${reportPath}`)
console.log(`[profile] screenshots: ${SCREENSHOT_DIR}`)

// Non-zero exit if any track failed, so CI / wrappers can detect a bad run.
const anyFailed = results.some((r) => !r.ok)
process.exitCode = anyFailed ? 1 : 0
