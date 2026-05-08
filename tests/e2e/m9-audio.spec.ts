import { expect, test } from '@playwright/test'

/**
 * Audio is procedurally synthesised in src/engine/audio/audio.ts and
 * lazy-inits its AudioContext on first user gesture. We can't easily
 * inspect raw audio output from headless Chrome, so the contract this
 * test guards is the observable surface:
 *   - HUD shows the audio state (on / muted)
 *   - M key toggles mute
 *   - boot is clean (no console errors / page errors from the audio module)
 */
test('audio HUD + M-key mute toggle, no errors at boot', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  })

  await page.goto('/')
  await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
    timeout: 10000,
  })

  // Drive a beat so the engine-tick code path actually runs (otherwise
  // it would be valid for it to be a hot-reload no-op). Nothing to assert
  // on the sound itself — the assertion is "no errors" below.
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
  await page.waitForTimeout(800)

  // HUD should render the audio status text.
  const audioText = await page.locator('#hud-audio').textContent()
  expect(audioText).toMatch(/^audio: /)
  expect(audioText).toContain('on') // unmuted by default

  // Press M — mute toggles.
  await page.keyboard.press('KeyM')
  // The HUD only refreshes every 500ms, so wait a beat.
  await page.waitForFunction(
    () => document.getElementById('hud-audio')?.textContent?.includes('muted'),
    { timeout: 1500 },
  )

  // Press M again — back to on.
  await page.keyboard.press('KeyM')
  await page.waitForFunction(
    () => {
      const t = document.getElementById('hud-audio')?.textContent ?? ''
      return t.includes('on') && !t.includes('muted')
    },
    { timeout: 1500 },
  )

  expect(errors, errors.join('\n')).toEqual([])
})
