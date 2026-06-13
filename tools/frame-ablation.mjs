/**
 * Whole-frame cost ablation (perf-measurement kit).
 *
 * The water-ablation kit answered "which WATER layer costs what" and traced
 * the June-10 regression to the reflection pass. This kit answers the next
 * question: **what is the rest of the frame made of?** — the sandbar iGPU
 * run still shows ~13.4 ms p50 with the water hidden entirely.
 *
 * Same harness shape as tools/water-ablation.mjs (one 8-bike autoplay race,
 * `__hover.perf` ring per config, headed real GPU), but the axes are
 * STRUCTURAL — most need their own boot because they configure the renderer
 * / scene / post chain at creation time:
 *
 *   ?shadows=0       shadow maps fully off (renderer.shadowMap.enabled)
 *   ?shadowmap=512   sun shadow-map resolution (default 1024)
 *   ?post=0          no post pipeline at all (bloom included) — setBloom(0)
 *                    only mutes the mix, the pass still renders, so a real
 *                    bloom-off row must skip the pipeline at build time
 *   ?aa=off          no MSAA (existing flag; ~2.1 ms GPU on the old RTX row)
 *   ?reflect=0       no planar-reflection pass (existing flag, post-cull)
 *   ?ai=5            6-bike field (player + 5) — the design-targets §6 hedge
 *
 * plus one LIVE row on the baseline page: scenery hidden
 * (`__hover.scenery.setVisible(false)` — env GLB dressing + placed props),
 * which bounds "everything the vinyl/props scene adds" the way
 * `setWaterVisible(false)` bounds the water stack.
 *
 * NOT here: a "vinyl brush off" row. The brush dials are uniforms — zeroing
 * them keeps every triplanar texture sample in the shader, so the row would
 * read ≈0 even where the real fragment cost is large (the same trap as
 * reflection *strength* vs the reflection *pass*). The scenery-hidden row is
 * the honest upper bound; splitting cost INSIDE the vinyl shader needs a
 * compile-time variant and belongs to the structural-sharing work.
 *
 * Every boot carries `?gpuprofile=1` (when the adapter has timestamp-query)
 * so each row records GPU-pass ms next to the CPU frame stats — the CPU/GPU
 * attribution the water kit couldn't see. `GPU=0` env drops the flag.
 *
 * Usage:
 *   node tools/frame-ablation.mjs                  # sandbar, port 5468
 *   TRACK=mexico-city node tools/frame-ablation.mjs
 *   BASE=http://localhost:5191 node tools/frame-ablation.mjs
 *
 * Output: markdown to stdout + perf-report/frame-ablation-<stamp>.md.
 * Caveats shared with the water kit: 5 s windows alias the autoplay lap
 * (the baseline-repeat row bounds the drift) and p50 quantizes at vsync —
 * read FPS + p95 + GPU ms + draws together, not p50 alone.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, hostname, platform, release } from 'node:os'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5468'
const TRACK = process.env.TRACK ?? 'sandbar'
const BIKE = process.env.BIKE ?? 'racer'
const HEADLESS = process.env.E2E_HEADLESS === '1'
const GPU_FLAG = process.env.GPU === '0' ? '' : '&gpuprofile=1'
// Extra URL params appended to EVERY boot (e.g. EXTRA="&progwarm=0" to
// pre-compile the scenery stream under the loading screen — without it,
// mexico-city's stream drains DURING the run and later rows read faster
// than earlier ones regardless of their axis: row-order bias).
const EXTRA = process.env.EXTRA ?? ''
const REPORT_DIR = 'perf-report'

// Window sizes are env-tunable: mexico-city's draw count swings ~340→460
// with lap section, so 5 s windows alias the lap (±1 vsync quantum on p50).
// SAMPLE=15000 spans enough of the lap to settle close A/Bs.
const SETTLE_MS = Number(process.env.SETTLE ?? 1200)
const SAMPLE_MS = Number(process.env.SAMPLE ?? 5000)
const WARMUP_MS = 3000

mkdirSync(REPORT_DIR, { recursive: true })

async function serverIsUp(base) {
  try {
    const res = await fetch(base, { method: 'GET' })
    return res.ok || res.status > 0
  } catch {
    return false
  }
}

async function ensureServer(base) {
  if (await serverIsUp(base)) {
    console.log(`[frame-ablate] reusing dev server at ${base}`)
    return { stop: async () => {} }
  }
  const port = new URL(base).port || '5468'
  console.log(`[frame-ablate] starting \`pnpm dev --port ${port} --strictPort\` …`)
  const isWin = process.platform === 'win32'
  const child = spawn('pnpm', ['dev', '--port', port, '--strictPort'], {
    stdio: 'ignore',
    detached: !isWin,
    shell: isWin,
  })
  const deadline = Date.now() + 60_000
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
  throw new Error(`dev server did not come up at ${BASE} within 60s`)
}

/** Boot a race page to the live-autoplay steady state (same gates as the
 *  water kit: ready → perf → intro skipped → autoplay → clock advancing). */
