import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGpuProfiler, type GpuProfilerRenderer } from '../../src/engine/render/gpu-profiler'

/**
 * Unit tests for the WebGPU GPU-time profiler's *pure logic*, exercised
 * against a fake renderer. Real GPU timing can't be observed headlessly —
 * these only assert the rolling-average maths, the in-flight resolve guard,
 * the zero/undefined-hold behaviour, and DOM overlay lifecycle. An in-browser
 * `?gpuprofile=1` check is still required to confirm real timestamp values.
 */

/** A fake renderer whose `info.*.timestamp` and resolve behaviour are fully
 *  controllable. `resolve` defaults to an immediately-resolved promise; pass
 *  a never-settling one to exercise the in-flight guard. */
function makeFakeRenderer(opts?: { resolve?: () => Promise<unknown> }): GpuProfilerRenderer & {
  setRender: (ms: number | undefined) => void
  setCompute: (ms: number | undefined) => void
  resolveCalls: number
} {
  // `render`/`compute` are plain mutable holders; the profiler reads them
  // through optional chaining, and the setters assign `undefined` to exercise
  // the "not ready this frame" branch — hence the loose holder type rather
  // than the interface's `timestamp?: number`.
  const render: { timestamp: number | undefined } = { timestamp: 0 }
  const compute: { timestamp: number | undefined } = { timestamp: 0 }
  const info: GpuProfilerRenderer['info'] = { render, compute }
  let resolveCalls = 0
  const resolve = opts?.resolve ?? (() => Promise.resolve())
  return {
    info,
    async resolveTimestampsAsync() {
      resolveCalls++
      return resolve()
    },
    setRender(ms) {
      render.timestamp = ms
    },
    setCompute(ms) {
      compute.timestamp = ms
    },
    get resolveCalls() {
      return resolveCalls
    },
  }
}

/** Deterministic monotonic clock for throttle control. */
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createGpuProfiler — disabled', () => {
  it('returns an inert no-op when not enabled', () => {
    const r = makeFakeRenderer()
    const p = createGpuProfiler(r, { enabled: false })
    expect(p.enabled).toBe(false)
    p.tick()
    p.tick()
    expect(r.resolveCalls).toBe(0)
    expect(p.readings()).toMatchObject({ renderMs: 0, computeMs: 0, samples: 0 })
    p.dispose()
  })

  it('defaults to disabled when no options are passed', () => {
    const r = makeFakeRenderer()
    const p = createGpuProfiler(r)
    expect(p.enabled).toBe(false)
  })
})

describe('createGpuProfiler — rolling average', () => {
  it('computes the rolling average across several ticks', async () => {
    const r = makeFakeRenderer()
    const clock = makeClock()
    const p = createGpuProfiler(r, {
      enabled: true,
      overlay: false,
      windowSize: 60,
      resolveIntervalMs: 0,
      now: clock.now,
    })

    // Feed three render samples; each tick ingests the current info value.
    r.setRender(2)
    p.tick()
    await Promise.resolve()
    r.setRender(4)
    clock.advance(1)
    p.tick()
    await Promise.resolve()
    r.setRender(6)
    clock.advance(1)
    p.tick()
    await Promise.resolve()

    const out = p.readings()
    // Average of 2,4,6 = 4. Last sample = 6.
    expect(out.renderMs).toBeCloseTo(4, 5)
    expect(out.lastRenderMs).toBeCloseTo(6, 5)
    expect(out.samples).toBe(3)
    p.dispose()
  })

  it('evicts the oldest sample once the window is full', async () => {
    const r = makeFakeRenderer()
    const clock = makeClock()
    const p = createGpuProfiler(r, {
      enabled: true,
      overlay: false,
      windowSize: 2,
      resolveIntervalMs: 0,
      now: clock.now,
    })

    for (const ms of [10, 20, 30]) {
      r.setRender(ms)
      clock.advance(1)
      p.tick()
      await Promise.resolve()
    }

    // Window of 2 holds the last two samples: 20 and 30 → average 25.
    const out = p.readings()
    expect(out.renderMs).toBeCloseTo(25, 5)
    expect(out.lastRenderMs).toBeCloseTo(30, 5)
    expect(out.samples).toBe(2)
    p.dispose()
  })

  it('tracks render and compute streams independently', async () => {
    const r = makeFakeRenderer()
    const clock = makeClock()
    const p = createGpuProfiler(r, {
      enabled: true,
      overlay: false,
      resolveIntervalMs: 0,
      now: clock.now,
    })
    r.setRender(8)
    r.setCompute(2)
    p.tick()
    await Promise.resolve()
    r.setRender(12)
    r.setCompute(4)
    clock.advance(1)
    p.tick()
    await Promise.resolve()

    const out = p.readings()
    expect(out.renderMs).toBeCloseTo(10, 5)
    expect(out.computeMs).toBeCloseTo(3, 5)
    p.dispose()
  })
})

