/**
 * Visual A/B for the water mirror cull — proves the culled reflection still
 * reads right. Boots a race parked on the start line (stable framing, water
 * ahead), screenshots the culled mirror (shipped default), flips the live
 * `setReflectionFullScene(true)` debug toggle, lets the mirror's pipeline
 * variants compile, and screenshots the legacy full-scene mirror. Diff the
 * pair by eye: the only expected change is small dressing / props / bikes
 * disappearing from the REFLECTION (sky + terrain/landmark silhouettes
 * stay), never from the scene itself.
 *
 *   node tools/water-reflect-ab.mjs                    # sandbar
 *   TRACK=mexico-city node tools/water-reflect-ab.mjs
 *
 * Output: artifacts/water-perf/<track>-reflect-{culled,full}.png
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5464'
const TRACK = process.env.TRACK ?? 'sandbar'
const OUT_DIR = 'artifacts/water-perf'

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
  const port = new URL(base).port || '5464'
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

const server = await ensureServer(BASE)
const browser = await chromium.launch({ headless: false })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('hoverbike.waterDebug.v10')
    } catch {}
  })
  await page.goto(`${BASE}/?race=1&track=${TRACK}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__hover?.ready === true, null, { timeout: 60_000 })
  // Dismiss intro so the world is live, then PARK THE CAMERA low over open
  // water looking back at the track center — the start-line chase framing
  // is mostly beach, useless for judging reflections. Identical pose for
  // both shots; sky + island/landmarks mirror in the band ahead.
  for (let i = 0; i < 8; i++) {
    const live = await page.evaluate(() => (window.__hover.race?.()?.raceTime ?? 0) > 1.2)
    if (live) break
    await page.keyboard.press('Space')
    await page.waitForTimeout(600)
  }
  await page.evaluate(() => {
    window.__hover.setCameraPose({
      pos: { x: 170, y: 5, z: 140 },
      target: { x: 0, y: 14, z: 0 },
    })
  })
  await page.waitForTimeout(3500)

  await page.screenshot({ path: `${OUT_DIR}/${TRACK}-reflect-culled.png` })
  await page.evaluate(() => window.__hover.waterDebug()?.setReflectionFullScene(true))
  // First full-mirror frame compiles the newly mirror-visible material
  // variants — give it a beat so the capture isn't mid-hitch.
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${OUT_DIR}/${TRACK}-reflect-full.png` })
  await page.evaluate(() => window.__hover.waterDebug()?.setReflectionFullScene(false))
  await page.waitForTimeout(400)
  console.log(`[reflect-ab] wrote ${OUT_DIR}/${TRACK}-reflect-{culled,full}.png`)
} finally {
  await browser.close().catch(() => {})
  await server.stop().catch(() => {})
}
