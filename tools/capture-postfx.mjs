/**
 * Post-FX opt-in visual capture (Part A) — sandbar.json has sky.outline +
 * sky.motionBlur temporarily enabled. Captures:
 *   - postfx-stationary.png : idle bike → cel/ink outline reads on edges
 *   - postfx-moving-N.png   : autopilot at race speed → motion-blur smear
 * Watch for black/broken frames (PassNode RT pre-warm / velocity MRT bug).
 */
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5191'
const OUT = 'test-results/profile'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ headless: false })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e).split('\n')[0]))
page.on('console', (m) => {
  if (/error|black|fail|warn/i.test(m.text())) errs.push(m.text())
})

await page.goto(`${BASE}/?race=1&track=sandbar&bike=racer&gpuprofile=1`, {
  waitUntil: 'domcontentloaded',
})
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

// Stationary — outline reads against still edges.
const gpuStill = await page.evaluate(() => window.__gpuProfile)
await page.screenshot({ path: `${OUT}/postfx-stationary.png` })
console.log('stationary gpu:', JSON.stringify(gpuStill))

// Autopilot → race speed → motion blur.
await page.evaluate(() => {
  if (!window.__hover.isAutoPlay()) window.__hover.toggleAutoPlay()
})
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(1300)
  const s = await page.evaluate(() => +window.__hover.player().speed.toFixed(0))
  await page.screenshot({ path: `${OUT}/postfx-moving-${i}.png` })
  console.log(`moving-${i}: speed ${s} m/s`)
}
const gpuMoving = await page.evaluate(() => window.__gpuProfile)
console.log('moving gpu:', JSON.stringify(gpuMoving))
if (errs.length) console.log('ERRORS:', errs.slice(0, 8))
await browser.close()
