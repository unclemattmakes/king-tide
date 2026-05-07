import { describe, expect, it } from 'vitest'
import {
  advanceWaveField,
  createWaveField,
  defaultWaves,
  sampleHeight,
  sampleSurface,
} from '../../src/engine/sim/water/wave-field'

describe('wave field', () => {
  it('returns 0 height with no waves', () => {
    const f = createWaveField([])
    expect(sampleHeight(f, 0, 0)).toBe(0)
    expect(sampleHeight(f, 100, -50)).toBe(0)
  })

  it('produces a periodic single sine', () => {
    const f = createWaveField([
      { dirX: 1, dirZ: 0, amplitude: 1, wavelength: 10, speed: 1, phase: 0 },
    ])
    // At t=0, x=0: phase = 0, y = 0.
    expect(sampleHeight(f, 0, 0)).toBeCloseTo(0, 6)
    // x = wavelength/4 = 2.5: phase = π/2, y = 1.
    expect(sampleHeight(f, 2.5, 0)).toBeCloseTo(1, 6)
    // x = wavelength/2 = 5: phase = π, y = 0.
    expect(sampleHeight(f, 5, 0)).toBeCloseTo(0, 6)
  })

  it('advances time and oscillates a fixed point', () => {
    const f = createWaveField([
      { dirX: 1, dirZ: 0, amplitude: 1, wavelength: 4, speed: 1, phase: 0 },
    ])
    // omega = (2π/4) * 1 = π/2 rad/s. Quarter period = 1s.
    const a = sampleHeight(f, 0, 0)
    advanceWaveField(f, 1) // 1 second = quarter period
    const b = sampleHeight(f, 0, 0)
    expect(Math.abs(b - a)).toBeGreaterThan(0.5)
  })

  it('default preset produces nontrivial samples within reasonable bounds', () => {
    const f = createWaveField(defaultWaves())
    let min = Infinity
    let max = -Infinity
    // Sample a grid at multiple times — confirm the field is nonzero and bounded.
    for (let ti = 0; ti < 10; ti++) {
      advanceWaveField(f, 0.5)
      for (let x = -20; x <= 20; x += 5) {
        for (let z = -20; z <= 20; z += 5) {
          const y = sampleHeight(f, x, z)
          min = Math.min(min, y)
          max = Math.max(max, y)
        }
      }
    }
    expect(max).toBeGreaterThan(0.3)
    expect(min).toBeLessThan(-0.3)
    // Sum of amplitudes is the upper bound; clamp generously.
    expect(max).toBeLessThan(2.0)
    expect(min).toBeGreaterThan(-2.0)
  })

  it('sampleSurface returns unit normal', () => {
    const f = createWaveField(defaultWaves())
    const s = sampleSurface(f, 3, 7)
    const len = Math.hypot(s.nx, s.ny, s.nz)
    expect(len).toBeCloseTo(1, 5)
    // Normal y should be positive (water surface points up overall).
    expect(s.ny).toBeGreaterThan(0)
  })
})
