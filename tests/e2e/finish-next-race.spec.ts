import { expect, test } from '@playwright/test'
import { waitFullyBooted } from './helpers/boot'

/**
 * The finish screen's NEXT RACE button, driven through a real race.
 *
 * Single-race NEXT used to rotate to whatever id sorted next in the
 * asset manifest — off any Reef track that meant `seattle`, a venue the
 * player never chose and (since the first-cup menu pass) can't even see
 * on the card. A one-off race has no schedule to advance, so NEXT is now
 * a trip back to the venue picker.
 *
 * Runs on the procedural Lagoon Loop (`?autostart=1`) because that's the
 * track the AI controller is actually tuned for — `m9-ai-laps` pins it at
 * ~24 s per lap, so three laps land inside the wait. A smaller test track
 * looks cheaper but the autopilot can't close a lap on one. What's under
 * test is the button wiring, not the venue.
 */
test.describe.configure({ timeout: 180_000 })

test.describe('finish screen · NEXT RACE', () => {
  test('sends a single race back to the venue picker', async ({ page }) => {
    await page.goto('/?autostart=1')
    await waitFullyBooted(page)

    // Hand the bike to the AI and let it close out all three laps.
    await page.evaluate(() => window.__hover!.toggleAutoPlay())
    const nextBtn = page.locator('#finish-next')
    await expect(nextBtn).toBeVisible({ timeout: 150_000 })

    // Single-race mode: plain label, no cup progress counter.
    await expect(nextBtn).toHaveText('NEXT RACE')

    await nextBtn.click({ force: true })
    await page.waitForURL(/menu=track/, { timeout: 30_000 })
    const url = page.url()
    expect(url).toContain('back=1')
    // The race params must be dropped — this is a return to the menu,
    // not another lap of the same venue.
    expect(url).not.toContain('race=1')
    expect(url).not.toContain('track=lagoon')

    // And it lands on the venue picker, not the title screen.
    await expect(page.locator('#sp-track-cards .bc-card').first()).toBeVisible()
    await expect(page.locator('#menu-crumbs .bc-crumb.is-current')).toHaveText('TRACK')
  })
})