async function bootRacePage(browser, extra = '') {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  })
  // Stored water tuning would skew rows — measure constructor defaults.
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('hoverbike.waterDebug.v10')
    } catch {}
  })
  const url = `${BASE}/?race=1&track=${TRACK}&bike=${BIKE}&perf=1${GPU_FLAG}${EXTRA}${extra}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__hover?.ready === true, null, { timeout: 45_000 })
  await page.waitForFunction(() => window.__hover?.perf != null, null, { timeout: 30_000 })
  for (let i = 0; i < 8; i++) {
    const live = await page.evaluate(() => (window.__hover.race?.()?.raceTime ?? 0) > 1.2)
    if (live) break
    await page.keyboard.press('Space')
    await page.waitForTimeout(600)
  }
  await page.evaluate(() => {
    if (!window.__hover.isAutoPlay()) window.__hover.toggleAutoPlay()
  })
  await page.waitForFunction(() => (window.__hover.race?.()?.raceTime ?? 0) > 1.5, null, {
    timeout: 30_000,
  })
  await page.waitForTimeout(WARMUP_MS)
  return page
}

async function sampleConfig(page, label, applyJs) {
  if (applyJs) await page.evaluate(applyJs)
  await page.waitForTimeout(SETTLE_MS)
  await page.evaluate(() => window.__hover.perf.resetWindow())
  await page.waitForTimeout(SAMPLE_MS)
  const snap = await page.evaluate(() => ({
    perf: window.__hover.perf.stats(),
    render: window.__hover.perf.renderInfo(),
    gpuMs: window.__gpuProfile?.renderMs ?? null,
  }))
  return { label, perf: snap.perf, render: snap.render, gpuMs: snap.gpuMs }
}

/** Boot-level structural variants. Each gets a fresh page. */
const BOOT_CONFIGS = [
  { label: 'baseline (all defaults)', extra: '' },
  { label: 'shadow gate off (?shadowcast=0)', extra: '&shadowcast=0' },
  { label: 'shadows off (?shadows=0)', extra: '&shadows=0' },
  { label: 'shadow map 512² (?shadowmap=512)', extra: '&shadowmap=512' },
  { label: 'post/bloom off (?post=0)', extra: '&post=0' },
  { label: 'MSAA off (?aa=off)', extra: '&aa=off' },
  { label: 'reflection pass off (?reflect=0)', extra: '&reflect=0' },
  { label: '6-bike field (?ai=5)', extra: '&ai=5' },
  {
    label: 'floor (shadows+post+aa+reflect off)',
    extra: '&shadows=0&post=0&aa=off&reflect=0',
  },
]

// ONLY="baseline,shadow gate off,shadows off" runs just those boot rows
// (label-prefix match) — the cheap way to re-run a close A/B with longer
// windows without paying the whole table.
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map((s) => s.trim()) : null
const bootConfigs = ONLY
  ? BOOT_CONFIGS.filter((c) => ONLY.some((p) => c.label.startsWith(p)))
  : BOOT_CONFIGS

function fmt(n, digits = 1) {
  return n == null || !Number.isFinite(n) ? '—' : n.toFixed(digits)
}
function fmtTriangles(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function renderMarkdown(rows, meta) {
  const base = rows.find((r) => r.label.startsWith('baseline (all defaults)'))
  const basep50 = base?.perf?.p50Ms
  const lines = []
  lines.push(`# Whole-frame ablation — \`${meta.track}\`, 8 bikes, ${meta.viewport}`)
  lines.push('')
  lines.push(`- **Date:** ${meta.date}`)
  lines.push(`- **Host:** ${meta.host} — ${meta.cpu}`)
  lines.push(`- **Backend:** ${meta.backend} (dev build — relative reads only)`)
  if (EXTRA) lines.push(`- **Extra params on every boot:** \`${EXTRA}\``)
  lines.push(
    `- **Window:** ${SETTLE_MS / 1000}s settle, ${SAMPLE_MS / 1000}s sample per config; GPU ms = rolling render-pass avg (\`?gpuprofile=1\`)`,
  )
  lines.push('')
  lines.push('| Config | FPS | p50 ms | Δp50 vs base | p95 ms | GPU ms | Draw calls | Triangles |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const r of rows) {
    if (r.error) {
      lines.push(`| ${r.label} | FAILED: ${r.error} | | | | | | |`)
      continue
    }
    const p = r.perf ?? {}
    const d = r.render ?? {}
    const delta =
      basep50 != null && p.p50Ms != null && r.label !== 'baseline (all defaults)'
        ? `${(p.p50Ms - basep50).toFixed(2)}`
        : '—'
    lines.push(
      `| ${r.label} | ${fmt(p.fps)} | ${fmt(p.p50Ms, 2)} | ${delta} | ${fmt(p.p95Ms, 2)} | ${fmt(r.gpuMs, 2)} | ${d.calls ?? '—'} | ${fmtTriangles(d.triangles)} |`,
    )
  }
  lines.push('')
  lines.push('_Negative Δp50 = the config is FASTER than baseline = that axis costs that much._')
  lines.push('')
  return lines.join('\n')
}

