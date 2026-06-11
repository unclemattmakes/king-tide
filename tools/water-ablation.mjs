/**
 * Water-layer frame-cost ablation (perf-measurement kit).
 *
 * Boots ONE live race (sandbar by default, full 8-bike field, autoplay,
 * 1280×720 to match docs/perf-baseline.md's dev rows) and measures frame-time
 * percentiles per WATER CONFIG by flipping the same `__hover.waterDebug()`
 * setters the tuning menu drives — settle, `perf.resetWindow()`, sample,
 * `perf.stats()`. Live-knob configs run in one page; structural variants
 * (`?hextile=0`, `?reflect=0` — the reflector pass re-renders the scene to a
 * half-res RT, the strength knob only fades the mix — and `?watersubs=<n>`
 * mesh density) each get their own boot.
 *
 * Reads the SAME surfaces as tools/profile-tracks.mjs (perf HUD ring +
 * renderer.info); a baseline repeat at the end of the live-knob page bounds
 * the drift the autoplay lap introduces. Headed real GPU, like every perf
 * harness in this repo.
 *
 * Usage:
 *   node tools/water-ablation.mjs                 # sandbar, port 5464
 *   TRACK=mexico-city node tools/water-ablation.mjs
 *   BASE=http://localhost:5191 node tools/water-ablation.mjs
 *
 * Output: markdown table to stdout + perf-report/water-ablation-<stamp>.md.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, hostname, platform, release } from 'node:os'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5464'
const TRACK = process.env.TRACK ?? 'sandbar'
const BIKE = process.env.BIKE ?? 'racer'
const HEADLESS = process.env.E2E_HEADLESS === '1'
const REPORT_DIR = 'perf-report'

const SETTLE_MS = 1200
const SAMPLE_MS = 5000
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
    console.log(`[ablate] reusing dev server at ${base}`)
    return { stop: async () => {} }
  }
  const port = new URL(base).port || '5464'
  console.log(`[ablate] starting \`pnpm dev --port ${port} --strictPort\` …`)
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

/** Boot a race page to the live-autoplay steady state. */
async function bootRacePage(browser, extra = '') {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  })
  // Stored water tuning would skew every row — measure constructor defaults.
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('hoverbike.waterDebug.v10')
    } catch {}
  })
  const url = `${BASE}/?race=1&track=${TRACK}&bike=${BIKE}&perf=1${extra}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__hover?.ready === true, null, { timeout: 45_000 })
  await page.waitForFunction(() => window.__hover?.perf != null, null, { timeout: 30_000 })
  await page.waitForFunction(() => window.__hover?.waterDebug?.() != null, null, {
    timeout: 30_000,
  })
  // Dismiss intro cards until the race clock advances; then autoplay.
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

/** Reset every live water knob to constructor defaults (in-page). */
const APPLY_BASELINE = `(() => {
  const wd = window.__hover.waterDebug()
  const d = wd.defaults
  wd.setSteepness(d.steepness); wd.setSwellScale(d.swellScale); wd.setChopScale(d.chopScale)
  wd.setTimeScale(d.timeScale); wd.setReflectionStrength(d.reflectionStrength)
  wd.setSunGlow(d.sunGlow); wd.setRoughBase(d.roughBase); wd.setRoughSparkle(d.roughSparkle)
  wd.setDetailStrength(d.detailStrength); wd.setBodyAbsorption(d.bodyAbsorption)
  wd.setSunDiscStrength(d.sunDiscStrength); wd.setSunStreakStrength(d.sunStreakStrength)
  wd.setStreakElongation(d.streakElongation); wd.setShoreWaveStrength(d.shoreWaveStrength)
  wd.setShoalSurf(d.shoalSurf); wd.setSplashRings(d.splashRings); wd.setContactFoam(d.contactFoam)
  wd.setPinchDirection(d.pinchDirection); wd.setWhitecapCurvature(d.whitecapCurvature)
  wd.setWhitecapLeadBias(d.whitecapLeadBias); wd.setFoamWarmth(d.foamWarmth)
  wd.setFoamStreak(d.foamStreak); wd.setFoamBrush(d.foamBrush); wd.setFoamWarp(d.foamWarp)
  wd.setLangmuir(d.langmuir); wd.setWakeStrength(d.wakeStrength)
  wd.setRampStrength(d.rampStrength); wd.setRampSteps(d.rampSteps)
  wd.setRampPosterize(d.rampPosterize); wd.setContourStrength(d.contourStrength)
  wd.setContourSpacing(d.contourSpacing); wd.setContourRelief(d.contourRelief)
  wd.setContourBreakup(d.contourBreakup); wd.setContourCoherence(d.contourCoherence)
  wd.setContourCalmAtRest(d.contourCalmAtRest); wd.setContourGate(d.contourGate)
  wd.setRiseStroke(d.riseStroke); wd.setWaterVisible(true)
  wd.setReflectionFullScene(false)
})()`

/** Live-knob configs — each applied on top of a fresh baseline. The `apply`
 *  strings run in-page against `wd = window.__hover.waterDebug()`. */
const LIVE_CONFIGS = [
  { label: 'baseline (all defaults)', apply: '' },
  { label: 'detail cascades off', apply: 'wd.setDetailStrength(0)' },
  { label: 'foam brush → discs', apply: 'wd.setFoamBrush(0)' },
  { label: 'foam streaks off', apply: 'wd.setFoamStreak(0)' },
  { label: 'rising strokes off', apply: 'wd.setRiseStroke(0)' },
  {
    label: 'readability off (ramp+contour)',
    apply: 'wd.setRampStrength(0); wd.setContourStrength(0)',
  },
  { label: 'whitecap foam off', apply: 'wd.setWhitecapCurvature(0)' },
  { label: 'contact foam off', apply: 'wd.setContactFoam(0)' },
  { label: 'bike wakes off', apply: 'wd.setWakeStrength(0)' },
  { label: 'splash rings off', apply: 'wd.setSplashRings(0)' },
  { label: 'langmuir off', apply: 'wd.setLangmuir(0)' },
  { label: 'sun disc+streak off', apply: 'wd.setSunDiscStrength(0); wd.setSunStreakStrength(0)' },
  { label: 'shore+shoal off', apply: 'wd.setShoreWaveStrength(0); wd.setShoalSurf(0)' },
  { label: 'reflection mix 0 (pass still on)', apply: 'wd.setReflectionStrength(0)' },
  {
    label: 'reflection FULL scene (legacy mirror)',
    apply: 'wd.setReflectionFullScene(true)',
  },
  {
    label: 'ALL knobs minimal',
    apply: [
      'wd.setDetailStrength(0)',
      'wd.setFoamBrush(0)',
      'wd.setFoamStreak(0)',
      'wd.setRiseStroke(0)',
      'wd.setRampStrength(0)',
      'wd.setContourStrength(0)',
      'wd.setWhitecapCurvature(0)',
      'wd.setContactFoam(0)',
      'wd.setWakeStrength(0)',
      'wd.setSplashRings(0)',
      'wd.setLangmuir(0)',
      'wd.setSunDiscStrength(0)',
      'wd.setSunStreakStrength(0)',
      'wd.setShoreWaveStrength(0)',
      'wd.setShoalSurf(0)',
      'wd.setReflectionStrength(0)',
    ].join('; '),
  },
  { label: 'WATER HIDDEN (whole stack)', apply: 'wd.setWaterVisible(false)' },
  { label: 'baseline repeat (drift check)', apply: '' },
]

/** Structural variants — separate boots. */
const BOOT_CONFIGS = [
  { label: 'hex-tiling off (?hextile=0)', extra: '&hextile=0' },
  { label: 'reflection PASS off (?reflect=0)', extra: '&reflect=0' },
  { label: 'mesh 512² (?watersubs=512)', extra: '&watersubs=512' },
  { label: 'mesh 384² (?watersubs=384)', extra: '&watersubs=384' },
]

async function sampleConfig(page, label, applyJs) {
  await page.evaluate(APPLY_BASELINE)
  if (applyJs) {
    await page.evaluate(`(() => { const wd = window.__hover.waterDebug(); ${applyJs} })()`)
  }
  await page.waitForTimeout(SETTLE_MS)
  await page.evaluate(() => window.__hover.perf.resetWindow())
  await page.waitForTimeout(SAMPLE_MS)
  const snap = await page.evaluate(() => ({
    perf: window.__hover.perf.stats(),
    render: window.__hover.perf.renderInfo(),
  }))
  return { label, perf: snap.perf, render: snap.render }
}

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
  lines.push(`# Water-layer ablation — \`${meta.track}\`, 8 bikes, ${meta.viewport}`)
  lines.push('')
  lines.push(`- **Date:** ${meta.date}`)
  lines.push(`- **Host:** ${meta.host} — ${meta.cpu}`)
  lines.push(`- **Backend:** ${meta.backend} (dev build — relative reads only)`)
  lines.push(`- **Window:** ${SETTLE_MS / 1000}s settle, ${SAMPLE_MS / 1000}s sample per config`)
  lines.push('')
  lines.push('| Config | FPS | p50 ms | Δp50 vs base | p95 ms | Draw calls | Triangles |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const r of rows) {
    if (r.error) {
      lines.push(`| ${r.label} | FAILED: ${r.error} | | | | | |`)
      continue
    }
    const p = r.perf ?? {}
    const d = r.render ?? {}
    const delta =
      basep50 != null && p.p50Ms != null && r.label !== 'baseline (all defaults)'
        ? `${(p.p50Ms - basep50).toFixed(2)}`
        : '—'
    lines.push(
      `| ${r.label} | ${fmt(p.fps)} | ${fmt(p.p50Ms, 2)} | ${delta} | ${fmt(p.p95Ms, 2)} | ${d.calls ?? '—'} | ${fmtTriangles(d.triangles)} |`,
    )
  }
  lines.push('')
  lines.push('_Negative Δp50 = the config is FASTER than baseline = that layer costs that much._')
  lines.push('')
  return lines.join('\n')
}

