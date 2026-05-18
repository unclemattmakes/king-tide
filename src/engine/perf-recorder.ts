/**
 * Step 8 — Perf recorder.
 *
 * Rolling buffer of per-frame timing deltas. Driven from the rAF callback in
 * `src/boot/game-loop.ts`: every frame, the loop calls `sample(now)` and the
 * recorder pushes `now - lastNow` into a fixed-size ring. `stats()` reports
 * fps/percentiles/hitch-count over whatever's currently in the ring;
 * `toCsv()` dumps it for offline inspection.
 *
 * Design constraints:
 *  - `sample()` MUST be allocation-free in the steady state (hot path,
 *    runs once per render frame). We pre-allocate the Float32Array ring
 *    and the percentile scratch buffer up front.
 *  - `stats()` / `toCsv()` are called on demand (HUD = ~2 Hz, debug API =
 *    rare) so they may allocate.
 *  - "Hitch" threshold = 33.4 ms (a frame longer than ~30 fps). Counted
 *    over the current window — i.e. it ages out as the ring wraps.
 *
 * The recorder is decoupled from Three / DOM so it's trivially unit-testable
 * with monotonic timestamps.
 */

/** Ring capacity in samples — ~10 s at 60 fps. */
export const PERF_RING_CAPACITY = 600

/** Frame-time threshold above which we count a "hitch". 33.4 ms ≈ 30 fps. */
export const HITCH_THRESHOLD_MS = 33.4

export interface PerfStats {
  /** Mean fps across the window. 0 when the ring is empty. */
  fps: number
  /** Mean frame time in ms. */
  avgMs: number
  /** 50th percentile frame time. */
  p50Ms: number
  /** 95th percentile frame time. */
  p95Ms: number
  /** 99th percentile frame time. */
  p99Ms: number
  /** Smallest frame time in the window. */
  minMs: number
  /** Largest frame time in the window. */
  maxMs: number
  /** How many samples are currently in the ring (≤ PERF_RING_CAPACITY). */
  count: number
  /** Frames in the current window that exceeded HITCH_THRESHOLD_MS. */
  hitchCount: number
}

export interface PerfRecorder {
  /** Push a per-frame delta into the ring. `now` is a monotonic timestamp
   *  (rAF callback ms, or performance.now()). The first call seeds the
   *  baseline; subsequent calls push `now - lastNow`. */
  sample(now: number): void
  /** Compute stats over the current ring contents. Allocates a sorted
   *  scratch buffer (reused across calls). */
  stats(): PerfStats
  /** Dump every sample currently in the ring to CSV. */
  toCsv(): string
  /** Wipe the ring back to empty. */
  reset(): void
}

const EMPTY_STATS: PerfStats = {
  fps: 0,
  avgMs: 0,
  p50Ms: 0,
  p95Ms: 0,
  p99Ms: 0,
  minMs: 0,
  maxMs: 0,
  count: 0,
  hitchCount: 0,
}

export function createPerfRecorder(capacity: number = PERF_RING_CAPACITY): PerfRecorder {
  const cap = Math.max(1, Math.floor(capacity))
  // Frame-time deltas, in ms. Pre-allocated to dodge GC.
  const deltas = new Float32Array(cap)
  // Wall-clock timestamps (ms) parallel to `deltas` — kept so toCsv() can
  // emit absolute time, not just deltas.
  const stamps = new Float64Array(cap)
  // Scratch buffer for sorted percentiles. Allocated once, refilled in
  // stats(). Grows lazily — we only need `count` entries on any given call.
  let percentileScratch = new Float32Array(cap)

  let head = 0 // next write index
  let count = 0 // valid samples in the ring (≤ cap)
  let lastNow = -1 // -1 = no baseline yet

  function sample(now: number): void {
    if (lastNow < 0) {
      lastNow = now
      return
    }
    const dt = now - lastNow
    lastNow = now
    deltas[head] = dt
    stamps[head] = now
    head = (head + 1) % cap
    if (count < cap) count += 1
  }

  function snapshot(out: Float32Array): void {
    // Copy current ring contents into `out[0..count)` in chronological order.
    if (count < cap) {
      // Ring hasn't wrapped — entries live in [0, head).
      for (let i = 0; i < count; i++) out[i] = deltas[i] as number
      return
    }
    // Ring wrapped — oldest entry sits at `head`.
    let oi = 0
    for (let i = 0; i < cap; i++) {
      const src = (head + i) % cap
      out[oi++] = deltas[src] as number
    }
  }

  function stats(): PerfStats {
    if (count === 0) return { ...EMPTY_STATS }
    if (percentileScratch.length < count) {
      percentileScratch = new Float32Array(count)
    }
    snapshot(percentileScratch)
    // Tally + sort. We only sort the prefix [0, count) — the rest of the
    // scratch is stale, which is fine because we never read past `count`.
    let total = 0
    let minV = Number.POSITIVE_INFINITY
    let maxV = Number.NEGATIVE_INFINITY
    let hitchCount = 0
    for (let i = 0; i < count; i++) {
      const v = percentileScratch[i] as number
      total += v
      if (v < minV) minV = v
      if (v > maxV) maxV = v
      if (v > HITCH_THRESHOLD_MS) hitchCount += 1
    }
    const view = percentileScratch.subarray(0, count)
    view.sort()
    const avgMs = total / count
    const fps = avgMs > 0 ? 1000 / avgMs : 0
    return {
      fps,
      avgMs,
      p50Ms: percentile(view, 0.5),
      p95Ms: percentile(view, 0.95),
      p99Ms: percentile(view, 0.99),
      minMs: minV,
      maxMs: maxV,
      count,
      hitchCount,
    }
  }

  function toCsv(): string {
    const rows: string[] = ['frame_index,t_ms,dt_ms']
    if (count === 0) return rows.join('\n')
    // Walk in chronological order. We emit `frame_index` 0..count-1 (not
    // absolute frame counters — the recorder is purely a sliding window)
    // and the corresponding absolute timestamp + delta.
    const start = count < cap ? 0 : head
    for (let i = 0; i < count; i++) {
      const src = (start + i) % cap
      const t = stamps[src] as number
      const dt = deltas[src] as number
      rows.push(`${i},${t},${dt}`)
    }
    return rows.join('\n')
  }

  function reset(): void {
    head = 0
    count = 0
    lastNow = -1
  }

  return { sample, stats, toCsv, reset }
}

/** Linear-interp percentile over a *sorted* typed-array view. `q` ∈ [0, 1]. */
function percentile(sorted: Float32Array, q: number): number {
  const n = sorted.length
  if (n === 0) return 0
  if (n === 1) return sorted[0] as number
  const pos = q * (n - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo] as number
  const frac = pos - lo
  const a = sorted[lo] as number
  const b = sorted[hi] as number
  return a + (b - a) * frac
}
