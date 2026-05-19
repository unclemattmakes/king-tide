/**
 * Step 8 — Sanity coverage for the QA matrix manifest.
 *
 * The matrix is a JSON-ish data structure read by both the orchestrator
 * (`tools/qa/runner.mjs`) and the Playwright matrix spec. If a future
 * edit accidentally drops the procedural tracks or duplicates a cell,
 * the QA pass would silently shrink — this test fails fast.
 */
import { describe, expect, it } from 'vitest'
import { enabledCells, GLOBAL_PERF_BUDGET, QA_MATRIX, SOAK_TRACKS } from '../../tools/qa/matrix.mjs'

describe('qa matrix manifest', () => {
  it('keeps both procedural tracks in the enabled set across all three bikes', () => {
    // The procedural tracks are the floor — every other QA gate assumes
    // these always run. Dropping them would silently make the QA pass
    // less useful.
    for (const bike of ['cruiser', 'racer', 'stunt']) {
      for (const id of ['lagoon', 'cliffside']) {
        expect(QA_MATRIX.find((c) => c.id === id && c.bike === bike)).toBeDefined()
      }
    }
  })

  it('has no duplicate (track, bike) cells', () => {
    const seen = new Set<string>()
    for (const c of QA_MATRIX) {
      const key = `${c.id}::${c.bike}`
      expect(seen.has(key), `duplicate cell ${key}`).toBe(false)
      seen.add(key)
    }
  })

  it('enabledCells returns only cells with enabled=true', () => {
    const cells = enabledCells()
    expect(cells.length).toBeGreaterThan(0)
    for (const c of cells) expect(c.enabled).toBe(true)
    // Drowned cup tracks are not yet shipped — they should be disabled.
    for (const c of cells) {
      expect(['aqualand', 'angkor-drowned', 'liberty-drowned']).not.toContain(c.id)
    }
  })

  it('exposes a reasonable global perf budget', () => {
    expect(GLOBAL_PERF_BUDGET.fpsFloor).toBeGreaterThanOrEqual(30)
    expect(GLOBAL_PERF_BUDGET.p95CeilingMs).toBeGreaterThan(0)
    expect(GLOBAL_PERF_BUDGET.p95CeilingMs).toBeLessThanOrEqual(100)
  })

  it('defines at least one soak cell with a non-trivial duration', () => {
    expect(SOAK_TRACKS.length).toBeGreaterThan(0)
    for (const c of SOAK_TRACKS) {
      expect(c.durationSec).toBeGreaterThanOrEqual(30)
    }
  })
})
