/**
 * Sim-equivalence snapshot gate (wave-zone GPU port + every future water PR).
 *
 * Boots `?determinism=1` (frozen live loop), steps the sim 600 ticks with a
 * fixed scripted intent via the determinism harness, and captures the final
 * snapshot string. Two roles:
 *
 *   - zone-less track (`lagoon`): GOLDEN-COMPARED. A committed golden lives at
 *     `tests/e2e/fixtures/determinism/lagoon.txt`. If it exists we assert the
 *     fresh snapshot is byte-identical (a mismatch FAILS the run — the sim
 *     changed where no wave zones exist, which a water-shader PR must never
 *     do). If it's absent (or `UPDATE_GOLDEN=1`), we write/refresh it instead
 *     of asserting — that's the seed path, see the note at the bottom.
 *   - zone track (`sandbar`): write-only. Expected to differ legitimately as
 *     the Gerstner inverse map folds zone factors in, so we dump it to
 *     `artifacts/determinism/` for a manual cross-branch diff rather than
 *     gating on it.
 *
 * "Did the sim change?" is the first question every future water-shader PR has
 * to answer; the lagoon golden answers it automatically.
 *
 * SEEDING THE GOLDEN (one-time, on a real GPU machine — the snapshot is
 * GPU-determined and cannot be authored by hand):
 *   UPDATE_GOLDEN=1 pnpm e2e determinism-snapshot
 * then commit `tests/e2e/fixtures/determinism/lagoon.txt`. Until it's seeded
 * the lagoon case runs in WRITE mode and won't catch a regression.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const TAG = process.env.WAVE_SYNC_TAG ?? 'now'
const OUT_DIR = 'artifacts/determinism'

// Goldens live next to the spec so the compare is cwd-independent (the e2e
// run's cwd is the repo root, but resolving from the spec is robust either way).
const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN_DIR = path.resolve(SPEC_DIR, 'fixtures', 'determinism')

// Force (re)writing the golden instead of asserting against it.
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1'

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

// `golden` → byte-compared against a committed fixture (zone-less, stable).
// `artifact` → dumped for a manual cross-branch diff (zone track, expected to
// drift legitimately).
const TRACKS: Array<{ id: string; mode: 'golden' | 'artifact' }> = [
  { id: 'lagoon', mode: 'golden' },
  { id: 'sandbar', mode: 'artifact' },
]

for (const { id, mode } of TRACKS) {
  test(`${id}: 600-tick deterministic snapshot dump`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto(`/?determinism=1&track=${id}`)
    await page.waitForFunction(() => window.__hover?.determinism?.ready === true, null, {
      timeout: 60_000,
    })
    const end = await page.evaluate(
      ({ intent, ticks }) => window.__hover!.determinism!.run([intent], ticks),
      { intent: SCRIPTED_INTENT, ticks: TICKS },
    )
    expect(end.length).toBeGreaterThan(0)

    if (mode === 'golden') {
      mkdirSync(GOLDEN_DIR, { recursive: true })
      const goldenPath = path.join(GOLDEN_DIR, `${id}.txt`)
      if (UPDATE_GOLDEN || !existsSync(goldenPath)) {
        // Seed / refresh mode — write the golden, don't assert. The followup
        // note in the header explains when this path is expected.
        writeFileSync(goldenPath, end)
        console.log(
          `determinism-snapshot:${id}: ${UPDATE_GOLDEN ? 'refreshed' : 'seeded'} golden at ${goldenPath} (${end.length} bytes) — commit it to enable the regression gate.`,
        )
        return
      }
      // Compare mode — byte-equality with the committed golden. A mismatch
      // means the sim changed on a zone-less track, which is the regression
      // this gate exists to catch.
      const golden = readFileSync(goldenPath, 'utf8')
      expect(
        end,
        `${id}: 600-tick snapshot drifted from the committed golden (${goldenPath}). The sim changed on a zone-less track — a water-shader PR must not touch the sim here. If this change is intentional, reseed with UPDATE_GOLDEN=1 pnpm e2e determinism-snapshot and commit the golden.`,
      ).toBe(golden)
      return
    }

    // artifact mode — dump for a manual cross-branch diff.
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(`${OUT_DIR}/${TAG}-${id}.txt`, end)
  })
}
