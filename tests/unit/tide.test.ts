import { describe, expect, it } from 'vitest'
import { advanceTide, createTide, tideActive } from '@/engine/sim/water/tide'

describe('tide controller', () => {
  it('is inactive and pinned to the base height with no config', () => {
    const t = createTide(-1.5)
    expect(tideActive(t)).toBe(false)
    expect(t.height).toBe(-1.5)
    // Advancing a still tide never moves the surface off the mean.
    advanceTide(t, 10)
    expect(t.height).toBe(-1.5)
  })

  it('seats the opening height at the configured phase before any advance', () => {
    // phase 0.25 = quarter-cycle = full high tide (sin(π/2) = 1).
    const high = createTide(0, { amplitudeM: 3, periodS: 120, phase: 0.25 })
    expect(high.height).toBeCloseTo(3, 6)
    // phase 0.75 = full low tide (sin(3π/2) = −1).
    const low = createTide(0, { amplitudeM: 3, periodS: 120, phase: 0.75 })
    expect(low.height).toBeCloseTo(-3, 6)
    // phase 0 = mean level, rising.
    const mean = createTide(-1.5, { amplitudeM: 3, periodS: 120 })
    expect(mean.height).toBeCloseTo(-1.5, 6)
  })

  it('swings amplitudeM either side of the mean across a full period', () => {
    const t = createTide(-1.5, { amplitudeM: 3, periodS: 120 })
    // Quarter period → peak high; half → back to mean; three-quarter → peak low.
    advanceTide(t, 30)
    expect(t.height).toBeCloseTo(-1.5 + 3, 4) // +1.5
    advanceTide(t, 30)
    expect(t.height).toBeCloseTo(-1.5, 4)
    advanceTide(t, 30)
    expect(t.height).toBeCloseTo(-1.5 - 3, 4) // -4.5
    advanceTide(t, 30)
    expect(t.height).toBeCloseTo(-1.5, 4) // full cycle → mean again
  })

  it('returns the new absolute height from advanceTide', () => {
    const t = createTide(0, { amplitudeM: 2, periodS: 80 })
    const h = advanceTide(t, 20) // quarter period → peak
    expect(h).toBe(t.height)
    expect(h).toBeCloseTo(2, 4)
  })
})
