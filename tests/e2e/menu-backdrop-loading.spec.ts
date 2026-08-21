import { expect, test } from '@playwright/test'

/**
 * Cold-boot menu backdrop: the loading indicator, and the absence of the
 * key-art plate it replaced.
 *
 * The menu is interactive long before the attract-mode track finishes
 * loading behind it. That gap used to be papered over with a painted
 * concept-art JPG (`/assets/ui/title-backdrop.jpg` + `body.backdrop-plate`),
 * which filled the backdrop and so read as the *finished* menu. It's a
 * corner spinner now — honest about the venue still loading, and, crucially,
 * one that always comes down: when the feed goes live, and equally when the
 * attract boot gives up (a machine with no GPU, an unhydrated assets dir).
 *
 * Asset-independent by design: it asserts the indicator's lifecycle, not
 * anything about what the feed renders, so it holds on a hydrated clone
 * (feed goes live) and on a bare one (attract boot fails) alike. Timeout
 * bumped like the other menu specs — cold boot under headless SwiftShader
 * is slow.
 */
test.use({ contextOptions: { reducedMotion: 'reduce' } })

test.describe.configure({ timeout: 120_000 })

test('menu backdrop shows a loading indicator, never the key-art plate', async ({ page }) => {
  const plateRequests: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('title-backdrop')) plateRequests.push(r.url())
  })

  await page.goto('/')

  // Up while the attract track loads. `attract-loading` is set synchronously
  // with the attract import kick-off, so it's on the body by first paint of
  // the menu; the chip itself fades in after a 700 ms grace.
  await expect(page.locator('#attract-loading')).toBeVisible({ timeout: 30_000 })

  // …and down again once the feed is live or the boot has given up. Either
  // way the player must never be left with a spinner that runs forever.
  await page.waitForFunction(() => !document.body.classList.contains('attract-loading'), null, {
    timeout: 90_000,
  })
  await expect(page.locator('#attract-loading')).toBeHidden()

  // The plate is gone for good: no fetch, no class, no CSS variable.
  expect(plateRequests).toEqual([])
  await expect(page.locator('body.backdrop-plate')).toHaveCount(0)
})
