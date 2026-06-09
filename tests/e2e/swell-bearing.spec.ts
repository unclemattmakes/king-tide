/**
 * Track-authored swell bearing — P0.3 of docs/water-next-research.md (§4.5).
 *
 * The global wave bearing used to be debug-menu state persisted in
 * localStorage, silently re-aiming every track's swell on that machine. Now
 * it's per-track authoring (`water.swellBearingDeg`, falling back to
 * WAVE_BEARING_DEFAULT = 47°) and the stored value is ignored. This spec
 * pins both halves:
 *
 *  1. A stale v10 localStorage entry carrying `waveBearing` must NOT win —
 *     boot lands on the default 47°.
 *  2. A track JSON authoring `swellBearingDeg` must win — asserted by
 *     intercepting the track fetch and injecting the key, so no shipped
 *     JSON needs a non-default bearing for the test to exist.
 *
 * lagoon-edit: open water, no zones — nothing else fights the bearing.
 */
import { expect, test } from '@playwright/test'
import { waitForReady } from './helpers/boot'

const STORAGE_KEY = 'hoverbike.waterDebug.v10'

test('stale localStorage waveBearing is ignored — boot lands on the 47° default', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.addInitScript(
    ([key]) => {
      // Shape of a real pre-P0.3 v10 entry: tuning keys + the now-removed
      // waveBearing. The per-key tolerant loader must skip the dead key.
      window.localStorage.setItem(
        key as string,
        JSON.stringify({ waveBearing: -120, steepness: 0.44, swellScale: 3.2 }),
      )
    },
    [STORAGE_KEY],
  )
  await page.goto('/?autostart=1&track=lagoon-edit&skipintro=1')
  await waitForReady(page, { timeout: 60_000 })
  const bearing = await page.evaluate(() => window.__hover!.waterDebug()!.getWaveBearing())
  expect(bearing).toBe(47)
})

test('water.swellBearingDeg in the track JSON aims the swell train', async ({ page }) => {
  test.setTimeout(120_000)
  await page.route('**/tracks/lagoon-edit.json', async (route) => {
    const response = await route.fetch()
    const body = JSON.parse(await response.text()) as { water?: Record<string, unknown> }
    body.water = { ...(body.water ?? { height: 0 }), swellBearingDeg: -30 }
    await route.fulfill({ response, body: JSON.stringify(body) })
  })
  await page.goto('/?autostart=1&track=lagoon-edit&skipintro=1')
  await waitForReady(page, { timeout: 60_000 })
  const bearing = await page.evaluate(() => window.__hover!.waterDebug()!.getWaveBearing())
  expect(bearing).toBe(-30)
})
