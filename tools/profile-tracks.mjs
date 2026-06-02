/**
 * Headed-Chromium real-WebGPU profiling harness (Part B of the rendering
 * follow-up task). Drives each track to a live 8-bike autoplay race at 1080p
 * and captures, after a settle window:
 *
 *   - GPU-time profiler (`window.__gpuProfile`): render / compute ms
 *   - CPU frame recorder (`__hover.perf.stats()`): fps, p95Ms, p99Ms
 *   - draw-call telemetry (`__hover.perf.renderInfo()`): calls, triangles
 *   - backend + foliage-sway clock advance (sanity)
 *   - a PNG screenshot per run (real GPU, no headless software fallback)
 *
 * Headed so Chromium uses the real GPU (matches playwright.config.ts's
 * rationale); Playwright's default launch flags also disable background-tab
 * throttling, so the rAF race loop runs full-speed even unfocused — unlike a
 * hidden Chrome tab, which Chrome pins to ~1fps and makes every number bogus.
 *
 * Usage:
 *   node tools/profile-tracks.mjs                       # default track set
 *   node tools/profile-tracks.mjs the-maw sandbar       # explicit ids
 *   BASE=http://localhost:5191 node tools/profile-tracks.mjs
 *
 * Reads an already-running dev server (default :5191). Variants: append
 * `#aa=off` to a track id to add the no-MSAA A/B (e.g. `the-maw#aa=off`).
 */
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5191'
const OUT = 'test-results/profile'
const DEFAULT_TRACKS = ['sandbar', 'the-maw', 'liberty-drowned', 'kilauea-crown', 'the-maw#aa=off']
const args = process.argv.slice(2)
const TRACKS = args.length > 0 ? args : DEFAULT_TRACKS
const SAMPLE_MS = 8000
const SETTLE_MS = 4000

mkdirSync(OUT, { recursive: true })

