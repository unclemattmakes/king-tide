/**
 * WebGPU GPU-time profiler — opt-in dev tool behind `?gpuprofile=1`.
 *
 * WebGPU exposes per-frame GPU timing through the `timestamp-query` feature,
 * which WebGL2 cannot. Three's `WebGPURenderer` surfaces the resolved
 * durations on `renderer.info.render.timestamp` / `.compute.timestamp` (ms)
 * once you've asked it to track timestamps (`trackTimestamp: true`) and
 * resolved them with `resolveTimestampsAsync()`.
 *
 * This module owns the *consumer* side: it ticks once per rendered frame,
 * throttles the (async) resolve so we never block the hot render path, keeps
 * an in-flight guard so two resolves are never outstanding at once (mirroring
 * three's own `RendererInspector.resolveTimestamp()`), and maintains a rolling
 * average of the render/compute durations.
 *
 * It is deliberately *render-only* — it never imports Three, never touches the
 * sim layer, and is a silent no-op when timestamps aren't available (WebGL2
 * fallback, feature absent, headless). The renderer.ts wiring decides whether
 * `trackTimestamp` was actually enabled; here we stay best-effort and never
 * throw, so a profiler created against a non-tracking renderer just reports
 * zeros forever.
 *
 * Readings are mirrored onto `window.__gpuProfile` for console access and into
 * a tiny fixed top-left DOM overlay. Both are guarded for non-DOM contexts so
 * the module stays import-safe from unit tests / headless tooling.
 */

/** Minimal shape of the renderer the profiler needs. Keeps the module free of
 *  a Three import and trivially unit-testable with a fake. */
export interface GpuProfilerRenderer {
  /** Resolve the GPU timestamps for the given query type ('render' |
   *  'compute'). Async; the result lands on `info.*.timestamp`. */
  resolveTimestampsAsync(type?: string): Promise<unknown>
  info: {
    // `timestamp` is explicitly `number | undefined` (not just optional) so the
    // profiler's "0 / undefined → hold last value" branch is part of the typed
    // contract — a backend that hasn't resolved leaves it undefined or 0.
    render?: { timestamp?: number | undefined }
    compute?: { timestamp?: number | undefined }
  }
}

/** Snapshot of the latest rolling stats. Durations are in milliseconds. */
export interface GpuProfilerReadings {
  /** Rolling-average render-pass GPU time (ms). */
  renderMs: number
  /** Rolling-average compute GPU time (ms). */
  computeMs: number
  /** Most-recent raw render sample (ms). */
  lastRenderMs: number
  /** Most-recent raw compute sample (ms). */
  lastComputeMs: number
  /** Number of samples currently in the rolling window. */
  samples: number
}

export interface GpuProfiler {
  /** Whether profiling is active (renderer is tracking timestamps). When
   *  false, `tick()` is a no-op and readings stay zeroed. */
  readonly enabled: boolean
  /** Call once per rendered frame, after `render()`. Throttles the async
   *  resolve and refreshes the rolling stats + overlay. Never throws. */
  tick(): void
  /** Latest rolling readings. */
  readings(): GpuProfilerReadings
  /** Tear down: remove the overlay, clear `window.__gpuProfile`. */
  dispose(): void
}

export interface GpuProfilerOptions {
  /** Rolling-average window length, in samples. Default 60. */
  windowSize?: number
  /** Minimum ms between async resolves. Default 500 (~2x/sec). */
  resolveIntervalMs?: number
  /** Whether profiling is enabled. When false, returns a no-op profiler.
   *  The caller (renderer wiring) decides this from feature detection. */
  enabled?: boolean
  /** Whether to attach the DOM overlay. Default true. */
  overlay?: boolean
  /** Injectable clock for tests. Default `performance.now` / `Date.now`. */
  now?: () => number
}

const NOOP_READINGS: GpuProfilerReadings = {
  renderMs: 0,
  computeMs: 0,
  lastRenderMs: 0,
  lastComputeMs: 0,
  samples: 0,
}

/** A rolling average over a fixed-size ring of the last N samples. */
class RollingAverage {
  private readonly ring: number[] = []
  private sum = 0
  private head = 0
  last = 0

  constructor(private readonly size: number) {}

  push(value: number): void {
    this.last = value
    if (this.ring.length < this.size) {
      this.ring.push(value)
      this.sum += value
      return
    }
    // Ring is full — overwrite the oldest entry and adjust the sum. The
    // index is always in-bounds here (length === size), so the `?? 0` only
    // satisfies `noUncheckedIndexedAccess`; it never actually fires.
    this.sum += value - (this.ring[this.head] ?? 0)
    this.ring[this.head] = value
    this.head = (this.head + 1) % this.size
  }

  average(): number {
    return this.ring.length === 0 ? 0 : this.sum / this.ring.length
  }

