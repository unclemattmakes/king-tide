/**
 * Visual A/B for the shadow-caster size gate — proves what the gate actually
 * costs in look. Two boots of the same track (the gate is applied at track
 * load, so unlike the mirror cull there is no live toggle): the shipped
 * default (small dressing stops casting — shadow-caster-gate.ts) vs
 * `?shadowcast=0` (legacy cast-everything). Same parked camera poses both
 * times. Diff by eye: the only expected change is small props losing their
 * cast shadows — buildings / bridges / terrain / bikes keep theirs, and
 * nothing changes in the scene geometry itself.
 *
 *   node tools/shadow-gate-ab.mjs                    # sandbar
 *   TRACK=mexico-city node tools/shadow-gate-ab.mjs
 *
 * Also records each boot's `[shadow-gate] N/M …` console line so the capture
 * pairs carry their gated-caster counts.
 *
 * Output: artifacts/shadow-gate/<track>-{gated,legacy}-{chase,orbit}.png
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5469'
const TRACK = process.env.TRACK ?? 'sandbar'
const OUT_DIR = 'artifacts/shadow-gate'

mkdirSync(OUT_DIR, { recursive: true })

async function serverIsUp(base) {
  try {
    const res = await fetch(base, { method: 'GET' })
    return res.ok || res.status > 0
  } catch {
    return false
  }
}

async function ensureServer(base) {
  if (await serverIsUp(base)) return { stop: async () => {} }
  const port = new URL(base).port || '5469'
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
          } catch {}
        },
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('dev server did not come up')
}

/** Boot one variant, park the camera, take the pose shots. */
async function captureVariant(browser, label, extra) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  let gateLine = '(no [shadow-gate] line — gate off or nothing gated)'
  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('[shadow-gate]')) gateLine = t
  })
  await page.goto(`${BASE}/?race=1&track=${TRACK}${extra}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__hover?.ready === true, null, { timeout: 60_000 })
  for (let i = 0; i < 8; i++) {
    const live = await page.evaluate(() => (window.__hover.race?.()?.raceTime ?? 0) > 1.2)
    if (live) break
    await page.keyboard.press('Space')
    await page.waitForTimeout(600)
  }
  // Shot 1 — the default chase framing at the start line: bikes + nearby
  // dressing, shadows on the ground around the grid.
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${OUT_DIR}/${TRACK}-${label}-chase.png` })
  // Shot 2 — elevated three-quarter orbit over the start area, generic
  // enough to frame grounded dressing on any track.
  await page.evaluate(() => {
    window.__hover.setCameraPose({
      pos: { x: 34, y: 20, z: 34 },
      target: { x: 0, y: 2, z: 0 },
    })
  })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: `${OUT_DIR}/${TRACK}-${label}-orbit.png` })
  // Shots 3+4 — mid-lap chase frames under autoplay (the dressing lives
  // along the lap, not at the start line). Lap pacing is repeatable enough
  // per boot that the same wall-clock offsets frame comparable sections;
  // judge shadow PRESENCE, not pixel alignment.
  await page.evaluate(() => {
    window.__hover.setCameraPose(null)
    if (!window.__hover.isAutoPlay()) window.__hover.toggleAutoPlay()
  })
  await page.waitForTimeout(20_000)
  await page.screenshot({ path: `${OUT_DIR}/${TRACK}-${label}-lap20s.png` })
  await page.waitForTimeout(20_000)
  await page.screenshot({ path: `${OUT_DIR}/${TRACK}-${label}-lap40s.png` })
  await page.close().catch(() => {})
  return gateLine
}

const server = await ensureServer(BASE)
const browser = await chromium.launch({ headless: false })
try {
  const gated = await captureVariant(browser, 'gated', '')
  const legacy = await captureVariant(browser, 'legacy', '&shadowcast=0')
  console.log(`[shadow-ab] gated boot:  ${gated}`)
  console.log(`[shadow-ab] legacy boot: ${legacy}`)
  console.log(`[shadow-ab] wrote ${OUT_DIR}/${TRACK}-{gated,legacy}-{chase,orbit}.png`)
} finally {
  await browser.close().catch(() => {})
  await server.stop().catch(() => {})
}
