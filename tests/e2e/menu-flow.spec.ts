import { expect, test } from '@playwright/test'

/**
 * Cold-boot menu flow smoke tests. The full broadcast-styled menu lives
 * in `src/engine/menus/`; these tests cover:
 *  - bare `/` lands on the title screen
 *  - clicking through title → mode → track → bike sets the right URL
 *    and reloads into a race (the existing race tests cover what
 *    happens after the reload)
 *  - `?autostart=1` skips the menu entirely (the rest of the suite
 *    relies on this)
 */
test.describe('cold-boot menu', () => {
  test('bare URL shows the title screen with PRESS START', async ({ page }) => {
    await page.goto('/')
    const title = page.locator('#title-start')
    await expect(title).toBeVisible()
    // Body gets the menu-active class so HUD chrome stays hidden.
    const bodyClass = await page.evaluate(() => document.body.classList.contains('menu-active'))
    expect(bodyClass).toBe(true)
  })

  test('?autostart=1 skips the menu and boots the race', async ({ page }) => {
    await page.goto('/?autostart=1')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 10000,
    })
    const menuVisible = await page.locator('#menu.show').count()
    expect(menuVisible).toBe(0)
  })

  test('full SP path commits a race URL with track + bike + race=1', async ({ page }) => {
    await page.goto('/')
    await page.locator('#title-start').click()
    await page.locator('.bc-mode-card[data-mode="sp"]').click()
    // Click the first track card (Lagoon Loop) — it's the procedural
    // default and always present.
    await page.locator('#sp-track-cards .bc-card').first().click()
    await page.locator('#sp-track-next').click()
    // Pick the first bike (Cruiser comes first in BIKE_VARIANTS).
    await page.locator('#sp-bike-cards .bc-card').first().click()
    await page.locator('#sp-bike-go').click()
    await page.waitForLoadState('domcontentloaded')
    const url = page.url()
    expect(url).toContain('race=1')
    expect(url).toMatch(/track=/)
    expect(url).toMatch(/bike=/)
  })

  test('MP entry "CREATE LOBBY" navigates to a room code URL', async ({ page }) => {
    await page.goto('/')
    await page.locator('#title-start').click()
    await page.locator('.bc-mode-card[data-mode="mp"]').click()
    // CREATE LOBBY button is the first card on the MP entry screen.
    await page.locator('.bc-mode-card[data-action="create"]').click()
    await page.waitForLoadState('domcontentloaded')
    expect(page.url()).toMatch(/[?&]room=[A-Z0-9-]+/)
  })
})