// ───────────────────────────────────────────────────────── main ──────────

const server = await ensureServer(BASE)
const browser = await chromium.launch({ headless: HEADLESS })
const rows = []
let backend = '?'
try {
  for (const cfg of bootConfigs) {
    process.stdout.write(`[frame-ablate] ${cfg.label} … `)
    try {
      const page = await bootRacePage(browser, cfg.extra)
      if (backend === '?') backend = await page.evaluate(() => window.__hover.backend())
      const row = await sampleConfig(page, cfg.label, '')
      rows.push(row)
      console.log(`p50 ${fmt(row.perf?.p50Ms, 2)} ms · gpu ${fmt(row.gpuMs, 2)} ms`)

      // On the baseline page, also take the LIVE scenery-hidden row + a
      // baseline repeat (drift bound) before closing it.
      if (cfg.label.startsWith('baseline')) {
        process.stdout.write('[frame-ablate] scenery hidden (live) … ')
        const hasHook = await page.evaluate(() => window.__hover.scenery?.() != null)
        if (hasHook) {
          const hidden = await sampleConfig(
            page,
            'scenery hidden (env dressing + props)',
            'window.__hover.scenery().setVisible(false)',
          )
          rows.push(hidden)
          console.log(`p50 ${fmt(hidden.perf?.p50Ms, 2)} ms`)
          await page.evaluate('window.__hover.scenery().setVisible(true)')
          const repeat = await sampleConfig(page, 'baseline repeat (drift check)', '')
          rows.push(repeat)
        } else {
          rows.push({
            label: 'scenery hidden (env dressing + props)',
            error: '__hover.scenery hook missing in this build',
          })
          console.log('SKIP (no hook)')
        }
      }
      await page.close().catch(() => {})
    } catch (e) {
      rows.push({ label: cfg.label, error: String(e).split('\n')[0] })
      console.log('FAIL')
    }
  }
} finally {
  await browser.close().catch(() => {})
  await server.stop().catch(() => {})
}

const meta = {
  date: new Date().toISOString(),
  host: `${platform()} ${release()} (${hostname()})`,
  cpu: `${cpus()[0]?.model?.trim() ?? 'unknown'} × ${cpus().length}`,
  track: TRACK,
  viewport: '1280×720',
  backend,
}
const markdown = renderMarkdown(rows, meta)
console.log(`\n${markdown}`)
const stamp = meta.date.replace(/[:.]/g, '-')
const reportPath = `${REPORT_DIR}/frame-ablation-${stamp}.md`
writeFileSync(reportPath, markdown)
console.log(`[frame-ablate] wrote ${reportPath}`)