  get count(): number {
    return this.ring.length
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __gpuProfile: GpuProfilerReadings | undefined
}

/**
 * Create a GPU-time profiler bound to `renderer`. When `opts.enabled` is
 * false (the default feature-detection result on WebGL2 / unsupported
 * adapters) this returns an inert no-op so callers can wire it
 * unconditionally.
 */
export function createGpuProfiler(
  renderer: GpuProfilerRenderer,
  opts: GpuProfilerOptions = {},
): GpuProfiler {
  const enabled = opts.enabled ?? false
  if (!enabled) {
    return {
      enabled: false,
      tick() {},
      readings() {
        return { ...NOOP_READINGS }
      },
      dispose() {},
    }
  }

  const windowSize = Math.max(1, opts.windowSize ?? 60)
  const resolveIntervalMs = Math.max(0, opts.resolveIntervalMs ?? 500)
  const now =
    opts.now ?? (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now())

  const renderAvg = new RollingAverage(windowSize)
  const computeAvg = new RollingAverage(windowSize)

  // In-flight guard — never have two resolves outstanding. Mirrors three's
  // RendererInspector: a single pending promise that's nulled when it settles.
  let inFlight: Promise<void> | null = null
  let lastResolveAt = Number.NEGATIVE_INFINITY

  // Latest readings object, also mirrored to window.__gpuProfile.
  let current: GpuProfilerReadings = { ...NOOP_READINGS }

  // --- DOM overlay (guarded for non-DOM contexts) ---------------------------
  const wantOverlay = (opts.overlay ?? true) && typeof document !== 'undefined'
  let overlayEl: HTMLDivElement | null = null
  if (wantOverlay) {
    overlayEl = document.createElement('div')
    overlayEl.id = 'gpu-profiler-overlay'
    Object.assign(overlayEl.style, {
      position: 'fixed',
      top: '4px',
      left: '4px',
      zIndex: '99999',
      font: '11px/1.4 monospace',
      color: '#9ff',
      background: 'rgba(0,0,0,0.55)',
      padding: '3px 6px',
      borderRadius: '3px',
      pointerEvents: 'none',
      whiteSpace: 'pre',
    } satisfies Partial<CSSStyleDeclaration>)
    overlayEl.textContent = 'GPU render: – ms / compute: – ms'
    document.body.appendChild(overlayEl)
  }

  const paintOverlay = (): void => {
    if (!overlayEl) return
    overlayEl.textContent = `GPU render: ${current.renderMs.toFixed(2)} ms / compute: ${current.computeMs.toFixed(2)} ms`
  }

  /** Read the latest resolved timestamps off `renderer.info`. A reading of 0
   *  or undefined means "not ready this frame" — we hold the prior average
   *  rather than polluting it with a zero. */
  const ingestResolved = (): void => {
    const renderTs = renderer.info.render?.timestamp
    const computeTs = renderer.info.compute?.timestamp
    let changed = false
    if (typeof renderTs === 'number' && renderTs > 0) {
      renderAvg.push(renderTs)
      changed = true
    }
    if (typeof computeTs === 'number' && computeTs > 0) {
      computeAvg.push(computeTs)
      changed = true
    }
    if (!changed) return
    current = {
      renderMs: renderAvg.average(),
      computeMs: computeAvg.average(),
      lastRenderMs: renderAvg.last,
      lastComputeMs: computeAvg.last,
      // Samples reflect whichever stream is being fed; render is the primary.
      samples: Math.max(renderAvg.count, computeAvg.count),
    }
    if (typeof globalThis !== 'undefined') {
      globalThis.__gpuProfile = current
    }
    paintOverlay()
  }

  /** Kick off a throttled, fire-and-forget resolve. The in-flight guard means
   *  a long-running (or never-settling) resolve only ever has one outstanding
   *  promise; we ingest the prior frame's already-resolved values eagerly so
   *  the overlay stays live even while a resolve is pending. */
  const maybeResolve = (): void => {
    // Always ingest whatever's currently sitting on renderer.info — three
    // writes the resolved durations there, so this picks up the last
    // completed resolve without waiting on the new one.
    ingestResolved()

    if (inFlight !== null) return
    const t = now()
    if (t - lastResolveAt < resolveIntervalMs) return
    lastResolveAt = t

    const promise = (async () => {
      // Resolve both query types; compute may be unused on this build but the
      // call is harmless and keeps compute timings populated when present.
      await renderer.resolveTimestampsAsync('compute')
      await renderer.resolveTimestampsAsync('render')
    })()
      .then(() => {
        // Pick up the freshly-resolved values on the next settle.
        ingestResolved()
      })
      .catch(() => {
        // Best-effort: a backend that rejects (feature lost, context gone)
        // must not break the render loop. Swallow and keep last values.
      })
      .finally(() => {
        inFlight = null
      })

    inFlight = promise
  }

  return {
    enabled: true,
    tick() {
      try {
        maybeResolve()
      } catch {
        // Never let profiling break the frame.
      }
    },
    readings() {
      return { ...current }
    },
    dispose() {
      if (overlayEl?.parentNode) {
        overlayEl.parentNode.removeChild(overlayEl)
      }
      overlayEl = null
      if (typeof globalThis !== 'undefined') {
        globalThis.__gpuProfile = undefined
      }
    },
  }
}
