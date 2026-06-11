/**
 * Production-build benchmark runner (perf-measurement kit).
 *
 * Drives the PRODUCTION-SAFE `?bench=1` benchmark director (the same path a
 * phone / Deck uses against the deployed build) with headed Chromium on the
 * real GPU, and scrapes each results panel's Markdown row. This exists
 * because `pnpm profile` reads `__hover.perf`, which is hard-gated to
 * dev/test builds — a minified `vite build` has no `__hover`, so the bench
 * director's own recorder + on-panel row is the only measurement surface.
 *
 * The build is NOT run here — building is CPU-heavy and would contaminate
 * any measurement running alongside. Build first, then measure:
 *
 *   pnpm build
 *   node tools/bench-prod.mjs                 # serves dist via `pnpm preview`
 *   BASE=http://localhost:4173 node tools/bench-prod.mjs   # reuse a server
 *   node tools/bench-prod.mjs sandbar mexico-city          # explicit tracks
 *
 * Output: markdown table to stdout + perf-report/bench-prod-<stamp>.md +
 * results-panel screenshots in test-results/bench/. Row columns match
 * `benchMarkdownRow` (src/boot/benchmark-mode.ts) and the perf-baseline.md
 * tables: | track | backend | fps | p50 | p95 | p99 | hitches | draws | tris |
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, hostname, platform, release } from 'node:os'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5467'
const BIKE = process.env.BIKE ?? 'racer'
const HEADLESS = process.env.E2E_HEADLESS === '1'
const REPORT_DIR = 'perf-report'
const SCREENSHOT_DIR = 'test-results/bench'

// Keep in sync with BENCH_TRACKS (src/boot/benchmark-mode.ts) — the shipped/
// dressed tracks that perf passes target.
const DEFAULT_TRACKS = ['sandbar', 'the-maw', 'mexico-city']
const TRACKS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_TRACKS

// Boot + 3 s warmup + 10 s measure, with headroom for the prod pipeline
// compile on first paint.
const PANEL_TIMEOUT_MS = 120_000

mkdirSync(REPORT_DIR, { recursive: true })
mkdirSync(SCREENSHOT_DIR, { recursive: true })

async function serverIsUp(base) {
  try {
    const res = await fetch(base, { method: 'GET' })
    return res.ok || res.status > 0
  } catch {
    return false
  }
}

/** Reuse a server at BASE, else serve the existing dist/ via `pnpm preview`. */
async function ensureServer(base) {
  if (await serverIsUp(base)) {
    console.log(`[bench-prod] reusing server at ${base}`)
    return { stop: async () => {} }
  }
  const port = new URL(base).port || '5467'
  console.log(`[bench-prod] starting \`pnpm preview --port ${port} --strictPort\` …`)
  const isWin = process.platform === 'win32'
  const child = spawn('pnpm', ['preview', '--port', port, '--strictPort'], {
    stdio: 'ignore',
    detached: !isWin,
    shell: isWin,
  })
  child.on('error', (e) => {
    console.error(`[bench-prod] failed to spawn preview server: ${String(e)}`)
  })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await serverIsUp(base)) {
      return {
        stop: async () => {
          if (isWin) {
            try {
              spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
            } catch {}
            return
          }
          try {
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
  throw new Error(
    `no server came up at ${base} within 30s — did you run \`pnpm build\` first? ` +
      '(`pnpm preview` serves dist/, it does not build)',
  )
}

async function benchTrack(browser, spec) {
  // `track#extra` forwards extra URL params, same shape as profile-tracks
  // (e.g. `sandbar#progwarm=0` benches with the scenery stream pre-compiled
  // under the loading screen — the steady-state row vs the default's
  // honest first-lap-stream row).
  const [trackId, frag] = spec.split('#')
  const extra = frag ? `&${frag}` : ''
  // 1280×720 @ dsf 1 to match the dev rows in docs/perf-baseline.md.
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  })
  const result = { trackId: spec, ok: false }
  try {
    const url = `${BASE}/?bench=1&track=${trackId}&bike=${BIKE}${extra}`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    // `?bench=1` implies skip-intro + forced autoplay (race-boot.ts), so the
    // page drives itself; we just wait for the results panel.
    await page.waitForSelector('#bench-results', { timeout: PANEL_TIMEOUT_MS })
    // The panel's mdBox holds the exact `benchMarkdownRow` string.
    const row = await page.evaluate(() => {
      const divs = Array.from(document.querySelectorAll('#bench-results div'))
      const box = divs.find((d) => (d.textContent ?? '').trim().startsWith('| '))
      return box ? box.textContent.trim() : null
    })
    if (!row) throw new Error('results panel mounted but no markdown row found')
    // The panel row's first cell is the bare track id — relabel it with the
    // full spec so `sandbar` and `sandbar#progwarm=0` stay distinguishable.
    result.row = frag ? row.replace(`| ${trackId} |`, `| ${spec} |`) : row
    await page
      .screenshot({ path: `${SCREENSHOT_DIR}/${spec.replace(/[^a-z0-9-]/gi, '_')}.png` })
      .catch(() => {})
    result.ok = true
  } catch (e) {
    result.error = String(e).split('\n')[0]
  } finally {
    if (!page.isClosed()) await page.close().catch(() => {})
  }
  return result
}

// ───────────────────────────────────────────────────────── main ──────────

const server = await ensureServer(BASE)
const browser = await chromium.launch({ headless: HEADLESS })
console.log(
  `[bench-prod] base=${BASE} bike=${BIKE} headless=${HEADLESS} tracks=${TRACKS.join(', ')}`,
)
const results = []
try {
  for (const id of TRACKS) {
    process.stdout.write(`[bench-prod] ${id} … `)
    const r = await benchTrack(browser, id)
    results.push(r)
    console.log(r.ok ? 'ok' : `FAIL (${r.error})`)
  }
} finally {
  await browser.close().catch(() => {})
  await server.stop().catch(() => {})
}

const meta = {
  date: new Date().toISOString(),
  host: `${platform()} ${release()} (${hostname()})`,
  cpu: `${cpus()[0]?.model?.trim() ?? 'unknown'} × ${cpus().length}`,
}
const lines = []
lines.push('# Hoverbike production-build benchmark (`?bench=1` panel rows)')
lines.push('')
lines.push(`- **Date:** ${meta.date}`)
lines.push(`- **Host:** ${meta.host}`)
lines.push(`- **CPU:** ${meta.cpu}`)
lines.push(`- **Build:** production (\`pnpm build\` + \`pnpm preview\`), 1280×720, 8-bike autoplay`)
if (HEADLESS)
  lines.push('- **NOTE:** ran headless — software-GL fallback, numbers NOT representative')
lines.push('')
lines.push(
  '| Track | Backend | FPS | p50 ms | p95 ms | p99 ms | Hitches | Draw calls | Triangles |',
)
lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
for (const r of results) {
  lines.push(r.ok ? r.row : `| ${r.trackId} | ? | FAILED: ${r.error ?? 'unknown'} | | | | | | |`)
}
lines.push('')
const markdown = lines.join('\n')
console.log(`\n${markdown}`)
const stamp = meta.date.replace(/[:.]/g, '-')
const reportPath = `${REPORT_DIR}/bench-prod-${stamp}.md`
writeFileSync(reportPath, markdown)
console.log(`[bench-prod] wrote ${reportPath}`)
console.log(`[bench-prod] screenshots: ${SCREENSHOT_DIR}`)

process.exitCode = results.some((r) => !r.ok) ? 1 : 0
