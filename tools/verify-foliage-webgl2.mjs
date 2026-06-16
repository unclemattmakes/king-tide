/**
 * Foliage-sway WebGL2-fallback verification (headed, real GPU via ANGLE).
 *
 * Proves the boot wiring of `setFoliageSwayBackend(backend)` in
 * `src/boot/race-boot.ts`: on a genuine WebGL2 fallback (`?backend=webgl2`)
 * the sandbar palms take the `onBeforeCompile` patch path, NOT the WebGPU
 * node-material swap. Before the fix, the module defaulted to 'webgpu', so a
 * WebGL2 boot wrongly converted every foliage material to a node material;
 * after the fix the materials stay plain MeshStandardMaterial + carry the
 * sway shader injection.
 *
 * Hard gates (exit 1 on failure):
 *   1. console shows `[render] backend: webgl2` (fallback actually active).
 *   2. debugSwayMeshes() recorded ≥1 `mat_foliage_*` mesh (the hook ran on
 *      foliage during track load).
 *   3. every live `mat_foliage_*` material in the scene took the WebGL2 path:
 *      NOT a node material, vertexColors === true, onBeforeCompile installed.
 *   4. the shared sway clock is advancing (game loop drives updateSwayTime).
 *
 * Visual evidence: rigid (wind 0) vs bent (high wind) screenshots of the
 * closest palm pair, plus a coarse cropped byte-diff as a motion signal.
 *
 * Start your OWN dev server on a pinned port first (hard rule 2 — never the
 * in-app preview / a shared tab), then point this at it:
 *   pnpm dev --port 5197 --strictPort
 *   BASE=http://localhost:5197 node tools/verify-foliage-webgl2.mjs
 */
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5191'
const OUT = 'test-results/profile'
const WIND = Number(process.env.WIND ?? 16)
mkdirSync(OUT, { recursive: true })

const fail = (msg) => {
  console.log(`\n❌ ${msg}`)
  process.exitCode = 1
}

const browser = await chromium.launch({ headless: false })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
const consoleLines = []
page.on('console', (m) => consoleLines.push(m.text()))
page.on('pageerror', (e) => console.log('pageerror:', String(e).split('\n')[0]))

await page.goto(`${BASE}/?race=1&track=sandbar&bike=racer&backend=webgl2`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForFunction(() => window.__hover?.ready === true, null, { timeout: 30000 })

// Nudge into a live race so the game loop ticks the wind/time uniforms.
for (let i = 0; i < 8; i++) {
  const live = await page.evaluate(() => (window.__hover.race?.()?.raceTime ?? 0) > 1.2)
  if (live) break
  await page.keyboard.press('Space')
  await page.waitForTimeout(600)
}
await page.waitForFunction(() => (window.__hover.race?.()?.raceTime ?? 0) > 1.5, null, {
  timeout: 30000,
})
await page.waitForTimeout(1500)

// ── Gate 1: the WebGL2 fallback is genuinely active ─────────────────────────
const backendLine = consoleLines.find((l) => l.includes('[render] backend:'))
console.log(`backend line: ${backendLine ?? '(none)'}`)
if (!backendLine || !backendLine.includes('webgl2')) {
  fail(`expected '[render] backend: webgl2', got: ${backendLine ?? '(no backend line)'}`)
}

// ── Gate 2 + 3: read the sway registry AND inspect live scene materials ──────
const probe = await page.evaluate(async () => {
  const m = await import('/src/engine/render/foliage-sway.ts')
  window.__fsway = m
  const records = m.debugSwayMeshes().map((r) => ({ ...r }))

  // Walk the live scene and classify every mat_foliage_* material by which
  // sway path it took. WebGL2 path → plain material (isNodeMaterial !== true)
  // with vertexColors + onBeforeCompile. WebGPU path → isNodeMaterial true.
  const scene = window.__scene
  const foliage = []
  if (scene) {
    scene.traverse((obj) => {
      const mesh = obj
      if (!mesh.isMesh || !mesh.material) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const mat of mats) {
        if (!mat?.name?.startsWith('mat_foliage_')) continue
        foliage.push({
          name: mat.name,
          isNodeMaterial: mat.isNodeMaterial === true,
          vertexColors: mat.vertexColors === true,
          hasOnBeforeCompile: typeof mat.onBeforeCompile === 'function',
        })
      }
    })
  }
  return { records, foliage, hasScene: !!scene, state: m.debugSwayState() }
})

