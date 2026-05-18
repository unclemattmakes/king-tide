import { expect, test } from '@playwright/test'

/**
 * Tiny boot smoke test that runs on every browser project (Chromium,
 * Firefox, WebKit). The goal is "did the menu HTML render and the
 * document title come up?" — we deliberately don't touch WebGL/WebGPU,
 * AudioContext, or physics here so the test stays green on WebKit-Linux
 * (which has no real GPU). The bigger GPU-bound suites carry their own
 * skip guards.
 *
 * See docs/cross-browser.md for the supported-browsers matrix and how
 * to opt into the multi-browser run (`E2E_BROWSERS=all pnpm e2e`).
 */
test.describe('cross-browser boot smoke', () => {
  test('title screen renders with correct document title', async ({ page }, testInfo) => {
    await page.goto('/')

    // Pulled from menu-flow.spec.ts — `#title-start` is the stable
    // entry-point selector for the title screen mode-select tile.
    const title = page.locator('#title-start')
    await expect(title).toBeVisible({ timeout: 10_000 })

    // Document title is set in index.html.
    const docTitle = await page.title()
    expect(docTitle).toBe('Hoverbike')

    // Body gets the menu-active class so HUD chrome stays hidden — same
    // assertion menu-flow.spec.ts uses; cheap proof the boot path ran.
    const bodyClass = await page.evaluate(() => document.body.classList.contains('menu-active'))
    expect(bodyClass).toBe(true)

    // Attach a screenshot to the trace so cross-browser visual regressions
    // are at least eyeballable from the report.
    await testInfo.attach('title-screen.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    })
  })
})
