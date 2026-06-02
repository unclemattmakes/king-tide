/**
 * Cel/ink outline A/B (Part A) — sandbar.json has sky.outline enabled, so the
 * pipeline was built WITH the outline nodes. We toggle the live `setOutline`
 * mutator (0 = ink muted, 0.85 = full) at a FIXED idle camera, so the only
 * difference between the pair is the Sobel ink line. Captured at 2x DPR and
 * clipped to the bike + shoreline so the edge treatment is legible.
 */
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5191'
const OUT = 'test-results/profile'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ headless: false })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
await page.goto(`${BASE}/?race=1&track=sandbar&bike=racer`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__hover?.ready === true, null, { timeout: 30000 })
for (let i = 0; i < 8; i++) {
  const live = await page.evaluate(() => (window.__hover.race?.()?.raceTime ?? 0) > 1.2)
  if (live) break
  await page.keyboard.press('Space')
  await page.waitForTimeout(600)
}
await page.waitForFunction(() => (window.__hover.race?.()?.raceTime ?? 0) > 1.5, null, {
  timeout: 30000,
})
await page.waitForTimeout(2500)

const wired = await page.evaluate(async () => {
  const svc = await import('/src/engine/render/renderer-service.ts')
  const p = svc.getActivePostPipeline()
  window.__pp = p
  return { hasPipeline: !!p, hasSetOutline: typeof p?.setOutline === 'function' }
})
console.log('pipeline:', JSON.stringify(wired))

const clip = { x: 380, y: 240, width: 520, height: 360 } // CSS px; bike + shoreline
// OFF
await page.evaluate(() => window.__pp.setOutline(0))
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/outline-OFF.png`, clip })
// ON (default strength)
await page.evaluate(() => window.__pp.setOutline(0.85))
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/outline-ON.png`, clip })
// ON strong (to make the ink unmistakable / judge shimmer headroom)
await page.evaluate(() => window.__pp.setOutline(1.0))
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/outline-STRONG.png`, clip })
console.log('captured outline A/B')
await browser.close()
