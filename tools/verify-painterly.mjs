/**
 * Headed (real-GPU) verification for the painterly + style-as-legibility work.
 *
 * Drives the SAME functions the new dev-menu entries call (via Vite-served
 * dynamic import in page context), in the RACE scene where the runtime vinyl
 * materials are applied + registered with the live brush-tuning service:
 *   - A1 illustrative lighting  → setVinylBrush({ illum, rimEmissive, rimColor })
 *   - A2 scene grade            → getActivePostPipeline().setGrade(...)
 *   - A3 crest sub-surface glow → getWaterMesh().debug.setCrestSSS(1)
 *   - B1/B5 rim signals         → setSignalsEnabled(true)
 * Plus a dev-palette screenshot showing the new entries. Inspect the PNGs by eye
 * (byte-diffing compressed PNGs is meaningless); the console-error count is the
 * one hard gate. NOTE: ?propviewer is NOT wired to the live brush tuner (it has
 * its own per-prop sliders), so illum/rim must be exercised in-race, as here.
 *
 * Start your OWN dev server first (hard rule 2 — never the in-app preview):
 *   pnpm dev --port 5219 --strictPort
 *   BASE=http://localhost:5219 node tools/verify-painterly.mjs
 */
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5219'
const OUT = 'artifacts/painterly'
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ headless: false })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).split('\n')[0]))
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` })

await page.goto(`${BASE}/?race=1&track=sandbar&bike=racer`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__hover?.ready === true, null, { timeout: 30000 })
for (let i = 0; i < 10; i++) {
  if (await page.evaluate(() => (window.__hover.race?.()?.raceTime ?? 0) > 1.5)) break
  await page.keyboard.press('Space')
  await page.waitForTimeout(600)
}
// Settle to a near-static frame: respawn, let the chase cam ease in, freeze water.
await page.keyboard.press('Backspace')
await page.waitForTimeout(1800)
await page.evaluate(async () => {
  const m = await import('/src/engine/render/water-service.ts')
  m.getWaterMesh()?.debug?.setTimeScale?.(0)
})
await page.waitForTimeout(600)
await shot('01-baseline')

// A1 — illustrative warp + additive rim (cyan so it reads unmistakably in the gate).
await page.evaluate(async () => {
  const m = await import('/src/engine/render/brush-tuning-service.ts')
  m.setVinylBrush({ illum: 1, rimEmissive: 1.4, rimColorR: 0, rimColorG: 1, rimColorB: 1 })
})
await page.waitForTimeout(700)
await shot('02-illum-rim')
await page.evaluate(async () => {
  const m = await import('/src/engine/render/brush-tuning-service.ts')
  m.setVinylBrush({ illum: 0, rimEmissive: 0 })
})

// A2 — muted scene grade (the contrast budget).
await page.evaluate(async () => {
  const m = await import('/src/engine/render/renderer-service.ts')
  m.getActivePostPipeline()?.setGrade({ saturation: 0.6, contrast: 0.9, exposure: 0.95 })
})
await page.waitForTimeout(700)
await shot('03-grade')
await page.evaluate(async () => {
  const m = await import('/src/engine/render/renderer-service.ts')
  m.getActivePostPipeline()?.setGrade({ saturation: 1, contrast: 1, exposure: 1, temperature: 0 })
})

// A3 — crest SSS (needs live water; unfreeze).
await page.evaluate(async () => {
  const m = await import('/src/engine/render/water-service.ts')
  m.getWaterMesh()?.debug?.setTimeScale?.(1)
  m.getWaterMesh()?.debug?.setCrestSSS?.(1)
})
await page.waitForTimeout(900)
await shot('04-crest-sss')

// B1/B5 — signals master flag on (the charge ladder needs a drifting bike to show).
await page.evaluate(async () => {
  const m = await import('/src/engine/render/signal-state.ts')
  m.setSignalsEnabled(true)
})
await page.waitForTimeout(3500)
await shot('05-signals')

// Dev palette shows the new entries.
await page.keyboard.press('Control+k')
await page.waitForTimeout(400)
await page.keyboard.type('signal')
await page.waitForTimeout(400)
await shot('06-palette')
await page.keyboard.press('Escape')

console.log('console errors:', errors.length)
for (const e of errors.slice(0, 20)) console.log('  ✗', e)
console.log(`captures in ${OUT}/`)
console.log(
  errors.length === 0 ? 'RESULT: no console errors ✅' : `RESULT: ${errors.length} error(s) ✗`,
)
await browser.close()
