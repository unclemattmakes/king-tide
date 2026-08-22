/**
 * Practice Lagoon — boot + coached-session smoke (evaluation summary
 * #1; maintainer decision 2026-08-22). This is the standing focused
 * verification scene CLAUDE.md hard rule 2 asks feel changes to be
 * exercised against: the venue is asset-light (JSON + primitive props,
 * no GLBs, no R2 hydration), so this spec runs on any clone.
 *
 * Pins: the venue boots to a grounded player, the session is solo
 * (ai=0 wins over the tutorial escort), and the practice script's
 * first station beat is armed on the tutorial HUD.
 */

import { expect, test } from '@playwright/test'

const PRACTICE_URL = '/?race=1&track=practice-lagoon&bike=cruiser&tutorial=1&ai=0'

test.describe('practice lagoon', () => {
  test('boots solo with the station script armed', async ({ page }) => {
    await page.goto(PRACTICE_URL)
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 30_000,
    })
    // Solo water: the standings list is exactly the player.
    const standingsCount = await page.evaluate(() => window.__hover?.standings().length ?? -1)
    expect(standingsCount).toBe(1)
    // The practice script's first station beat is up on the tutorial HUD.
    await expect(page.locator('#hud-tutorial')).toBeVisible()
    await expect(page.locator('#hud-tutorial')).toContainText(/THROTTLE/i)
    // Beat count reflects the 8-beat practice script, not the 7-beat intro.
    await expect(page.locator('#hud-tutorial')).toContainText(/1\/8/)
  })

  test('throttle input clears the first two station beats', async ({ page }) => {
    await page.goto(PRACTICE_URL)
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 30_000,
    })
    // Hold throttle — the coached THROTTLE (>6 m/s) then CRUISE
    // (>14 m/s) beats clear from speed alone on the opening straight.
    await page.keyboard.down('w')
    await expect(page.locator('#hud-tutorial')).toContainText(/CRUISE|LAUNCH/i, {
      timeout: 20_000,
    })
    await page.keyboard.up('w')
  })
})
