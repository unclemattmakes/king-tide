/**
 * RTT tracker — EWMA smoothing + stale-out behavior.
 *
 * Verified independently of the WebSocket layer so a regression in
 * smoothing constants or stale-window math is caught without spinning
 * up partysocket / partykit.
 */
import { describe, expect, it } from 'vitest'
import { createLatencyTracker, LATENCY_STALE_MS } from '../../src/engine/net/latency'

describe('createLatencyTracker', () => {
  it('returns -1 before any samples are recorded', () => {
    const tr = createLatencyTracker()
    expect(tr.current(0)).toBe(-1)
    expect(tr.sampleCount).toBe(0)
  })

  it('reports the first sample exactly (no prior estimate to blend with)', () => {
    const tr = createLatencyTracker()
    tr.record(42, 0)
    expect(tr.current(0)).toBe(42)
    expect(tr.sampleCount).toBe(1)
  })

  it('blends subsequent samples via EWMA (newest weighted at alpha)', () => {
    const tr = createLatencyTracker()
    tr.record(100, 0)
    tr.record(0, 100)
    // alpha=0.25 → 100 + 0.25*(0-100) = 75
    expect(tr.current(100)).toBeCloseTo(75)
    tr.record(0, 200)
    // 75 + 0.25*(0-75) = 56.25
    expect(tr.current(200)).toBeCloseTo(56.25)
  })

  it('clamps negative inputs to 0 (defensive — RTT can never be negative)', () => {
    const tr = createLatencyTracker()
    tr.record(-50, 0)
    expect(tr.current(0)).toBe(0)
  })

  it('settles toward a sustained step within ~10 samples', () => {
    const tr = createLatencyTracker()
    tr.record(30, 0)
    // Sustained jump from 30ms to 90ms — should converge within ~10 ticks.
    for (let i = 1; i <= 10; i++) tr.record(90, i * 1000)
    const settled = tr.current(10_000)
    expect(settled).toBeGreaterThan(85)
    expect(settled).toBeLessThanOrEqual(90)
  })

  it('stale-resets to -1 when the most recent sample is older than LATENCY_STALE_MS', () => {
    const tr = createLatencyTracker()
    tr.record(50, 1000)
    expect(tr.current(1000)).toBe(50)
    expect(tr.current(1000 + LATENCY_STALE_MS)).toBe(50) // exactly at boundary still ok
    expect(tr.current(1000 + LATENCY_STALE_MS + 1)).toBe(-1)
  })

  it('refreshes the stale window each time a new sample arrives', () => {
    const tr = createLatencyTracker()
    tr.record(50, 0)
    tr.record(50, LATENCY_STALE_MS - 10)
    // The second sample is recent enough to keep us live.
    expect(tr.current(LATENCY_STALE_MS - 10)).toBe(50)
    // Even at what would have been the stale boundary from sample-1.
    expect(tr.current(LATENCY_STALE_MS + 1)).toBe(50)
  })

  it('reset() clears the running average + the sample count', () => {
    const tr = createLatencyTracker()
    tr.record(80, 0)
    tr.record(80, 1000)
    expect(tr.sampleCount).toBe(2)
    tr.reset()
    expect(tr.current(2000)).toBe(-1)
    expect(tr.sampleCount).toBe(0)
    // After reset, the next sample is taken as-is (no carry-over).
    tr.record(20, 3000)
    expect(tr.current(3000)).toBe(20)
  })
})