const foliageRecords = probe.records.filter((r) => r.name?.startsWith('mat_foliage_'))
console.log(`sway registry: ${probe.records.length} meshes, ${foliageRecords.length} foliage`)
console.log(`live scene foliage materials: ${probe.foliage.length} (hasScene=${probe.hasScene})`)

if (foliageRecords.length < 1) {
  fail('debugSwayMeshes() recorded no mat_foliage_* meshes — sway hook never ran on foliage')
}
if (probe.foliage.length < 1) {
  fail('no live mat_foliage_* materials found in scene to inspect')
} else {
  const nodeSwapped = probe.foliage.filter((f) => f.isNodeMaterial)
  const noPatch = probe.foliage.filter((f) => !f.hasOnBeforeCompile)
  const noVtxCol = probe.foliage.filter((f) => !f.vertexColors)
  console.log(
    `  node-material (WRONG path): ${nodeSwapped.length} | ` +
      `missing onBeforeCompile: ${noPatch.length} | missing vertexColors: ${noVtxCol.length}`,
  )
  if (nodeSwapped.length > 0) {
    fail(
      `${nodeSwapped.length}/${probe.foliage.length} foliage materials were swapped to NODE ` +
        `materials — the WebGPU path ran on a webgl2 boot (fix not active)`,
    )
  }
  if (noPatch.length > 0 || noVtxCol.length > 0) {
    fail(
      `foliage took no clean onBeforeCompile patch ` +
        `(missing hook: ${noPatch.length}, missing vertexColors: ${noVtxCol.length})`,
    )
  }
  if (process.exitCode !== 1) {
    console.log('\n✅ WebGL2 path: all foliage materials patched in place (onBeforeCompile)')
  }
}

// ── Gate 4: the sway clock is advancing (uniforms are live) ──────────────────
const t0 = probe.state.time
await page.waitForTimeout(700)
const t1 = await page.evaluate(() => window.__fsway.debugSwayState().time)
console.log(`sway clock: ${t0.toFixed(2)} → ${t1.toFixed(2)} (Δ=${(t1 - t0).toFixed(2)}s)`)
if (!(t1 > t0)) {
  fail('sway clock did not advance — wind/time uniforms are not being driven')
}

// ── Visual evidence: rigid vs bent on the closest palm pair ──────────────────
const fronds = foliageRecords.filter((r) => r.name === 'mat_foliage_palm')
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
  const dist = Math.max(16, d * 1.9)
  const pose = {
    pos: { x: mid.x + dist * 0.45, y: mid.y + dist * 0.42, z: mid.z + dist * 0.9 },
    target: { x: mid.x, y: mid.y + 5.0, z: mid.z },
  }
  await page.evaluate((p) => window.__hover.setCameraPose(p), pose)
  // Tight clip over the upper canopy so water contributes little to the diff.
  const clip = { x: 600, y: 120, width: 400, height: 360 }

  await page.evaluate(() => window.__fsway.updateWind({ x: 1, z: 0.2 }, 0, 1.4))
  await page.waitForTimeout(500)
  const rigid = await page.screenshot({ path: `${OUT}/webgl2-foliage-0-rigid.png`, clip })

  await page.evaluate((w) => window.__fsway.updateWind({ x: 1, z: 0.2 }, w, 1.4), WIND)
  let maxDiff = 0
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(360)
    const bent = await page.screenshot({ path: `${OUT}/webgl2-foliage-1-bent-${i}.png`, clip })
    // Coarse byte-difference ratio between the rigid and bent PNG buffers.
    const n = Math.min(rigid.length, bent.length)
    let diff = 0
    for (let k = 0; k < n; k++) if (rigid[k] !== bent[k]) diff++
    maxDiff = Math.max(maxDiff, diff / n)
  }
  console.log(
    `framed palm pair ${d.toFixed(1)}m apart; canopy rigid-vs-bent byte-diff ratio: ` +
      `${(maxDiff * 100).toFixed(1)}% (motion signal; not a hard gate)`,
  )
  await page.evaluate(() => window.__hover.setCameraPose(null))
} else {
  console.log('(no separated palm-frond pair to frame; skipped visual A/B)')
}

await page.evaluate(() => window.__fsway?.updateWind({ x: 1, z: 0.2 }, 0.18, 1.4))
console.log(`\ncaptures: ${OUT}/webgl2-foliage-*.png`)
console.log(process.exitCode === 1 ? '\nRESULT: FAIL' : '\nRESULT: PASS ✅')
await browser.close()
