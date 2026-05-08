import { expect, test } from '@playwright/test'

/**
 * The decision logic in `shouldAIFire` is exhaustively unit-tested. This
 * e2e is the integration check: with the full system wired up, an AI
 * actually fires when handed a pickup it should fire (shield's "always
 * fire" gate is the easiest to land deterministically — no positional or
 * line-shape preconditions needed).
 */
test('AI fires shield within a few seconds of being handed one', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
    timeout: 10000,
  })

  const aiEid = await page.evaluate(() => {
    const playerEid = window.__hover!.playerEid()
    const aiBike = window.__hover!.bikes().find((b) => b.eid !== playerEid)
    return aiBike?.eid ?? -1
  })
  expect(aiEid).toBeGreaterThan(0)

  await page.evaluate((eid) => {
    window.__hover!.setBikeHeldPickup(eid, 'shield')
  }, aiEid)

  // Shield is "fire whenever held" — should empty the slot in well under
  // a second. (combatEntityCounts has no shield counter; rely on the
  // slot transition.)
  await page.waitForFunction(
    (eid) => {
      const me = window.__hover!.bikes().find((b) => b.eid === eid)
      return me?.held === null
    },
    aiEid,
    { timeout: 3000 },
  )
})
