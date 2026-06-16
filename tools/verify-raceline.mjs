/**
 * Headed (real-GPU) verification for A4 (painterly normals — assessment) and
 * B3 (racing-line flow ribbon). Drives the RACE scene on YOUR OWN dev server
 * (hard rule 2 — never the in-app preview), with the bike on autoplay so it
 * follows the racing line and the chase cam looks down the line.
 *
 *   A4 — capture the DEFAULT look (illum=1 warp on) vs brush relief cranked vs
 *        brush off, to judge by eye whether a dedicated brush NORMAL map would
 *        add anything over the existing `bumpMap(streak)` relief the warp lights.
 *   B3 — enable the ribbon (`?raceline` / window.__raceline), capture it on the
 *        water at race pace, and exercise the live width/opacity/brake dials.
 *
 * Inspect the PNGs by eye (byte-diffing compressed PNGs is meaningless); the
 * console-error count is the hard gate (watch for any TSL compile error).
 *
 *   pnpm dev --port 5288 --strictPort
 *   BASE=http://localhost:5288 node tools/verify-raceline.mjs
 */
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5288'
const TRACK = process.env.TRACK ?? 'sandbar'
const OUT = 'artifacts/raceline'
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ headless: false })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).split('\n')[0]))
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` })
const wait = (ms) => page.waitForTimeout(ms)

await page.goto(`${BASE}/?race=1&track=${TRACK}&bike=racer`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__hover?.ready === true, null, { timeout: 45000 })

// Autoplay drives the player bike along the racing line; nudge throttle so the
// countdown completes and we're moving down the line for the chase-frame read.
await page.evaluate(() => window.__hover?.setAutoPlay?.(true) ?? window.__hover?.toggleAutoPlay?.())
for (let i = 0; i < 18; i++) {
  if (await page.evaluate(() => (window.__hover.race?.()?.raceTime ?? 0) > 5)) break
  await page.keyboard.press('Space')
  await wait(500)
}
await wait(1500)
await shot('00-baseline-default')

// ── A4 — brush-relief contribution to the (now-default warp) lighting ─────────
// brush amount scales the bumpMap normal perturbation (uBrush.mul(2.5)), so
// cranking it is the upper bound of "more brushed lighting" with the existing
// relief; brush 0 removes it entirely. If cranked barely moves the lit read, a
// dedicated normal map won't either.
await page.evaluate(async () => {
  const m = await import('/src/engine/render/brush-tuning-service.ts')
  m.setVinylBrush({ brush: 1.6 })
})
await wait(900)
await shot('a4-01-brush-crank')
await page.evaluate(async () => {
  const m = await import('/src/engine/render/brush-tuning-service.ts')
  m.setVinylBrush({ brush: 0 })
})
await wait(900)
await shot('a4-02-brush-off')
await page.evaluate(async () => {
  const m = await import('/src/engine/render/brush-tuning-service.ts')
  m.setVinylBrush({ brush: 0.7 }) // restore default
})
await wait(500)

// ── B3 — racing-line ribbon ──────────────────────────────────────────────────
await page.evaluate(async () => {
  const m = await import('/src/engine/render/racing-line-ribbon.ts')
  m.setRacingLineRibbonEnabled(true)
})
await wait(1400)
await shot('b3-01-ribbon-default')
// Let the bike drive further down the line — a fresh frame shows the flow + a
// different stretch (likely a bend → the warm brake colour).
await wait(2500)
await shot('b3-02-ribbon-moving')

// Live dials: a wider, bolder band, then a flow/brake sweep — confirms the dev
// tuning path works without a recompile.
await page.evaluate(() => window.__raceline?.set?.({ halfWidth: 5, opacity: 0.85 }))
await wait(1200)
await shot('b3-03-wide-bold')
await page.evaluate(() => window.__raceline?.set?.({ brakeMix: 1, flowSpeed: 1.2 }))
await wait(1500)
await shot('b3-04-brake-flow')
// Back to shipped defaults for a clean "this is the proposed look" frame.
await page.evaluate(() =>
  window.__raceline?.set?.({ halfWidth: 3, opacity: 0.5, brakeMix: 0.7, flowSpeed: 0.5 }),
)
await wait(2500)
await shot('b3-05-ribbon-default-far')

// Toggle OFF → confirm it vanishes cleanly (byte-identical-to-today gate by eye).
await page.evaluate(async () => {
  const m = await import('/src/engine/render/racing-line-ribbon.ts')
  m.setRacingLineRibbonEnabled(false)
})
await wait(900)
await shot('b3-06-ribbon-off')

// Dev palette shows the new toggle.
await page.keyboard.press('Control+k')
await wait(400)
await page.keyboard.type('racing')
await wait(400)
await shot('b3-07-palette')
await page.keyboard.press('Escape')

console.log('console errors:', errors.length)
for (const e of errors.slice(0, 25)) console.log('  ✗', e)
console.log(`captures in ${OUT}/`)
console.log(
  errors.length === 0 ? 'RESULT: no console errors ✅' : `RESULT: ${errors.length} error(s) ✗`,
)
await browser.close()
