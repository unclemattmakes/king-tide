import { describe, expect, it } from 'vitest'
import {
  FRAMERATE_CAP_LABELS,
  framerateCapFromLabel,
  framerateCapToLabel,
  shouldRenderFrame,
} from '@/engine/render/frame-cap'

describe('shouldRenderFrame', () => {
  it('returns true unconditionally when cap is 0 (Unlimited)', () => {
    expect(shouldRenderFrame(0, 0, 0)).toBe(true)
    expect(shouldRenderFrame(1, 0, 0)).toBe(true)
    expect(shouldRenderFrame(100, 99.999, 0)).toBe(true)
  })

  it('returns true when cap is negative or NaN (treated as disabled)', () => {
    expect(shouldRenderFrame(100, 0, -1)).toBe(true)
    expect(shouldRenderFrame(100, 0, Number.NaN)).toBe(true)
  })

  it('returns true once enough wall-clock has accrued past the cap', () => {
    // 60 fps target = ~16.67 ms minus 0.5 ms slack = 16.17 ms gate.
    // 17 ms is comfortably past the gate so we should fire.
    expect(shouldRenderFrame(17, 0, 60)).toBe(true)
  })

  it('blocks a sub-16ms gap when cap is 60', () => {
    // 60 fps → ~16.67ms target. A 5ms gap is way under.
    expect(shouldRenderFrame(5, 0, 60)).toBe(false)
  })

  it('allows a 16.67ms gap when cap is 60 (slack-aware)', () => {
    // The 0.5ms slack means a 16.2ms gap should still fire — that's
    // the whole point of the slack.
    expect(shouldRenderFrame(16.2, 0, 60)).toBe(true)
  })

  it('blocks a 5ms gap when cap is 144 (~6.94ms target)', () => {
    expect(shouldRenderFrame(5, 0, 144)).toBe(false)
  })

  it('allows a 7ms gap when cap is 144', () => {
    expect(shouldRenderFrame(7, 0, 144)).toBe(true)
  })

  it('30 fps cap allows a 33ms gap but not a 20ms gap', () => {
    expect(shouldRenderFrame(33, 0, 30)).toBe(true)
    expect(shouldRenderFrame(20, 0, 30)).toBe(false)
  })

  it('compares against lastRendered, not 0', () => {
    // Simulating the loop: lastRendered=1000ms, now=1015ms, cap=60.
    // 15ms < 16.17ms gate → block.
    expect(shouldRenderFrame(1015, 1000, 60)).toBe(false)
    // 17ms → fire.
    expect(shouldRenderFrame(1017, 1000, 60)).toBe(true)
  })
})

describe('framerateCapFromLabel / framerateCapToLabel', () => {
  it('Unlimited round-trips to 0 / Unlimited', () => {
    expect(framerateCapFromLabel('Unlimited')).toBe(0)
    expect(framerateCapToLabel(0)).toBe('Unlimited')
  })

  it('60 round-trips to 60 / "60"', () => {
    expect(framerateCapFromLabel('60')).toBe(60)
    expect(framerateCapToLabel(60)).toBe('60')
  })

  it('parses every supported label without nullishness', () => {
    for (const label of FRAMERATE_CAP_LABELS) {
      const n = framerateCapFromLabel(label)
      // Unlimited → 0; everything else → > 0
      if (label === 'Unlimited') expect(n).toBe(0)
      else expect(n).toBeGreaterThan(0)
    }
  })

  it('rejects garbage labels by falling back to Unlimited', () => {
    expect(framerateCapFromLabel('rubbish')).toBe(0)
    expect(framerateCapFromLabel('')).toBe(0)
    expect(framerateCapFromLabel('-1')).toBe(0)
  })

  it('snaps an off-list cap to the nearest supported label', () => {
    // 75 is between 60 and 90; 90 is 15 away, 60 is 15 away — tie goes
    // to the first match (60).
    expect(framerateCapToLabel(75)).toBe('60')
    // 100 is closer to 90 (10 away) than 120 (20 away).
    expect(framerateCapToLabel(100)).toBe('90')
  })
})
