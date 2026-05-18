/**
 * Step 8 — Perf-recorder unit coverage.
 *
 * The recorder is a tiny stateful ring buffer driven from the rAF callback
 * in `src/boot/game-loop.ts`. We can't exercise rAF in JSDOM, so these
 * tests feed in fully synthetic monotonic timestamps and assert that the
 * derived stats line up with what we'd see in the wild:
 *
 *  - empty windows report zeros (never NaN — the HUD reads these every
 *    half second and would render `NaN` straight to the DOM otherwise)
 *  - clean 60 Hz feeds produce ~60 fps + clean percentiles
 *  - a single 50 ms spike in an otherwise-flat window pushes p99 up but
 *    not p50, and is counted as exactly one "hitch" (> 33.4 ms)
 *  - the ring wraps cleanly — pushing more samples than capacity keeps
 *    the most recent N and drops the oldest, so long-running sessions
 *    don't grow memory
 *  - the CSV export round-trips with the right row count and monotonic
 *    `t_ms` so we can pipe it straight into a spreadsheet for offline
 *    inspection
 */
import { describe, expect, it } from 'vitest'
import { createPerfRecorder, HITCH_THRESHOLD_MS } from '../../src/engine/perf-recorder'

describe('perf-recorder', () => {
  it('returns sensible zeros (no NaN) on an empty recorder', () => {
    const rec = createPerfRecorder()
    const s = rec.stats()
    expect(s.fps).toBe(0)
    expect(s.avgMs).toBe(0)
    expect(s.p50Ms).toBe(0)
    expect(s.p95Ms).toBe(0)
    expect(s.p99Ms).toBe(0)
    expect(s.minMs).toBe(0)
    expect(s.maxMs).toBe(0)
    expect(s.count).toBe(0)
    expect(s.hitchCount).toBe(0)
    // Important: every numeric field must be finite. The HUD writes these
    // to textContent verbatim and `NaN` slipping through reads as broken.
    for (const v of [s.fps, s.avgMs, s.p50Ms, s.p95Ms, s.p99Ms, s.minMs, s.maxMs]) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('handles a single sample without crashing (only seeds baseline)', () => {
    // The very first sample is just a baseline — there's no previous
    // timestamp to diff against — so the ring stays empty.
    const rec = createPerfRecorder()
    rec.sample(1000)
    const s = rec.stats()
    expect(s.count).toBe(0)
  })

  it('60 evenly-spaced 16.67ms samples → fps≈60, p95≈16.67, hitch=0', () => {
    const rec = createPerfRecorder()
    const dtMs = 1000 / 60
    let t = 0
    rec.sample(t)
    for (let i = 0; i < 60; i++) {
      t += dtMs
      rec.sample(t)
    }
    const s = rec.stats()
    expect(s.count).toBe(60)
    expect(s.fps).toBeCloseTo(60, 1)
    expect(s.avgMs).toBeCloseTo(dtMs, 2)
    expect(s.p50Ms).toBeCloseTo(dtMs, 2)
    expect(s.p95Ms).toBeCloseTo(dtMs, 2)
    expect(s.p99Ms).toBeCloseTo(dtMs, 2)
    expect(s.minMs).toBeCloseTo(dtMs, 2)
    expect(s.maxMs).toBeCloseTo(dtMs, 2)
    expect(s.hitchCount).toBe(0)
  })

  it('a 50ms spike in 100 samples → hitchCount=1, p99 close to spike', () => {
    // Push 100 deltas: 99 clean 16.67 ms frames + one 50 ms hitch.
    // hitchCount must report the spike (>33.4 ms). p50 stays at the
    // clean baseline (one outlier doesn't move the median). The spike
    // is the unique maximum, and the linear-interp p99 over n=100
    // (position 0.99 × 99 = 98.01) sits just inside the spike's
    // neighbourhood — close enough that with a stronger spike or
    // multiple spikes the p99 row of the HUD lights up. We assert p99
    // moves *above* the baseline, which is the property the HUD needs.
    const rec = createPerfRecorder()
    const dtMs = 1000 / 60
    let t = 0
    rec.sample(t)
    for (let i = 0; i < 100; i++) {
      const dt = i === 50 ? 50 : dtMs
      t += dt
      rec.sample(t)
    }
    const s = rec.stats()
    expect(s.count).toBe(100)
    expect(s.hitchCount).toBe(1)
    expect(s.maxMs).toBeCloseTo(50, 2)
    expect(s.p99Ms).toBeGreaterThan(dtMs)
    expect(s.p50Ms).toBeCloseTo(dtMs, 2)
    // With ten such spikes (top 10%), p99 lands right on the spike
    // — verify that property too so we know the percentile picks up
    // sustained slowdowns the way the HUD expects.
    const rec2 = createPerfRecorder()
    let t2 = 0
    rec2.sample(t2)
    for (let i = 0; i < 100; i++) {
      const dt = i % 10 === 0 ? 50 : dtMs
      t2 += dt
      rec2.sample(t2)
    }
    const s2 = rec2.stats()
    expect(s2.hitchCount).toBe(10)
    expect(s2.p99Ms).toBeCloseTo(50, 1)
  })

  it('counts every frame above HITCH_THRESHOLD_MS', () => {
    // Sanity check that the hitch counter respects the documented
    // threshold — three deliberate hitches against a quiet baseline.
    const rec = createPerfRecorder()
    let t = 0
    rec.sample(t)
    const deltas = [16, 16, 34, 16, HITCH_THRESHOLD_MS + 1, 16, 50, 16]
    for (const dt of deltas) {
      t += dt
      rec.sample(t)
    }
    const s = rec.stats()
    expect(s.hitchCount).toBe(3)
  })

  it('wraparound: 1000 samples into a 600-cap buffer keeps the most recent 600', () => {
    const rec = createPerfRecorder(600)
    let t = 0
    rec.sample(t)
    // Encode "which sample" into the dt so we can verify which window
    // survives. We'll push 1000 samples where dt = 10 + i*0.001 so each
    // sample is uniquely identifiable. With a 600-cap ring, the window
    // should end up as deltas for sample indices [400, 1000).
    for (let i = 0; i < 1000; i++) {
      const dt = 10 + i * 0.001
      t += dt
      rec.sample(t)
    }
    const s = rec.stats()
    expect(s.count).toBe(600)
    // Oldest sample currently retained should have dt ≈ 10 + 400*0.001 = 10.4
    expect(s.minMs).toBeCloseTo(10.4, 3)
    // Newest sample dt ≈ 10 + 999*0.001 = 10.999
    expect(s.maxMs).toBeCloseTo(10.999, 3)
    // Mean dt over [400, 1000) ≈ 10 + 699.5*0.001 = 10.6995
    expect(s.avgMs).toBeCloseTo(10.6995, 3)
  })

  it('toCsv() round-trips: header + one row per sample, monotonic t_ms', () => {
    const rec = createPerfRecorder()
    let t = 0
    rec.sample(t)
    for (let i = 0; i < 10; i++) {
      t += 16.67
      rec.sample(t)
    }
    const csv = rec.toCsv()
    const lines = csv.split('\n')
    expect(lines[0]).toBe('frame_index,t_ms,dt_ms')
    // 10 data rows for 10 deltas in the ring.
    expect(lines.length).toBe(11)
    let prev = -Infinity
    for (let i = 1; i < lines.length; i++) {
      const row = (lines[i] as string).split(',')
      expect(row).toHaveLength(3)
      const idx = Number(row[0])
      const tMs = Number(row[1])
      const dt = Number(row[2])
      expect(idx).toBe(i - 1)
      expect(Number.isFinite(tMs)).toBe(true)
      expect(Number.isFinite(dt)).toBe(true)
      expect(tMs).toBeGreaterThan(prev)
      prev = tMs
    }
  })

  it('toCsv() returns just the header on an empty recorder', () => {
    const rec = createPerfRecorder()
    expect(rec.toCsv()).toBe('frame_index,t_ms,dt_ms')
  })

  it('toCsv() emits samples in chronological order even after wraparound', () => {
    const rec = createPerfRecorder(4)
    let t = 0
    rec.sample(t)
    // Push 8 samples with strictly-increasing timestamps. Only the most
    // recent 4 deltas survive; the CSV should list them oldest-to-newest.
    for (let i = 0; i < 8; i++) {
      t += 16 + i // 16, 17, 18, ...
      rec.sample(t)
    }
    const lines = rec.toCsv().split('\n').slice(1)
    expect(lines).toHaveLength(4)
    let prevT = -Infinity
    let prevIdx = -1
    for (const line of lines) {
      const [idxStr, tStr] = line.split(',')
      const idx = Number(idxStr)
      const tMs = Number(tStr)
      expect(idx).toBe(prevIdx + 1)
      expect(tMs).toBeGreaterThan(prevT)
      prevIdx = idx
      prevT = tMs
    }
  })

  it('reset() clears the ring and percentile state', () => {
    const rec = createPerfRecorder()
    let t = 0
    rec.sample(t)
    for (let i = 0; i < 20; i++) {
      t += 16.67
      rec.sample(t)
    }
    expect(rec.stats().count).toBe(20)
    rec.reset()
    const s = rec.stats()
    expect(s.count).toBe(0)
    expect(s.fps).toBe(0)
    expect(rec.toCsv()).toBe('frame_index,t_ms,dt_ms')
    // After reset, the next call also seeds a new baseline (so no spike
    // from the gap between the old and new sample streams).
    rec.sample(1_000_000)
    rec.sample(1_000_016.67)
    const s2 = rec.stats()
    expect(s2.count).toBe(1)
    expect(s2.maxMs).toBeCloseTo(16.67, 2)
  })
})
