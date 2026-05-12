import { expect, test } from '@playwright/test'

/**
 * AI lap-completion probe. The bar previous to the curvature-aware AI
 * controller (M9.15) was lap completion below 50% over a 30s autoplay
 * window — the AI overshot the chord-spline corners at cp 1 / cp 4 and
 * spent most of its time recovering. The smooth-arc spline + look-ahead
 * curvature braking fix that.
 *
 * This spec drives autoplay (AI controlling the player) on the default
 * Lagoon Loop / racer bike and asserts the AI completes a full lap (≥10
 * checkpoint crossings: cp 0 to start, cps 1..8, then cp 0 again). To
 * stay robust under parallel-CPU contention (4 Playwright workers can
 * drop wall-clock fps to ~10, slowing sim time accordingly), we poll for
 * the milestone rather than sampling for a fixed wall-clock duration.
 *
 * On a clean run the AI hits cps≥10 in ~24s game time (~25s wall-clock).
 * Under parallel load it can take 60s+ wall-clock to accumulate the
 * same game time, so the timeout is generous.
 */
test.describe('M9 AI cornering — lap completion', () => {
  test('autoplay completes a full lap on Lagoon (parallel-load tolerant)', async ({ page }) => {
    test.setTimeout(180_000)

    await page.goto('/?autostart=1')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 15000,
    })
    await page.evaluate(() => window.__hover!.toggleAutoPlay())
    expect(await page.evaluate(() => window.__hover!.isAutoPlay())).toBe(true)

    type Sample = {
      t: number
      x: number
      z: number
      speed: number
      lap: number
      cpsCrossed: number
      nextCp: number
    }
    const samples: Sample[] = []
    let lapDone = false

    // Poll up to 120s wall-clock — generous so parallel CPU contention
    // doesn't false-fail. Bail early as soon as we hit one full lap.
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(2000)
      const sample = await page.evaluate(() => {
        const p = window.__hover!.player()!
        const r = window.__hover!.race()!
        const speed = Math.hypot(p.velocity.x, p.velocity.z)
        return {
          t: Math.round(r.raceTime * 10) / 10,
          x: Math.round(p.position.x * 10) / 10,
          z: Math.round(p.position.z * 10) / 10,
          speed: Math.round(speed * 10) / 10,
          lap: r.lap,
          cpsCrossed: r.checkpointsCrossed,
          nextCp: r.nextCheckpoint,
        }
      })
      samples.push(sample)
      if (sample.cpsCrossed >= 10) {
        lapDone = true
        break
      }
    }

    const last = samples[samples.length - 1]!

    // biome-ignore lint/suspicious/noConsole: diagnostic
    console.log(
      'AI lap-completion trajectory (sampled every 2s wall-clock):',
      samples
        .map(
          (s) =>
            `t=${s.t} pos=(${s.x},${s.z}) v=${s.speed} lap=${s.lap} cps=${s.cpsCrossed} nextCp=${s.nextCp}`,
        )
        .join('\n'),
    )

    expect(
      lapDone,
      `AI did not complete a full lap before 120s wall-clock (last cps=${last.cpsCrossed}, gameTime=${last.t}s)`,
    ).toBe(true)
  })
})
