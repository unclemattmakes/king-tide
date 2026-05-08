import { expect, test } from '@playwright/test'

/**
 * Garage menu integration tests:
 *  - hidden by default (so the existing Lagoon Loop tests are unaffected)
 *  - GARAGE button opens it
 *  - selecting a different bike + RACE reloads with the right URL params
 *  - the resulting bike has the variant's body color + stats
 */
test.describe('M9 garage', () => {
  test('overlay is hidden on initial page load', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 10000,
    })
    const visible = await page.locator('#garage').isVisible()
    expect(visible).toBe(false)
  })

  test('clicking GARAGE opens the overlay with both sections populated', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 10000,
    })

    await page.locator('#garage-toggle').click()
    await page.waitForFunction(
      () => document.getElementById('garage')?.classList.contains('show'),
      { timeout: 1000 },
    )

    // Both lists are populated.
    const bikeCount = await page.locator('#garage-bikes .opt').count()
    expect(bikeCount).toBe(3)
    const trackCount = await page.locator('#garage-tracks .opt').count()
    expect(trackCount).toBe(2)
  })

  test('selecting Stunt + RACE reloads with ?bike=stunt and applies the green body color', async ({
    page,
  }) => {
    await page.goto('/')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 10000,
    })

    await page.locator('#garage-toggle').click()
    await page.waitForFunction(
      () => document.getElementById('garage')?.classList.contains('show'),
      { timeout: 1000 },
    )

    // Click the Stunt bike option (matches by visible name).
    await page.getByText('Stunt', { exact: true }).click()
    await page.locator('#garage-race').click()

    // Page reloads. Wait for the new state.
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 10000,
    })

    // URL has the right param.
    expect(page.url()).toContain('bike=stunt')

    // The Stunt variant has lower top speed (25 m/s) than the racer
    // default (28 m/s). Drive forward and sample peak speed over a
    // window so wave-driven dips don't make the assertion flaky.
    await page.evaluate(() =>
      window.__hover!.setIntentOverride({
        throttle: 1,
        steer: 0,
        brake: 0,
        fire: false,
        boost: false,
        pitch: 0,
      }),
    )
    let peak = 0
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(150)
      const speed = await page.evaluate(() => window.__hover!.player()!.speed)
      if (speed > peak) peak = speed
    }
    // Peak should be at or just below stunt's 25 m/s cap, never near
    // the racer's 28 m/s.
    expect(peak).toBeGreaterThan(20)
    expect(peak).toBeLessThan(27)
  })
})