function parseSpec(spec) {
  const [id, frag] = spec.split('#')
  const extra = frag ? `&${frag}` : ''
  return { id, label: spec, extra }
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
  const url = `${BASE}/?race=1&track=${id}&bike=racer&gpuprofile=1&perf=1${extra}`
  const result = { label, url, ok: false }
  let phase = 'init'
  try {
    phase = 'goto'
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    phase = 'wait-ready'
    await page.waitForFunction(() => window.__hover?.ready === true, null, { timeout: 30000 })
    const backend = await page.evaluate(() => window.__hover.backend?.() ?? window.__hover.backend)
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
      { timeout: 30000 },
    )
    // A second confirmation that time is moving (not a frozen frame).
    phase = 'confirm-clock'
    const t0 = await page.evaluate(() => window.__hover.race().raceTime)
    await page.waitForTimeout(1200)
    const t1 = await page.evaluate(() => window.__hover.race().raceTime)
    result.clockAdvancing = t1 - t0 > 0.5
    result.fps = await page.evaluate(() => window.__hover.fps?.() ?? null)

    // Settle, then reset the CPU window and sample a clean stretch.
    phase = 'settle'
    await page.waitForTimeout(SETTLE_MS)
    await page.evaluate(() => window.__hover.perf.resetWindow())
    phase = 'sample'
    await page.waitForTimeout(SAMPLE_MS)

    phase = 'snapshot'
    const snap = await page.evaluate(() => {
      const perf = window.__hover.perf
      const sway = (() => {
        // climb to the live scene via an __fx mesh and count foliage
        let mesh = null
        for (const k of Object.keys(window.__fx || {})) {
          const v = window.__fx[k]
          if (v && v.isObject3D) {
            mesh = v
            break
          }
          if (v && v.mesh && v.mesh.isObject3D) {
            mesh = v.mesh
            break
          }
          if (v && v.points && v.points.isObject3D) {
            mesh = v.points
            break
          }
        }
        let root = mesh
        let hops = 0
        while (root && root.parent && hops < 50) {
          root = root.parent
          hops++
        }
        const SWAYED = Symbol.for('hoverbike.foliageSwayNodeSwayed')
        let meshes = 0,
          instanced = 0,
          foliageSwayed = 0
        if (root && root.traverse) {
          root.traverse((o) => {
            if (!o.isMesh) return
            meshes++
            if (o.isInstancedMesh) instanced += o.count
            const mats = Array.isArray(o.material) ? o.material : [o.material]
            for (const m of mats)
              if (m && m.userData && m.userData[SWAYED]) {
                foliageSwayed++
                break
              }
          })
        }
        return { meshes, instancedSlots: instanced, foliageSwayed }
      })()
      // FX / particle active counts — to attribute draw calls (a per-sprite
      // particle pool can dominate `render.calls` while costing ~no GPU time).
      const fxStats = {}
      try {
        for (const k of Object.keys(window.__fx || {})) {
          const v = window.__fx[k]
          const s = v && (v.stats || v.activeCount || v.count)
          if (typeof s === 'number') fxStats[k] = s
          else if (s && typeof s === 'object')
            fxStats[k] = s.active ?? s.count ?? s.live ?? JSON.stringify(s).slice(0, 40)
        }
      } catch {}
      const particleStats = window.__particles?.stats ?? null
      return {
        gpu: window.__gpuProfile,
        perf: perf.stats(),
        render: perf.renderInfo(),
        scene: sway,
        fx: fxStats,
        particles: particleStats,
        standings: window.__hover.standings?.()?.length ?? null,
      }
    })
    result.gpu = snap.gpu
    result.perf = snap.perf
    result.render = snap.render
    result.scene = snap.scene
    result.fx = snap.fx
    result.particles = snap.particles
    result.standings = snap.standings
    phase = 'screenshot'
    await page.screenshot({ path: `${OUT}/${label.replace(/[^a-z0-9-]/gi, '_')}.png` })
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

const browser = await chromium.launch({ headless: false })
console.log(`[profile] base=${BASE} tracks=${TRACKS.join(', ')}`)
const results = []
for (const spec of TRACKS) {
  process.stdout.write(`[profile] ${spec} … `)
  const r = await profileTrack(browser, spec)
  results.push(r)
  console.log(r.ok ? 'ok' : `FAIL (${r.error})`)
}
await browser.close()

console.log('\n===== PROFILE RESULTS =====')
for (const r of results) {
  console.log(`\n# ${r.label}   [${r.backend ?? '?'}]   ${r.ok ? '' : 'FAILED: ' + r.error}`)
  if (!r.ok) {
    if (r.events?.length) console.log('  events:', r.events)
    if (r.consoleTail?.length) console.log('  console tail:', r.consoleTail)
    continue
  }
  const g = r.gpu || {}
  const p = r.perf || {}
  const d = r.render || {}
  console.log(
    `  GPU render: ${(g.renderMs ?? 0).toFixed(2)} ms  (last ${(g.lastRenderMs ?? 0).toFixed(2)}, n=${g.samples ?? 0})  compute: ${(g.computeMs ?? 0).toFixed(2)} ms`,
  )
  console.log(
    `  CPU  fps:   ${(p.fps ?? 0).toFixed(1)}   p95 ${(p.p95Ms ?? 0).toFixed(2)} ms   p99 ${(p.p99Ms ?? 0).toFixed(2)} ms   n=${p.count ?? 0}`,
  )
  console.log(
    `  DRAW calls: ${d.calls ?? '?'}   tri ${((d.triangles ?? 0) / 1e6).toFixed(2)}M   geo ${d.geometries ?? '?'}   tex ${d.textures ?? '?'}`,
  )
  console.log(
    `  scene:      meshes ${r.scene?.meshes ?? '?'}  instancedSlots ${r.scene?.instancedSlots ?? '?'}  foliageSwayed ${r.scene?.foliageSwayed ?? '?'}  bikes ${r.standings ?? '?'}`,
  )
  if (r.fx && Object.keys(r.fx).length) console.log(`  fx:         ${JSON.stringify(r.fx)}`)
  if (r.particles) console.log(`  particles:  ${JSON.stringify(r.particles)}`)
  console.log(`  clock advancing: ${r.clockAdvancing}   fps@live ${r.fps?.toFixed?.(1) ?? r.fps}`)
}
console.log('\nScreenshots:', OUT)
// Emit machine-readable JSON too.
console.log('\n===JSON===')
console.log(JSON.stringify(results))
