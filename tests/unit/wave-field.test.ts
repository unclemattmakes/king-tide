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
    // Sample a grid over a full set-beat period (~30s) so the test sees both
    // calm windows and big-swell peaks.
    for (let ti = 0; ti < 60; ti++) {
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
    // Sum of amplitudes is the upper bound; clamp generously to allow
    // constructive interference of all swell + chop components.
    expect(max).toBeLessThan(3.0)
    expect(min).toBeGreaterThan(-3.0)
  })

  it('sampleSurface returns unit normal', () => {
    const f = createWaveField(defaultWaves())
    const s = sampleSurface(f, 3, 7)
    const len = Math.hypot(s.nx, s.ny, s.nz)
    expect(len).toBeCloseTo(1, 5)
    // Normal y should be positive (water surface points up overall).
    expect(s.ny).toBeGreaterThan(0)
  })

  it('wake source displaces water behind a moving bike', () => {
    // Empty wave field so we measure ONLY the wake contribution.
    const f = createWaveField([])
    f.wakes.push({ x: 0, z: 0, vx: 12, vz: 0, weight: 1 })
    // Sample several points behind the bike (negative x) along its line.
    // The wake oscillates in sign, so look at the absolute envelope.
    let maxAbs = 0
    for (let bx = -2; bx >= -30; bx -= 0.25) {
      const y = sampleHeight(f, bx, 0)
      maxAbs = Math.max(maxAbs, Math.abs(y))
    }
    expect(maxAbs).toBeGreaterThan(0.05)

    // Sample WAY off to the side (perpendicular distance >> V boundary):
    // wake should be effectively zero.
    const ySide = sampleHeight(f, -10, 30)
    expect(Math.abs(ySide)).toBeLessThan(0.01)

    // Sample IN FRONT of the bike (positive x = behind = 0): no wake.
    const yFront = sampleHeight(f, 10, 0)
    expect(yFront).toBe(0)
  })

  it('wake fades to zero at low speed', () => {
    const f = createWaveField([])
    f.wakes.push({ x: 0, z: 0, vx: 0.5, vz: 0, weight: 1 })
    // Below WAKE_SPEED_LOW, wake function returns 0 entirely.
    let maxAbs = 0
    for (let bx = -1; bx >= -20; bx -= 0.5) {
      maxAbs = Math.max(maxAbs, Math.abs(sampleHeight(f, bx, 0)))
    }
    expect(maxAbs).toBe(0)
  })

  it('wake scales with weight', () => {
    const f = createWaveField([])
    // Sample at same time + position with different weights — amplitude
    // is linear in weight.
    f.wakes = [{ x: 0, z: 0, vx: 12, vz: 0, weight: 1 }]
    let peakFull = 0
    for (let bx = -1; bx >= -20; bx -= 0.05) {
      peakFull = Math.max(peakFull, Math.abs(sampleHeight(f, bx, 0)))
    }
    f.wakes = [{ x: 0, z: 0, vx: 12, vz: 0, weight: 0.5 }]
    let peakHalf = 0
    for (let bx = -1; bx >= -20; bx -= 0.05) {
      peakHalf = Math.max(peakHalf, Math.abs(sampleHeight(f, bx, 0)))
    }
    expect(peakHalf).toBeCloseTo(peakFull * 0.5, 4)
  })

  it('wake produces non-trivial slope (a real bump, not just color)', () => {
    const f = createWaveField([])
    f.wakes.push({ x: 0, z: 0, vx: 12, vz: 0, weight: 1 })
    // Walk along the wake axis and confirm the surface normal tilts
    // somewhere — peak normal-X should exceed 0.05 (≈ 3°).
    let maxNxAbs = 0
    for (let bx = -1; bx >= -20; bx -= 0.05) {
      const s = sampleSurface(f, bx, 0)
      maxNxAbs = Math.max(maxNxAbs, Math.abs(s.nx))
    }
    expect(maxNxAbs).toBeGreaterThan(0.1)
  })
})
