import { expect, test } from '@playwright/test'

/**
 * Steam Deck has a fixed 1280×800 (16:10) LCD/OLED. The current HUD was
 * tested at 16:9 widescreen; this spec guards that the menu cathedral
 * and Settings overlay don't overflow vertically at 800px tall. If they
 * do, the Deck player can't reach the bottom mode-select tile or the
 * Settings "Apply" button.
 *
 * See docs/steam-deck.md for the full Deck profile + wrapper plan.
 */
test.use({
  viewport: { width: 1280, height: 800 },
  contextOptions: { reducedMotion: 'reduce' },
})

test.describe.configure({ timeout: 60_000 })

test.describe('menu @ 1280×800 (Steam Deck)', () => {
  test('title screen fits in the viewport without vertical scroll', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#title-start')).toBeVisible({ timeout: 10_000 })

    // documentElement.scrollHeight ≤ clientHeight means the page doesn't
    // need to scroll. Tolerate a 2px rounding fudge.
    const { scrollHeight, clientHeight } = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }))
    expect(scrollHeight, 'title screen overflows 800px height').toBeLessThanOrEqual(
      clientHeight + 2,
    )
  })

  test('mode-select screen fits at Deck resolution', async ({ page }) => {
    await page.goto('/')
    // `force: true` skips the stability dance — the infinite `bc-live`
    // / `bc-blink` chyron animations otherwise keep Playwright's stable
    // check from settling under SwiftShader. See `menu-flow.spec.ts`
    // header for the full rationale.
    await page.locator('#title-start').click({ force: true })
    // First mode card visible = mode-select screen has rendered.
    await expect(page.locator('.bc-mode-card[data-mode="race"]')).toBeVisible({ timeout: 10_000 })

    const { scrollHeight, clientHeight } = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }))
    expect(scrollHeight, 'mode-select screen overflows 800px height').toBeLessThanOrEqual(
      clientHeight + 2,
    )
  })
})
