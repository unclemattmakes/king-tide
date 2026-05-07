import { expect, test } from '@playwright/test'

test.describe('M6 auto-play', () => {
  test('toggling auto-play makes the AI drive the player', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 10000,
    })

    expect(await page.evaluate(() => window.__hover!.isAutoPlay())).toBe(false)

    await page.evaluate(() => window.__hover!.toggleAutoPlay())
    expect(await page.evaluate(() => window.__hover!.isAutoPlay())).toBe(true)

    // Drive autonomously for 8 seconds. AI should make progress through cp 0.
    const samples: { t: number; x: number; z: number; cp: number; thr: number }[] = []
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1000)
      const sample = await page.evaluate(() => {
        const p = window.__hover!.player()!
        const r = window.__hover!.race()!
        const eid = window.__hover!.playerEid()!
        const me = window.__hover!.bikes().find((b) => b.eid === eid)!
        return {
          t: Math.round(r.raceTime * 10) / 10,
          x: Math.round(p.position.x * 10) / 10,
          z: Math.round(p.position.z * 10) / 10,
          vx: Math.round(p.velocity.x * 10) / 10,
          vz: Math.round(p.velocity.z * 10) / 10,
          cp: r.nextCheckpoint,
          thr: Math.round(me.intent.throttle * 100) / 100,
          steer: Math.round(me.intent.steer * 100) / 100,
        }
      })
      samples.push(sample)
    }

    // Stay reasonably bounded (track loop is roughly within ±100m).
    const lastSample = samples[samples.length - 1]!
    expect(Math.abs(lastSample.x)).toBeLessThan(150)
    expect(Math.abs(lastSample.z)).toBeLessThan(150)

    // Should have moved meaningfully from spawn.
    const dist = Math.hypot(lastSample.x, lastSample.z - 20)
    expect(dist).toBeGreaterThan(15)

    // Print trajectory for debugging.
    // biome-ignore lint/suspicious/noConsole: diagnostic
    console.log('autoplay trajectory:', JSON.stringify(samples, null, 0))
  })
})