describe('createGpuProfiler — in-flight guard', () => {
  it('never has two resolves outstanding when a resolve never settles', () => {
    // A resolve that never settles keeps the in-flight promise pending,
    // so subsequent ticks past the throttle window must not start a new one.
    const r = makeFakeRenderer({ resolve: () => new Promise<void>(() => {}) })
    const clock = makeClock()
    const p = createGpuProfiler(r, {
      enabled: true,
      overlay: false,
      resolveIntervalMs: 0,
      now: clock.now,
    })

    p.tick() // starts the (never-settling) resolve
    clock.advance(1000)
    p.tick() // throttle window open, but in-flight guard must block
    clock.advance(1000)
    p.tick()

    // The async IIFE awaits compute then render, but since compute never
    // settles only the first resolveTimestampsAsync call ('compute') fires,
    // and no further resolve batches start.
    expect(r.resolveCalls).toBe(1)
    p.dispose()
  })

  it('throttles resolves by resolveIntervalMs', async () => {
    const r = makeFakeRenderer()
    const clock = makeClock()
    const p = createGpuProfiler(r, {
      enabled: true,
      overlay: false,
      resolveIntervalMs: 500,
      now: clock.now,
    })

    // Fully drain the resolve batch's microtasks so the call count settles.
    const drain = async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve()
    }

    r.setRender(5)
    p.tick() // t=0: resolves (compute + render) = 2 calls
    await drain()
    const after1 = r.resolveCalls
    expect(after1).toBe(2)

    clock.advance(100)
    p.tick() // within throttle window — no new resolve batch
    await drain()
    expect(r.resolveCalls).toBe(after1)

    clock.advance(500)
    p.tick() // past the window — resolves again
    await drain()
    expect(r.resolveCalls).toBeGreaterThan(after1)
    p.dispose()
  })
})

describe('createGpuProfiler — zero / undefined hold', () => {
  it('holds the prior value when timestamp is 0 and never crashes', async () => {
    const r = makeFakeRenderer()
    const clock = makeClock()
    const p = createGpuProfiler(r, {
      enabled: true,
      overlay: false,
      resolveIntervalMs: 0,
      now: clock.now,
    })

    r.setRender(7)
    p.tick()
    await Promise.resolve()
    expect(p.readings().renderMs).toBeCloseTo(7, 5)

    // A frame reporting 0 (not ready) must not pollute the average.
    r.setRender(0)
    clock.advance(1)
    expect(() => p.tick()).not.toThrow()
    await Promise.resolve()
    expect(p.readings().renderMs).toBeCloseTo(7, 5)
    expect(p.readings().samples).toBe(1)
    p.dispose()
  })

  it('holds the prior value when timestamp is undefined', async () => {
    const r = makeFakeRenderer()
    const clock = makeClock()
    const p = createGpuProfiler(r, {
      enabled: true,
      overlay: false,
      resolveIntervalMs: 0,
      now: clock.now,
    })

    r.setRender(9)
    p.tick()
    await Promise.resolve()
    expect(p.readings().renderMs).toBeCloseTo(9, 5)

    r.setRender(undefined)
    clock.advance(1)
    expect(() => p.tick()).not.toThrow()
    await Promise.resolve()
    expect(p.readings().renderMs).toBeCloseTo(9, 5)
    p.dispose()
  })

  it('starts at zero readings before any sample lands', () => {
    const r = makeFakeRenderer()
    const p = createGpuProfiler(r, { enabled: true, overlay: false })
    expect(p.readings()).toMatchObject({
      renderMs: 0,
      computeMs: 0,
      samples: 0,
    })
    p.dispose()
  })
})

describe('createGpuProfiler — DOM overlay + window mirror', () => {
  /** Minimal fake DOM sufficient for the overlay path. */
  function installFakeDom(): {
    appended: unknown[]
    bodyChildren: unknown[]
  } {
    const appended: unknown[] = []
    const bodyChildren: unknown[] = []
    const makeEl = () => {
      const el: Record<string, unknown> = {
        style: {},
        id: '',
        textContent: '',
        parentNode: null as unknown,
      }
      return el
    }
    const body = {
      appendChild(el: Record<string, unknown>) {
        el.parentNode = body
        bodyChildren.push(el)
        appended.push(el)
      },
      removeChild(el: Record<string, unknown>) {
        const i = bodyChildren.indexOf(el)
        if (i >= 0) bodyChildren.splice(i, 1)
        el.parentNode = null
      },
    }
    vi.stubGlobal('document', {
      createElement: () => makeEl(),
      body,
    })
    return { appended, bodyChildren }
  }

  it('creates an overlay, mirrors readings to window.__gpuProfile, and updates text', async () => {
    const dom = installFakeDom()
    const r = makeFakeRenderer()
    const clock = makeClock()
    const p = createGpuProfiler(r, {
      enabled: true,
      overlay: true,
      resolveIntervalMs: 0,
      now: clock.now,
    })
    expect(dom.bodyChildren.length).toBe(1)
    const overlay = dom.bodyChildren[0] as { id: string; textContent: string }
    expect(overlay.id).toBe('gpu-profiler-overlay')

    r.setRender(3.5)
    p.tick()
    await Promise.resolve()

    expect(overlay.textContent).toContain('GPU render: 3.50 ms')
    expect(
      (globalThis as { __gpuProfile?: { renderMs: number } }).__gpuProfile?.renderMs,
    ).toBeCloseTo(3.5, 5)
    p.dispose()
  })

  it('dispose removes the overlay and clears window.__gpuProfile', async () => {
    const dom = installFakeDom()
    const r = makeFakeRenderer()
    const p = createGpuProfiler(r, {
      enabled: true,
      overlay: true,
      resolveIntervalMs: 0,
      now: makeClock().now,
    })
    r.setRender(1)
    p.tick()
    await Promise.resolve()
    expect(dom.bodyChildren.length).toBe(1)

    p.dispose()
    expect(dom.bodyChildren.length).toBe(0)
    expect((globalThis as { __gpuProfile?: unknown }).__gpuProfile).toBeUndefined()
  })

  it('skips overlay creation when overlay: false', () => {
    const dom = installFakeDom()
    const r = makeFakeRenderer()
    const p = createGpuProfiler(r, { enabled: true, overlay: false })
    expect(dom.bodyChildren.length).toBe(0)
    p.dispose()
  })
})
