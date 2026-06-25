import { describe, expect, it } from 'vitest'
import { rescaleSeaState } from '@/engine/editor/editor-live-water'
import { beaufortToAmplitudeScale } from '@/engine/render/sky'

describe('rescaleSeaState', () => {
  it('scales amplitudes from the base beaufort to a new one (relative to base)', () => {
    const base = [1, 2, 0.5]
    const waves = base.map((a) => ({ amplitude: a }))
    // Base = Beaufort 4 (≈ 1.0×). Crank to 8 (≈ 2.0×) → amplitudes ~double.
    rescaleSeaState(waves, base, 4, 8)
    const expected = beaufortToAmplitudeScale(8) / beaufortToAmplitudeScale(4)
    expect(waves[0]!.amplitude).toBeCloseTo(base[0]! * expected, 6)
    expect(waves[1]!.amplitude).toBeCloseTo(base[1]! * expected, 6)
    expect(waves[0]!.amplitude).toBeGreaterThan(base[0]!) // rougher sea
  })

  it('round-trips back to the base amplitudes', () => {
    const base = [1, 2, 0.5]
    const waves = base.map((a) => ({ amplitude: a }))
    rescaleSeaState(waves, base, 4, 9) // stormy
    rescaleSeaState(waves, base, 4, 4) // back to base
    expect(waves[0]!.amplitude).toBeCloseTo(base[0]!, 6)
    expect(waves[1]!.amplitude).toBeCloseTo(base[1]!, 6)
  })

  it('calms the sea below the base when beaufort drops', () => {
    const base = [1]
    const waves = [{ amplitude: 1 }]
    rescaleSeaState(waves, base, 6, 1) // from rough to near-glass
    expect(waves[0]!.amplitude).toBeLessThan(1)
    expect(waves[0]!.amplitude).toBeGreaterThan(0)
  })
})
