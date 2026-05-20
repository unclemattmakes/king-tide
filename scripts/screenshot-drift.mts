import { chromium } from '@playwright/test'

/**
 * Local-sandbox drift-FX screenshotter. Drives the bike around the
 * `drift-test` map via `setIntentOverride`, captures stills at key
 * tier transitions, and prints the per-stage drift state so it can be
 * visually verified. Not part of CI — used in dev sessions where a
 * full Playwright run isn't viable but a focused before/after image
 * is. Requires a running dev server on :5391 and a pre-installed
 * Chromium binary at the path below (override via $CHROME).
 */

const exe = process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const baseURL = process.env.BASE_URL ?? 'http://localhost:5391'

const browser = await chromium.launch({ executablePath: exe, headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
const page = await ctx.newPage()

page.on('pageerror', (e) => console.log(`[err] ${e.message}`))

await page.goto(`${baseURL}/?autostart=1&track=drift-test`)
await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, { timeout: 20_000 })
console.log('boot complete')

// Stage 1 — drive forward until at drift-floor speed.
await page.evaluate(() =>
  window.__hover!.setIntentOverride({
    throttle: 1,
    steer: 0,
    brake: 0,
    fire: false,
    boost: false,
    pitch: 0,
    trickLeft: false,
    trickRight: false,
  }),
)
await page.waitForFunction(() => (window.__hover?.player()?.speed ?? 0) > 9, { timeout: 10_000 })
console.log('at speed')
await page.screenshot({ path: '/tmp/drift-before.png' })

// Stage 2 — press trickLeft + steer LEFT. Matches the natural racing
// line through cp1 (NE corner) so the bike stays on the plate.
await page.evaluate(() =>
  window.__hover!.setIntentOverride({
    throttle: 1,
    steer: -0.9,
    brake: 0,
    fire: false,
    boost: false,
    pitch: 0,
    trickLeft: true,
    trickRight: false,
  }),
)

await page.waitForFunction(() => window.__hover?.driftState().active === true, {
  timeout: 8_000,
  polling: 'raf',
})
const activated = await page.evaluate(() => ({
  drift: window.__hover!.driftState(),
  player: window.__hover!.player(),
}))
console.log('drift active:', JSON.stringify(activated))

// Diagnostic — sample every 50 ms for 3 s so we can see exactly when
// the drift breaks and why (speed crashed, airborne, etc).
const trail: Array<{ t: number; active: boolean; charge: number; armed: number; speed: number; vy: number; grnd: boolean }> = []
const trailStart = Date.now()
for (let i = 0; i < 60; i++) {
  const s = await page.evaluate(() => {
    const d = window.__hover!.driftState()
    const p = window.__hover!.player()!
    return {
      active: d.active,
      charge: d.chargeSec,
      armed: d.armedButton,
      speed: p.speed,
      vy: p.velocity.y,
      grnd: p.isGrounded,
    }
  })
  trail.push({ t: (Date.now() - trailStart) / 1000, ...s })
  if (s.active && s.charge >= 1.2) break
  await new Promise((r) => setTimeout(r, 50))
}
console.log(
  'drift trail:\n' +
    trail
      .map(
        (s) =>
          `t=${s.t.toFixed(2)} active=${s.active} armed=${s.armed} charge=${s.charge.toFixed(3)} ` +
          `speed=${s.speed.toFixed(1)} vy=${s.vy.toFixed(2)} grnd=${s.grnd}`,
      )
      .join('\n'),
)
const d1 = await page.evaluate(() => window.__hover!.driftState())
console.log('post-trail drift state:', JSON.stringify(d1))
await page.screenshot({ path: '/tmp/drift-tier1.png' })

// Tier-2 charge.
for (let i = 0; i < 20; i++) {
  const c = await page.evaluate(() => window.__hover!.driftState().chargeSec)
  if (c >= 2.6) break
  await new Promise((r) => setTimeout(r, 100))
}
const d2 = await page.evaluate(() => window.__hover!.driftState())
console.log('tier-2 charge:', JSON.stringify(d2))
await page.screenshot({ path: '/tmp/drift-tier2.png' })

// Release.
await page.evaluate(() =>
  window.__hover!.setIntentOverride({
    throttle: 1,
    steer: -0.9,
    brake: 0,
    fire: false,
    boost: false,
    pitch: 0,
    trickLeft: false,
    trickRight: false,
  }),
)
await new Promise((r) => setTimeout(r, 200))
const release = await page.evaluate(() => ({
  drift: window.__hover!.driftState(),
  boost: window.__hover!.playerBoostEffect(),
}))
console.log('after release:', JSON.stringify(release))
await page.screenshot({ path: '/tmp/drift-release.png' })

await browser.close()
