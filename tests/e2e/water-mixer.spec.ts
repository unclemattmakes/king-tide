/**
 * Water mixer board + per-level tuning (water-defaults pass, 2026-06-14).
 *
 * Verifies the reworked WATER tuner:
 *   - LAB: the panel renders as a mixer board — 5 sections, mute/solo on the
 *     18 look layers, inert-scene tags on the 6 knobs open ocean can't drive,
 *     an EXPORT button — and the lab HUD no longer overlaps the left-docked card.
 *   - mute dims + zeroes a layer; solo dims every OTHER look layer.
 *   - EXPORT copies a parseable `{ water: { look: {...} } }` block.
 *   - TRACK: opened in a level the panel is track-SCOPED — no inert tags, EXPORT
 *     targets the slug's JSON, a slider edit persists to the per-slug working
 *     store, and the machine-wide global store is left untouched.
 *
 *   E2E_PORT=5473 pnpm e2e tests/e2e/water-mixer.spec.ts --workers=1
 */
import { expect, test } from '@playwright/test'
import { waitForReady } from './helpers/boot'

// Headed-GPU pages; Chromium starves rAF in unfocused windows — run serial so
// workers don't fight over focus.
test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  // Every run starts from a clean slate — no leftover global or per-slug tuning.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      /* storage unavailable — defaults apply anyway */
    }
  })
})

test('lab: panel is a mixer board and the HUD clears the card', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/?waterlab=1')
  await page.bringToFront()
  await page.waitForFunction(() => !!window.__waterlab, null, { timeout: 60_000 })

  const body = page.locator('#wd-body')
  await expect(body.locator('h2')).toHaveCount(5)
  // 18 mutable look layers × (M + S).
  await expect(body.locator('.mx-btn')).toHaveCount(36)
  // The six knobs open ocean can't drive are tagged inert.
  await expect(body.locator('.lab-note')).toHaveCount(6)
  await expect(page.locator('#wd-export')).toBeVisible()

  // HUD sits bottom-right, clear of the left-docked tuner card (the bug report).
  const hud = await page.locator('#waterlab-hud').boundingBox()
  const card = await page.locator('#water-debug .card').boundingBox()
  expect(hud).not.toBeNull()
  expect(card).not.toBeNull()
  expect(hud!.x).toBeGreaterThan(card!.x + card!.width)

  await page.screenshot({ path: 'artifacts/water-mixer/lab-mixer.png' })
})

test('lab: mute and solo gate the look layers', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/?waterlab=1')
  await page.bringToFront()
  await page.waitForFunction(() => !!window.__waterlab, null, { timeout: 60_000 })

  const contact = page.locator('#wd-body .row', { has: page.locator('#wd-contactFoam') })
  const ramp = page.locator('#wd-body .row', { has: page.locator('#wd-rampStrength') })

  // Mute: the row dims and the M button latches; clicking again clears it.
  await contact.locator('.mx-mute').click()
  await expect(contact.locator('.mx-mute')).toHaveClass(/on/)
  await expect(contact).toHaveClass(/mx-off/)
  await contact.locator('.mx-mute').click()
  await expect(contact).not.toHaveClass(/mx-off/)

  // Solo one layer → every OTHER look layer dims, the soloed one stays lit.
  await contact.locator('.mx-solo').click()
  await expect(contact.locator('.mx-solo')).toHaveClass(/on/)
  await expect(contact).not.toHaveClass(/mx-off/)
  await expect(ramp).toHaveClass(/mx-off/)
  await contact.locator('.mx-solo').click()
  await expect(ramp).not.toHaveClass(/mx-off/)
})

test('lab: EXPORT copies a parseable water block', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/?waterlab=1')
  await page.bringToFront()
  await page.waitForFunction(() => !!window.__waterlab, null, { timeout: 60_000 })

  // Drive a look slider through the PANEL (so the panel's settings update, not
  // just the mesh) to create a real delta-from-default.
  await page.locator('#wd-rampStrength').evaluate((el) => {
    const i = el as HTMLInputElement
    i.value = '1'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    i.dispatchEvent(new Event('change', { bubbles: true }))
  })

  const logs: string[] = []
  page.on('console', (m) => logs.push(m.text()))
  await page.locator('#wd-export').click()
  await expect(page.locator('#wd-export')).toHaveText(/COPIED/)
  await expect.poll(() => logs.some((l) => l.includes('[water] export')), { timeout: 5000 }).toBe(
    true,
  )

  const line = logs.find((l) => l.includes('[water] export'))!
  const parsed = JSON.parse(line.slice(line.indexOf('{')))
  expect(parsed.water.look.rampStrength).toBeCloseTo(1, 2)
})

test('watertune: loads a real track free-cam, track-scoped tuner, no race', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/?watertune=sandbar')
  await page.bringToFront()
  // The tuner auto-opens at the end of boot → 5 sections present means booted.
  await expect(page.locator('#wd-body h2')).toHaveCount(5, { timeout: 90_000 })
  // Track-scoped: EXPORT targets sandbar's JSON, and NOTHING is inert (the real
  // level has a seabed + obstacles, unlike the open-ocean lab).
  await expect(page.locator('#wd-export')).toHaveAttribute('title', /sandbar\.json/)
  await expect(page.locator('#wd-body .lab-note')).toHaveCount(0)
  // No race chrome, and the free-cam HUD names the mode.
  await expect(page.locator('#race-banner')).toBeHidden()
  await expect(page.locator('#watertune-hud')).toContainText('WATER TUNE')
  // Let the loading overlay fade + the water/scene render a few seconds before
  // the proof shot (the tuner builds a tick before hideLoadingScreen).
  await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(4000)
  await page.screenshot({ path: 'artifacts/water-mixer/watertune-sandbar.png' })
})

test('track: panel is track-scoped — no inert tags, slug export, per-slug persist', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.goto('/?autostart=1')
  await page.bringToFront()
  await waitForReady(page)

  // Open the WATER tuner from the dock rail (the in-level path).
  await expect(page.locator('#dev-dock')).toBeVisible()
  await page.locator('#dev-dock .dd-row[data-tool="panel.water"]').click()
  await expect(page.locator('#water-debug')).toHaveClass(/show/)

  const body = page.locator('#wd-body')
  await expect(body.locator('h2')).toHaveCount(5)
  // In a real level the seabed + obstacles exist → nothing is inert.
  await expect(body.locator('.lab-note')).toHaveCount(0)
  // EXPORT targets THIS track's JSON file.
  await expect(page.locator('#wd-export')).toHaveAttribute('title', /public\/tracks\/.+\.json/)

  // A slider edit persists to the per-slug working store (sparse, absolute).
  await page.locator('#wd-contactFoam').evaluate((el) => {
    const i = el as HTMLInputElement
    i.value = '1.6'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    i.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const stored = await page.evaluate(() => {
    for (let k = 0; k < localStorage.length; k++) {
      const key = localStorage.key(k)
      if (key?.startsWith('hoverbike.waterDebug.track.') && key.endsWith('.v1')) {
        return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, number>
      }
    }
    return null
  })
  expect(stored).not.toBeNull()
  expect(stored!.contactFoam).toBeCloseTo(1.6, 2)

  // Track scope must NOT touch the machine-wide global look store.
  const global = await page.evaluate(() => localStorage.getItem('hoverbike.waterDebug.v10'))
  expect(global).toBeNull()
})
