/**
 * Foliage-sway DESYNC check (companion to capture-sway.mjs) — headed
 * real-WebGPU. Proves sandbar's palms no longer sway in lockstep:
 *   1) reads the live per-mesh phase registry (`debugSwayMeshes`) and asserts
 *      distinct palm meshes got distinct phases (exits 1 on lockstep), and
 *   2) parks the camera on the closest pair of palms, cranks wind, and
 *      captures frames so the bend-phase difference is visible.
 *
 * Where capture-sway.mjs proves the sway is GPU-live (rigid vs bent), this
 * proves each palm bends at its own phase (the per-mesh / per-instance hash
 * in src/engine/render/foliage-sway.ts).
 *
 *   node tools/capture-sway-desync.mjs   # → test-results/profile/desync-*.png
 *   BASE=… WIND=… to override the dev server / wind strength.
 */
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5191'
const OUT = 'test-results/profile'
const WIND = Number(process.env.WIND ?? 16)
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ headless: false })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.log('pageerror:', String(e).split('\n')[0]))

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
await page.waitForTimeout(2000)

// 1) Read the live phase registry.
const records = await page.evaluate(async () => {
  const m = await import('/src/engine/render/foliage-sway.ts')
  window.__fsway = m
  return m.debugSwayMeshes().map((r) => ({ ...r }))
})

const fronds = records.filter((r) => r.name === 'mat_foliage_palm')
const phases = fronds.map((r) => r.phase)
const distinct = new Set(phases.map((p) => p.toFixed(4)))
console.log(`foliage meshes total: ${records.length}`)
console.log(`palm frond meshes:    ${fronds.length}`)
console.log(`distinct frond phases: ${distinct.size} / ${fronds.length}`)
console.log(
  'sample phases (rad):',
  phases
    .slice(0, 12)
    .map((p) => p.toFixed(3))
    .join(', '),
)
if (fronds.length > 1 && distinct.size <= 1) {
  console.log('\n❌ LOCKSTEP: all palm fronds share one phase')
  await browser.close()
  process.exit(1)
}
console.log(`\n✅ DESYNC: ${distinct.size} distinct phases across ${fronds.length} palm meshes`)

// 2) Frame the closest pair of palm fronds for a visible A/B.
let best = null
for (let i = 0; i < fronds.length; i++) {
  for (let j = i + 1; j < fronds.length; j++) {
    const a = fronds[i]
    const b = fronds[j]
    const d = Math.hypot(a.x - b.x, a.z - b.z)
    if (d > 0.5 && (!best || d < best.d)) best = { a, b, d }
  }
}
if (best) {
  const { a, b, d } = best
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }
  console.log(
    `closest palm pair ${d.toFixed(1)}m apart at`,
    mid,
    `phaseΔ=${Math.abs(a.phase - b.phase).toFixed(2)}rad`,
  )
  const dist = Math.max(16, d * 1.9)
  const pose = {
    pos: { x: mid.x + dist * 0.45, y: mid.y + dist * 0.42, z: mid.z + dist * 0.9 },
    target: { x: mid.x, y: mid.y + 5.0, z: mid.z },
  }
  await page.evaluate((p) => window.__hover.setCameraPose(p), pose)
  // Rigid reference.
  await page.evaluate(() => window.__fsway.updateWind({ x: 1, z: 0.2 }, 0, 1.4))
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/desync-0-rigid.png` })
  // Crank wind; capture across a half-period so adjacent palms (different
  // phase) are caught bending opposite ways.
  await page.evaluate((w) => window.__fsway.updateWind({ x: 1, z: 0.2 }, w, 1.4), WIND)
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(380)
    await page.screenshot({ path: `${OUT}/desync-1-bent-${i}.png` })
  }
  await page.evaluate(() => window.__hover.setCameraPose(null))
}

await page.evaluate(() => window.__fsway.updateWind({ x: 1, z: 0.2 }, 0.18, 1.4))
console.log('captured:', OUT)
await browser.close()
