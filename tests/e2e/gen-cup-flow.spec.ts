/**
 * Cup-flow contact sheet — the championship surfaces that gen-ui-shots
 * doesn't cover: the CUP-mode lineup (Reef Cup preview + START CUP), the
 * end-of-cup podium ceremony, and the full-field standings card.
 *
 * Same harness family as gen-track-shots / gen-ui-shots: headed Chromium
 * on the real GPU. The podium + standings read a *completed* cup from
 * sessionStorage, so we seed a synthetic finished Reef Cup via
 * addInitScript before navigating to ?podium=1 (the same storage key
 * cup-progress.ts writes).
 *
 * Gated on CUP_FLOW=1 so `pnpm e2e` stays fast. Run via:
 *   CUP_FLOW=1 E2E_PORT=5399 pnpm exec playwright test gen-cup-flow --project=chromium --workers=1
 *
 * Output: artifacts/cup-flow/<label>/NN-<surface>.png
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { test } from '@playwright/test'

const LABEL = process.env.CUP_FLOW_LABEL ?? 'current'
const OUT_DIR = path.resolve(process.cwd(), 'artifacts', 'cup-flow', LABEL)
const SHOT_W = 1600
const SHOT_H = 900

// A completed Reef Cup, full 8-bike field, player (slot 0) takes gold.
const REEF_RACES = ['sandbar', 'mexico-city', 'cape-town-drift']
const NAMES = ['YOU', 'NOVA', 'RIPTIDE', 'ZEPHYR', 'CINDER', 'MARLIN', 'KOI', 'EBB']
const COLORS = [0x5cf2ff, 0xff7ec1, 0x66ff99, 0xffd54a, 0xff7a3a, 0x9b8cff, 0x4dd0e1, 0xe0e0e0]
// Per-race finish position by slot (index = slot). Player lands 1,1,2 → gold;
// NOVA 2,2,1 → silver; RIPTIDE 3,3,3 → bronze.
const POSITIONS: Record<string, number[]> = {
  sandbar: [1, 2, 3, 4, 5, 6, 7, 8],
  'mexico-city': [1, 2, 3, 4, 5, 6, 7, 8],
  'cape-town-drift': [2, 1, 3, 4, 5, 6, 7, 8],
}

function seededCup(): Record<string, unknown> {
  const roster = NAMES.map((name, slot) => ({
    slot,
    isPlayer: slot === 0,
    name,
    variantId: 'racer',
    bodyColor: COLORS[slot],
  }))
  const results: Record<string, unknown> = {}
  for (const trackId of REEF_RACES) {
    const pos = POSITIONS[trackId]!
    const finishers = pos.map((position, slot) => ({
      slot,
      position,
      raceTime: 58 + position * 1.4 + slot * 0.1,
    }))
    results[trackId] = {
      trackId,
      position: pos[0], // player mirror
      totalRacers: 8,
      raceTime: finishers[0]!.raceTime,
      finishers,
    }
  }
  return {
    cupId: 'reef',
    bikeId: 'racer',
    races: REEF_RACES,
    currentRaceIndex: REEF_RACES.length,
    roster,
    results,
    startedAt: 1_700_000_000_000,
  }
}

test.describe('cup-flow contact sheet', () => {
  test.skip(process.env.CUP_FLOW !== '1', 'gated on CUP_FLOW=1')
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(() => {
    mkdirSync(OUT_DIR, { recursive: true })
  })

  const shot = async (page: import('@playwright/test').Page, name: string) => {
    await page.addStyleTag({
      content: '#dev-dock, #garage-toggle { display: none !important; }',
    })
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) })
    console.log(`cup-flow: ${name}`)
  }

  test('cup select lineup', async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: SHOT_W, height: SHOT_H })
    await page.goto('/')
    await page.waitForSelector('#menu.show .bc-title', { timeout: 30_000 })
    await page.click('.bc-title')
    await page.waitForTimeout(900)
    // Mode select → CUP route.
    await page.click('.bc-mode-card[data-mode="cup"]')
    await page.waitForTimeout(1200)
    await shot(page, '01-cup-select')

    // If a cup tile must be picked to reveal the lineup + START CUP, click
    // the first enabled one (Reef is first) and shoot the committed lineup.
    const cupCard = page.locator('#sp-cup-cards .bc-card:not(.bc-disabled)').first()
    if (await cupCard.isVisible().catch(() => false)) {
      await cupCard.click()
      await page.waitForTimeout(800)
      await shot(page, '02-reef-lineup')
    }
  })

  test('podium + standings', async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: SHOT_W, height: SHOT_H })
    // Seed a finished Reef Cup before any app script runs.
    await page.addInitScript((cup) => {
      try {
        window.sessionStorage.setItem('hoverbike.cupProgress.v1', JSON.stringify(cup))
      } catch {
        /* ignore */
      }
    }, seededCup())

    await page.goto('/?podium=1')
    // Let the ceremony dolly-in play, then grab the 3D reveal.
    await page.waitForTimeout(2600)
    await shot(page, '03-podium-ceremony')

    // Skip to the standings card (Enter is the documented skip key).
    await page.keyboard.press('Enter')
    await page
      .waitForSelector('#cup-results.show, #cup-results', { timeout: 8_000 })
      .catch(() => console.log('cup-flow: standings card never appeared'))
    await page.waitForTimeout(900)
    await shot(page, '04-standings')
  })
})