// ───────────────────────────────────────────────────────── main ──────────

const server = await ensureServer(BASE)
const browser = await chromium.launch({ headless: HEADLESS })
const rows = []
let backend = '?'
try {
  console.log(`[ablate] track=${TRACK} base=${BASE} — live-knob page …`)
  const page = await bootRacePage(browser)
  backend = await page.evaluate(() => window.__hover.backend())
  for (const cfg of LIVE_CONFIGS) {
    process.stdout.write(`[ablate]   ${cfg.label} … `)
    try {
      const row = await sampleConfig(page, cfg.label, cfg.apply)
      rows.push(row)
      console.log(`p50 ${fmt(row.perf?.p50Ms, 2)} ms`)
    } catch (e) {
      rows.push({ label: cfg.label, error: String(e).split('\n')[0] })
      console.log('FAIL')
    }
  }
  // Fill-bound probe: half-area viewport on the otherwise-default config.
  process.stdout.write('[ablate]   viewport 853×480 probe … ')
  try {
    await page.evaluate(APPLY_BASELINE)
    await page.setViewportSize({ width: 853, height: 480 })
    await page.waitForTimeout(SETTLE_MS)
    await page.evaluate(() => window.__hover.perf.resetWindow())
    await page.waitForTimeout(SAMPLE_MS)
    const snap = await page.evaluate(() => ({
      perf: window.__hover.perf.stats(),
      render: window.__hover.perf.renderInfo(),
    }))
    rows.push({ label: 'viewport 853×480 (fill probe)', perf: snap.perf, render: snap.render })
    console.log(`p50 ${fmt(snap.perf?.p50Ms, 2)} ms`)
    await page.setViewportSize({ width: 1280, height: 720 })
  } catch (e) {
    rows.push({ label: 'viewport 853×480 (fill probe)', error: String(e).split('\n')[0] })
    console.log('FAIL')
  }
  await page.close().catch(() => {})

  for (const cfg of BOOT_CONFIGS) {
    process.stdout.write(`[ablate] ${cfg.label} … `)
    try {
      const p2 = await bootRacePage(browser, cfg.extra)
      const row = await sampleConfig(p2, cfg.label, '')
      rows.push(row)
      console.log(`p50 ${fmt(row.perf?.p50Ms, 2)} ms`)
      await p2.close().catch(() => {})
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
const reportPath = `${REPORT_DIR}/water-ablation-${stamp}.md`
writeFileSync(reportPath, markdown)
console.log(`[ablate] wrote ${reportPath}`)
