/**
 * Full-field (8-bike) completion probe — the Reef Cup vertical-slice gate
 * "the whole field finishes, no AI jam" (reef-cup-vertical-slice-status.md
 * cross-cut #3). The recurring jam class is a gate floating above raised
 * terrain or facing crosswise to the race line: the field piles up at one
 * checkpoint and never advances past it.
 *
 * For each track we spawn the full grid (`?ai=7` → player + 7 = 8), hand the
 * player to the AI too (autoplay) so all eight are AI-driven, then poll
 * `__hover.standings()` (per-bike lap + nextCheckpoint for every Racer) and
 * require EVERY bike to advance a full lap's worth of checkpoints. A jammed
 * bike stalls at one checkpoint and trips the timeout, and the failure
 * message names the stuck bike + where it stuck.
 *
 * Gated on FIELD_CHECK=1 so `pnpm e2e` stays fast. Run via:
 *   FIELD_CHECK=1 E2E_PORT=5399 pnpm exec playwright test field-completion --project=chromium --workers=1
 */
import { expect, test } from '@playwright/test'
import { waitForReady } from './helpers/boot'

const TRACKS = (process.env.FIELD_CHECK_TRACKS ?? 'sandbar,mexico-city,cape-town-drift')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const EXPECTED_FIELD = 8 // player + 7 AI (NUM_AI)

test.describe('full-field completion', () => {
  test.skip(process.env.FIELD_CHECK !== '1', 'gated on FIELD_CHECK=1')
  test.describe.configure({ mode: 'serial' })

  for (const id of TRACKS) {
    test(`${id}: all 8 bikes complete a lap (no jam)`, async ({ page }) => {
      test.setTimeout(240_000)

      await page.goto(`/?autostart=1&track=${id}&ai=7`)
      await waitForReady(page, { timeout: 60_000 })

      // All eight AI-driven so the probe tests the field uniformly.
      await page.evaluate(() => {
        if (!window.__hover!.isAutoPlay()) window.__hover!.toggleAutoPlay()
      })

      // Checkpoint count (N) and the field roster.
      const { n, count } = await page.evaluate(() => {
        const r = window.__hover!.race()
        return { n: r?.totalCheckpoints ?? 0, count: window.__hover!.standings().length }
      })
      expect(n, 'track has checkpoints').toBeGreaterThan(0)
      expect(count, `expected full ${EXPECTED_FIELD}-bike field`).toBe(EXPECTED_FIELD)

      const progressByEid = (s: { eid: number; lap: number; nextCheckpoint: number }) =>
        s.lap * n + s.nextCheckpoint

      // Baseline progress per bike right after the gun.
      const initial = await page.evaluate(() => window.__hover!.standings())
      const base = new Map<number, number>(initial.map((s) => [s.eid, progressByEid(s)]))

      // Poll until the SLOWEST bike has advanced a full lap of checkpoints
      // (delta ≥ N), or bail out at the timeout with diagnostics.
      let allLapped = false
      let last: ReturnType<typeof computeDeltas> | null = null
      function computeDeltas(
        standings: Array<{ eid: number; lap: number; nextCheckpoint: number }>,
      ) {
        return standings.map((s) => ({
          eid: s.eid,
          lap: s.lap,
          nextCp: s.nextCheckpoint,
          delta: progressByEid(s) - (base.get(s.eid) ?? 0),
        }))
      }

      for (let i = 0; i < 110; i++) {
        await page.waitForTimeout(2000)
        const standings = await page.evaluate(() => window.__hover!.standings())
        last = computeDeltas(standings)
        const minDelta = Math.min(...last.map((d) => d.delta))
        if (minDelta >= n) {
          allLapped = true
          break
        }
      }

      const rows = (last ?? [])
        .sort((a, b) => a.delta - b.delta)
        .map((d) => `eid=${d.eid} lap=${d.lap} nextCp=${d.nextCp} advanced=${d.delta}/${n}`)
      // biome-ignore lint/suspicious/noConsole: diagnostic
      console.log(`field-completion:${id}:\n  ${rows.join('\n  ')}`)

      const slowest = last ? last.reduce((a, b) => (a.delta < b.delta ? a : b)) : null
      expect(
        allLapped,
        `${id}: not all bikes completed a lap — slowest eid=${slowest?.eid} stuck at checkpoint ${slowest?.nextCp} (advanced ${slowest?.delta}/${n}). Likely an AI jam at that gate.`,
      ).toBe(true)
    })
  }
})
