/**
 * UI contact-sheet capture — screenshots every player-facing UI surface
 * (title, mode select, track/bike select, settings, race intro, countdown,
 * in-race HUD, pause) so a skin pass can be judged by eye, before/after.
 *
 * Same harness family as gen-track-shots: headed Chromium on the real GPU,
 * autopilot driving the race so HUD elements (timer, minimap, gap toasts)
 * show live values.
 *
 * Gated on `UI_SHOTS=1` so `pnpm e2e` stays fast. Run via:
 *   UI_SHOTS=1 UI_SHOTS_LABEL=before E2E_PORT=<N> pnpm exec playwright test gen-ui-shots
 *
 * Env knobs:
 *   UI_SHOTS_LABEL  output subfolder (default "current")
 *   UI_SHOTS_TRACK  track id for the race surfaces (default "sandbar")
 *
 * Output: artifacts/ui-shots/<label>/NN-<surface>.png — `artifacts/` so the
 * frames survive test-results/ being wiped on the next run.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { test } from '@playwright/test'
import { waitForReady } from './helpers/boot'

const LABEL = process.env.UI_SHOTS_LABEL ?? 'current'
const TRACK = process.env.UI_SHOTS_TRACK ?? 'sandbar'
const OUT_DIR = path.resolve(process.cwd(), 'artifacts', 'ui-shots', LABEL)
const SHOT_W = 1600
const SHOT_H = 900

test.describe('UI contact sheet', () => {
  test.skip(process.env.UI_SHOTS !== '1', 'gated on UI_SHOTS=1')
  // Two simultaneous WebGPU boots can poison the water render pipeline
  // (observed: "Invalid RenderPipeline renderPipeline_water_*" + black
  // canvas) — run the surfaces one at a time.
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(() => {
    mkdirSync(OUT_DIR, { recursive: true })
  })

  const shot = async (page: import('@playwright/test').Page, name: string) => {
    // Dev-build chrome (dock rail, garage button) isn't part of the
    // player-facing read — hide it for the contact sheet.
    await page.addStyleTag({
      content: '#dev-dock, #garage-toggle { display: none !important; }',
    })
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) })
    console.log(`ui-shots: ${name}`)
  }

  test('menu flow surfaces', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: SHOT_W, height: SHOT_H })
    await page.goto('/')
    await page.waitForSelector('#menu.show .bc-title', { timeout: 30_000 })
    // Give the attract-mode feed a moment to go live behind the menu so
    // the shot shows the real backdrop, not the gradient fallback.
    await page
      .waitForSelector('body.attract-live', { timeout: 25_000 })
      .catch(() => console.log('ui-shots: attract feed never went live (shooting fallback)'))
    await page.waitForTimeout(1500)
    await shot(page, '01-title')

    await page.click('.bc-title')
    await page.waitForTimeout(900)
    await shot(page, '02-mode-select')

    // RACE route → track select.
    await page.click('.bc-mode-card[data-mode="race"]')
    await page.waitForTimeout(900)
    await shot(page, '03-track-select')

    // Pick the first enabled track card, then continue if a primary
    // action is exposed (flow: track → bike → pre-race options).
    const trackCard = page.locator('.bc-screen.show .bc-card:not(.bc-disabled)').first()
    if (await trackCard.isVisible().catch(() => false)) {
      await trackCard.click()
      await page.waitForTimeout(500)
      const next = page.locator('.bc-screen.show .bc-btn.primary:visible').first()
      if (await next.isVisible().catch(() => false)) {
        await next.click()
        await page.waitForTimeout(900)
      }
      await shot(page, '04-bike-select')
      const next2 = page.locator('.bc-screen.show .bc-btn.primary:visible').first()
      if (await next2.isVisible().catch(() => false)) {
        await next2.click()
        await page.waitForTimeout(900)
        await shot(page, '05-pre-race')
      }
    }

    // Settings overlay (reachable from any step via the footer link on
    // mode select — walk back there with Escape).
    for (let i = 0; i < 4; i++) {
      const link = page.locator('#mode-settings')
      if (await link.isVisible().catch(() => false)) break
      await page.keyboard.press('Escape')
      await page.waitForTimeout(450)
    }
    const settingsLink = page.locator('#mode-settings')
    if (await settingsLink.isVisible().catch(() => false)) {
      await settingsLink.click()
      await page.waitForSelector('#settings-menu.show', { timeout: 5_000 })
      await page.waitForTimeout(600)
      await shot(page, '06-settings')
      await page.keyboard.press('Escape')
    }
  })

  test('race surfaces', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: SHOT_W, height: SHOT_H })
    await page.goto(`/?autostart=1&track=${TRACK}`)
    await waitForReady(page, { timeout: 60_000 })

    // Hand the player to the AI so the race actually runs.
    await page.evaluate(() => {
      if (!window.__hover!.isAutoPlay()) window.__hover!.toggleAutoPlay()
    })

    // Pre-lap intro (if enabled) — grab one frame mid-cinematic.
    const intro = page.locator('#race-intro-ui.riu-active')
    if (await intro.isVisible().catch(() => false)) {
      await page.waitForTimeout(2500)
      await shot(page, '10-race-intro')
    }

    // Countdown — wait for the banner or the start lights to show.
    await page
      .waitForSelector('#race-banner.show, #start-lights.sl-active', { timeout: 30_000 })
      .catch(() => console.log('ui-shots: no countdown surface appeared'))
    await page.waitForTimeout(400)
    await shot(page, '11-countdown')

    // In-race HUD — let the field spread out so the minimap + timer show
    // real values.
    await page.waitForFunction(() => (window.__hover!.race()?.raceTime ?? 0) > 6, null, {
      timeout: 45_000,
    })
    await shot(page, '12-race-hud')
    await page.waitForFunction(() => (window.__hover!.race()?.raceTime ?? 0) > 18, null, {
      timeout: 30_000,
    })
    await shot(page, '13-race-hud-later')

    // Pause menu over the live race.
    await page.keyboard.press('Escape')
    await page.waitForSelector('#pause-menu.show', { timeout: 5_000 })
    await page.waitForTimeout(500)
    await shot(page, '14-pause')
  })
})
