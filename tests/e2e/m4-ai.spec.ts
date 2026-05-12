import { expect, test } from '@playwright/test'

test.describe('M4 AI', () => {
  test('AI bikes spawn and move forward from spawn under their own control', async ({ page }) => {
    await page.goto('/?autostart=1')
    await page.waitForFunction(() => (window.__hover?.bikes().length ?? 0) > 1, {
      timeout: 10000,
    })

    const initialBikes = await page.evaluate(() => window.__hover!.bikes())
    // Player + 4 AI = 5 bikes total.
    expect(initialBikes.length).toBe(5)

    const playerEid = await page.evaluate(() => window.__hover!.playerEid())
    const aiBikes = initialBikes.filter((b) => b.eid !== playerEid)
    expect(aiBikes.length).toBe(4)

    // Cache spawn positions per AI eid.
    const spawnByEid = new Map<number, { x: number; z: number }>()
    for (const b of aiBikes) spawnByEid.set(b.eid, { x: b.pos.x, z: b.pos.z })

    // Wait for AI to drive for a few seconds.
    await page.waitForTimeout(5000)

    const laterBikes = await page.evaluate(() => window.__hover!.bikes())
    const laterAi = laterBikes.filter((b) => b.eid !== playerEid)

    // At least one AI bike should have moved meaningfully (>= 20m) from spawn.
    const movements = laterAi.map((b) => {
      const start = spawnByEid.get(b.eid)!
      return Math.hypot(b.pos.x - start.x, b.pos.z - start.z)
    })
    const maxMove = Math.max(...movements)
    expect(maxMove).toBeGreaterThan(20)

    // AI bikes have nonzero throttle in their intent.
    const throttling = laterAi.filter((b) => Math.abs(b.intent.throttle) > 0.1).length
    expect(throttling).toBe(4) // every AI bike is engaged
  })

  test('standings include all racers (player + AI)', async ({ page }) => {
    await page.goto('/?autostart=1')
    await page.waitForFunction(() => (window.__hover?.standings().length ?? 0) >= 5, {
      timeout: 10000,
    })

    const standings = await page.evaluate(() => window.__hover!.standings())
    expect(standings.length).toBe(5)
    // Position values are 1..5, contiguous
    const positions = standings.map((s) => s.position).sort((a, b) => a - b)
    expect(positions).toEqual([1, 2, 3, 4, 5])
  })
})
