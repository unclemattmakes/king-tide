/**
 * One-off cross-branch sim-equivalence probe (wave-zone GPU port).
 *
 * Boots `?determinism=1` (frozen live loop), steps the sim 600 ticks with a
 * fixed scripted intent via the determinism harness, and writes the final
 * snapshot string to `artifacts/determinism/<TAG>-<track>.txt`. Run once on
 * the implementation branch and once on pristine HEAD (same TRACKS), then
 * diff the files:
 *
 *   - zone-less track (lagoon): MUST be byte-identical — proves the zone
 *     port leaves the sim untouched where no zones exist.
 *   - zone track (sandbar): expected to differ ONLY via the Gerstner
 *     inverse map now folding zone factors in (buoyancy floats on the
 *     zone-displaced surface) — the intended CPU-side fix.
 *
 * Kept as a checked-in harness because "did the sim change?" is the first
 * question every future water-shader PR has to answer.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const TAG = process.env.WAVE_SYNC_TAG ?? 'now'
const OUT_DIR = 'artifacts/determinism'

const SCRIPTED_INTENT = {
  throttle: 1,
  steer: 0.25,
  brake: 0,
  fire: false,
  boost: false,
  pitch: 0,
  trickLeft: false,
  trickRight: false,
}

const TICKS = 600 // 10 s at the 60 Hz fixed step

for (const track of ['lagoon', 'sandbar']) {
  test(`${track}: 600-tick deterministic snapshot dump`, async ({ page }) => {
    test.setTimeout(120_000)
    mkdirSync(OUT_DIR, { recursive: true })
    await page.goto(`/?determinism=1&track=${track}`)
    await page.waitForFunction(() => window.__hover?.determinism?.ready === true, null, {
      timeout: 60_000,
    })
    const end = await page.evaluate(
      ({ intent, ticks }) => window.__hover!.determinism!.run([intent], ticks),
      { intent: SCRIPTED_INTENT, ticks: TICKS },
    )
    expect(end.length).toBeGreaterThan(0)
    writeFileSync(`${OUT_DIR}/${TAG}-${track}.txt`, end)
  })
}
