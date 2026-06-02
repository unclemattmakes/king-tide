/**
 * Foliage-sway visual A/B (Part A) — headed real-WebGPU capture.
 *
 * Idles the player bike at the sandbar start line (no autoplay → stable
 * chase camera, shoreline palms in frame) and captures the SAME view with
 * the shared wind uniform at strength 0 (rigid) vs cranked (bent). Only the
 * foliage changes between frames, so the pair is an unambiguous proof that
 * the TSL positionNode sway is live under WebGPU — and that every palm bends
 * in lockstep (per-vertex COLOR_0.b phase is 0 across the shared geometry).
 *
 *   node tools/capture-sway.mjs            # → test-results/profile/sway-*.png
 */
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5191'
const OUT = 'test-results/profile'
const WIND = Number(process.env.WIND ?? 8)
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ headless: false })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.log('pageerror:', String(e).split('\n')[0]))

await page.goto(`${BASE}/?race=1&track=sandbar&bike=racer`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__hover?.ready === true, null, { timeout: 30000 })

// Skip intros to the live race; do NOT enable autoplay (idle = stable cam).
for (let i = 0; i < 8; i++) {
  const live = await page.evaluate(() => (window.__hover.race?.()?.raceTime ?? 0) > 1.2)
  if (live) break
  await page.keyboard.press('Space')
  await page.waitForTimeout(600)
}
await page.waitForFunction(() => (window.__hover.race?.()?.raceTime ?? 0) > 1.5, null, {
  timeout: 30000,
})
await page.waitForTimeout(2500) // let the grid settle + bike come to rest

// Grab the live foliage-sway singleton (same module instance Vite serves the app).
const swayInfo = await page.evaluate(async () => {
  const m = await import('/src/engine/render/foliage-sway.ts')
  window.__fsway = m
  return m.debugSwayState()
})
console.log('sway state (default):', swayInfo)

// 1) Rigid baseline — wind 0.
await page.evaluate(() => window.__fsway.updateWind({ x: 1, z: 0.2 }, 0, 1.4))
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}/sway-0-rigid.png` })

// 2) Cranked wind — capture a few frames to catch a bend extreme. The shared
//    sway clock keeps advancing (race is live) so successive frames sit at
//    different sin() phases; one of them lands near a peak.
await page.evaluate((w) => window.__fsway.updateWind({ x: 1, z: 0.2 }, w, 1.4), WIND)
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(550) // ~quarter period at freq 1.4
  await page.screenshot({ path: `${OUT}/sway-1-bent-${i}.png` })
}

// Restore default wind so the module is left as shipped.
await page.evaluate(() => window.__fsway.updateWind({ x: 1, z: 0.2 }, 0.18, 1.4))
console.log('captured:', OUT)
await browser.close()
