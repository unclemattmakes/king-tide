import { expect, test } from '@playwright/test'

test.describe('M3 race', () => {
  test('lap counter starts at 1, advances after crossing all checkpoints', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => window.__hover?.race() !== null, { timeout: 10000 })

    const initial = await page.evaluate(() => window.__hover!.race()!)
    expect(initial.lap).toBe(1)
    expect(initial.lapsToFinish).toBeGreaterThanOrEqual(1)
    expect(initial.nextCheckpoint).toBe(0)
    expect(initial.totalCheckpoints).toBeGreaterThan(0)
    expect(initial.checkpointsCrossed).toBe(0)
    expect(initial.finished).toBe(false)
  })

  test('crossing the start gate advances to next checkpoint without incrementing lap', async ({
    page,
  }) => {
    await page.goto('/')
    await page.waitForFunction(() => window.__hover?.race() !== null, { timeout: 10000 })

    // Drive forward — crosses cp 0 (start/finish line).
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

    await page.waitForFunction(() => (window.__hover?.race()?.checkpointsCrossed ?? 0) > 0, {
      timeout: 8000,
    })

    const after = await page.evaluate(() => window.__hover!.race()!)
    expect(after.checkpointsCrossed).toBeGreaterThan(0)
    expect(after.lap).toBe(1) // first cp 0 crossing starts lap 1, doesn't advance it
    expect(after.nextCheckpoint).toBe(1)

    await page.evaluate(() => window.__hover!.setIntentOverride(null))
  })

  test('checkpoints not in front are not counted', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => window.__hover?.race() !== null, { timeout: 10000 })

    // Reverse — bike should NOT cross any checkpoint behind it.
    await page.evaluate(() =>
      window.__hover!.setIntentOverride({
        throttle: -1,
        steer: 0,
        brake: 0,
        fire: false,
        boost: false,
        pitch: 0,
      }),
    )

    await page.waitForTimeout(2000)

    const after = await page.evaluate(() => window.__hover!.race()!)
    expect(after.checkpointsCrossed).toBe(0)
    expect(after.lap).toBe(1)

    await page.evaluate(() => window.__hover!.setIntentOverride(null))
  })
})
