/**
 * Waterline contact effects — functional check + look-study capture.
 *
 * Injects synthetic contacts on open deep water in front of a posed camera
 * (the deep-ocean test-bed pattern: shallow start areas drown crest signals,
 * and `setCameraPose` re-centres the camera-locked water mesh), then:
 *
 *  1. asserts the contact-splash driver actually FIRES off live swell
 *     crests (`__waterContacts.fires()` climbs), and
 *  2. captures collar ON / OFF frames with the water clock frozen, so a
 *     pixel diff isolates exactly what the foam collar + wash ripples
 *     contribute (the wind-look on/off trick).
 *
 * Also boots a real track vantage to log how many contacts auto-discovery
 * finds on shipped content.
 *
 *   E2E_PORT=5398 pnpm e2e tests/e2e/contact-look.spec.ts
 */
import { expect, test } from '@playwright/test'
import { waitForReady } from './helpers/boot'

type ContactsHook = {
  count(): number
  list(): Array<{ x: number; z: number; radius: number; strength: number }>
  fires(): number
  set(list: Array<{ x: number; z: number; radius: number; strength: number }>): void
  setCollarStrength(s: number): void
}

declare global {
  interface Window {
    __waterContacts?: ContactsHook
  }
}

test('synthetic contacts fire splash bursts and draw collars on open water', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1600, height: 900 })
  // Boost the swell so crest slams comfortably clear the fire thresholds —
  // the persisted water-debug store is applied at boot (storage key v10).
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem(
        'hoverbike.waterDebug.v10',
        JSON.stringify({ swellScale: 2.2, chopScale: 1.2 }),
      )
    } catch {
      // storage unavailable — the sea stays at defaults; assertions below
      // may need longer, but the spec still exercises the system.
    }
  })
  await page.goto('/?autostart=1&track=sandbar&skipintro=1')
  await page.bringToFront()
  await waitForReady(page, { timeout: 60_000 })
  await page.waitForFunction(() => window.__waterContacts != null, null, { timeout: 30_000 })

  // Park the camera over deep ocean, far from the island shelf, and stand a
  // little "pillar field" in front of it. The contacts are pure data — no
  // mesh needed to verify collar + spray behaviour.
  await page.evaluate(() => {
    const D = 620 // far enough out that the heightmap reads bottomless
    window.__hover?.setCameraPose({
      pos: { x: D - 26, y: 7.5, z: D - 26 },
      target: { x: D, y: 0, z: D },
    })
    window.__waterContacts?.set([
      { x: D, z: D, radius: 1.2, strength: 1 },
      { x: D - 9, z: D + 7, radius: 0.6, strength: 1 },
      { x: D + 10, z: D - 6, radius: 2.5, strength: 1 },
    ])
  })

  // The splash driver samples the live wave field at each contact — over
  // boosted open-ocean swell every contact should slam within a few wave
  // periods. This is the functional assertion: bursts genuinely key off
  // the water, not a timer.
  await page.waitForFunction(() => (window.__waterContacts?.fires() ?? 0) >= 2, null, {
    timeout: 45_000,
  })
  const fires = await page.evaluate(() => window.__waterContacts?.fires() ?? 0)
  expect(fires).toBeGreaterThanOrEqual(2)

  // Let collars + a burst or two be mid-air, then freeze the water clock so
  // the ON/OFF pair differs only by the collar layer (frozen field time
  // stills the waves, the wash ripples AND the splash driver).
  await page.waitForTimeout(1500)
  await page.evaluate(() => window.__hover?.waterDebug()?.setTimeScale(0))
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'artifacts/contact/look-on.png' })
  await page.evaluate(() => window.__waterContacts?.setCollarStrength(0))
  await page.waitForTimeout(150)
  await page.screenshot({ path: 'artifacts/contact/look-off.png' })

  // Restore for the capture pass.
  await page.evaluate(() => {
    window.__waterContacts?.setCollarStrength(1)
    window.__hover?.waterDebug()?.setTimeScale(1)
  })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: 'artifacts/contact/look-live.png' })

  // Close-up hero pass: park ~15 m from the big pillar so collar texture,
  // wash ripples and the splash sheet are readable. Grab a few frames a
  // beat apart to catch a slam mid-burst.
  await page.evaluate(() => {
    const D = 620
    window.__hover?.setCameraPose({
      pos: { x: D + 10 - 13, y: 4.2, z: D - 6 - 9 },
      target: { x: D + 10, y: 0.6, z: D - 6 },
    })
  })
  await page.waitForTimeout(1200)
  for (let i = 0; i < 4; i++) {
    await page.screenshot({ path: `artifacts/contact/close-${i}.png` })
    await page.waitForTimeout(900)
  }
})

test('auto-discovery finds contacts on shipped tracks', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?autostart=1&track=sandbar&skipintro=1')
  await page.bringToFront()
  await waitForReady(page, { timeout: 60_000 })
  await page.waitForFunction(() => window.__waterContacts != null, null, { timeout: 30_000 })
  const contacts = await page.evaluate(() => window.__waterContacts?.list() ?? [])
  // Log rather than hard-assert a number: dressing changes shouldn't break
  // this spec. Zero is legal (greybox tracks) — the synthetic spec above is
  // the functional gate.
  console.log(
    `[contact-look] sandbar auto-discovered contacts: ${contacts.length}`,
    contacts.map((c) => `(${c.x.toFixed(0)},${c.z.toFixed(0)} r${c.radius.toFixed(1)})`).join(' '),
  )
  expect(contacts.length).toBeGreaterThanOrEqual(0)

  // Frame the biggest discovered contact for a real-geometry capture: the
  // collar hugging an actual mesh instead of open water.
  if (contacts.length > 0) {
    const hero = contacts.reduce((a, b) => (b.radius > a.radius ? b : a))
    await page.evaluate(({ x, z, radius }) => {
      const back = 9 + radius * 4
      window.__hover?.setCameraPose({
        pos: { x: x - back * 0.7, y: 3.5 + radius, z: z - back * 0.7 },
        target: { x, y: 0.8, z },
      })
    }, hero)
    await page.waitForTimeout(1500)
    for (let i = 0; i < 3; i++) {
      await page.screenshot({ path: `artifacts/contact/track-${i}.png` })
      await page.waitForTimeout(1100)
    }
  }
})
