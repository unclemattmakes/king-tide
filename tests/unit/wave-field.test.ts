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

  it('wake forms a V with raised edges and a sunken middle', () => {
    // Empty wave field so we measure ONLY the wake contribution.
    const f = createWaveField([])
    f.wakes.push({ x: 0, z: 0, vx: 12, vz: 0, weight: 1 })
    // The V's right edge sits at z = behind * WAKE_HALF_ANGLE_TAN
    // + WAKE_BASE_WIDTH, with the bike at origin moving +X.
    const behind = 10
    const wakeWidth = behind * 0.4 + 0.55 // = 4.55
    const bx = -behind

    // On the V edge: positive peak (the visible ridge).
    const yEdge = sampleHeight(f, bx, wakeWidth)
    expect(yEdge).toBeGreaterThan(0.3)

    // On the bike's central axis (perp=0): trough — water is below
    // ambient. This is what makes the wake feel like a real channel
    // carved through the surface.
    const yAxis = sampleHeight(f, bx, 0)
    expect(yAxis).toBeLessThan(-0.3)

    // WAY off to the side (perp >> wakeWidth + halfwidth): zero.
    const ySide = sampleHeight(f, bx, 30)
    expect(Math.abs(ySide)).toBeLessThan(0.01)

    // IN FRONT of the bike (behind = 0): no wake.
    const yFront = sampleHeight(f, 10, 0)
    expect(yFront).toBe(0)
  })

  it('wake fades to zero at low speed', () => {
    const f = createWaveField([])
    f.wakes.push({ x: 0, z: 0, vx: 0.5, vz: 0, weight: 1 })
    // Below WAKE_SPEED_LOW, wake function returns 0 entirely. Sample
    // both axis (would be trough) and edge (would be ridge).
    const behind = 10
    const wakeWidth = behind * 0.4 + 0.55
    expect(sampleHeight(f, -behind, 0)).toBe(0)
    expect(sampleHeight(f, -behind, wakeWidth)).toBe(0)
  })

  it('wake scales with weight', () => {
    const f = createWaveField([])
    const behind = 10
    const wakeWidth = behind * 0.4 + 0.55
    f.wakes = [{ x: 0, z: 0, vx: 12, vz: 0, weight: 1 }]
    const edgeFull = sampleHeight(f, -behind, wakeWidth)
    const axisFull = sampleHeight(f, -behind, 0)
    f.wakes = [{ x: 0, z: 0, vx: 12, vz: 0, weight: 0.5 }]
    const edgeHalf = sampleHeight(f, -behind, wakeWidth)
    const axisHalf = sampleHeight(f, -behind, 0)
    // Linear scaling on both the ridge peak and the trough.
    expect(edgeHalf).toBeCloseTo(edgeFull * 0.5, 4)
    expect(axisHalf).toBeCloseTo(axisFull * 0.5, 4)
  })

  it('wake produces non-trivial slope between trough and ridge', () => {
    const f = createWaveField([])
    f.wakes.push({ x: 0, z: 0, vx: 12, vz: 0, weight: 1 })
    // The V's slope is steepest somewhere between the central trough
    // and the edge ridge. Sample the surface normal across the trough
    // wall — at least one sample should tilt by ≥ 0.1 in nz.
    const behind = 10
    const wakeWidth = behind * 0.4 + 0.55
    let maxAbs = 0
    for (let z = 0.1; z < wakeWidth; z += 0.05) {
      const s = sampleSurface(f, -behind, z)
      maxAbs = Math.max(maxAbs, Math.abs(s.nz))
    }
    expect(maxAbs).toBeGreaterThan(0.1)
  })
})
