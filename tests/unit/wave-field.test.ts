import { describe, expect, it } from 'vitest'
import { buildShoreField, type ShoreField } from '../../src/engine/sim/water/shore-field'
import {
  advanceWaveField,
  createWaveField,
  defaultWaves,
  SHORE_BAND_DEPTH,
  SHORE_DEPTH_CAP,
  sampleHeight,
  sampleSurface,
  setShoreField,
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

  it('wake has transverse oscillation along its length (M9.35 scallops)', () => {
    // Sample the V's edge-ridge height at many points along the wake's
    // length. With pure exponential decay (pre-M9.35), the height profile
    // is monotonically decreasing — direction changes ≤ 1. With the
    // longitudinal sin modulation, peaks and troughs of the scallop
    // pattern create multiple direction changes. We sample over [3..30]m
    // (well within the wake's visible range, longDecay ~25m e-fold) at
    // 0.25m steps; the K=0.7 wavenumber gives ~3 full periods over that
    // range, expecting ≥4 direction changes (each period has up + down).
    const f = createWaveField([])
    f.wakes.push({ x: 0, z: 0, vx: 12, vz: 0, weight: 1 })
    const samples: number[] = []
    for (let b = 3; b <= 30; b += 0.25) {
      const wakeWidth = b * 0.4 + 0.55
      samples.push(sampleHeight(f, -b, wakeWidth))
    }
    let directionChanges = 0
    let lastDir = 0
    for (let i = 1; i < samples.length; i++) {
      const dir = Math.sign(samples[i]! - samples[i - 1]!)
      if (dir !== 0 && dir !== lastDir && lastDir !== 0) {
        directionChanges++
      }
      if (dir !== 0) lastDir = dir
    }
    expect(directionChanges).toBeGreaterThanOrEqual(4)
  })
})

// A west→east beach ramp: terrain rises with +X, crossing the water plane at
// x = 0. Land is +X, open water is −X. depth = −0.05·x in the water.
function rampShore(): ShoreField {
  const RES = 64
  const MINX = -100
  const SIZE = 200
  const cell = SIZE / RES
  const raw = new Float32Array(RES * RES)
  for (let v = 0; v < RES; v++) {
    for (let u = 0; u < RES; u++) {
      const x = MINX + (u + 0.5) * cell
      raw[v * RES + u] = 0.05 * x
    }
  }
  const f = buildShoreField({
    raw,
    resolution: RES,
    minX: MINX,
    minZ: MINX,
    sizeX: SIZE,
    sizeZ: SIZE,
    waterLevel: 0,
  })
  if (!f) throw new Error('expected a shore field')
  return f
}

describe('shore-aligned waves', () => {
  it('adds rideable height in the surf band, and nothing when strength = 0', () => {
    const f = createWaveField([]) // isolate the shore term (no ambient swell)
    setShoreField(f, rampShore())
    // x = −40 → depth ≈ 2 m, squarely in the band. Scan a beat so we don't
    // land on a phase zero-crossing.
    let peak = 0
    for (let i = 0; i < 40; i++) {
      advanceWaveField(f, 0.1)
      peak = Math.max(peak, Math.abs(sampleHeight(f, -40, 0)))
    }
    expect(peak).toBeGreaterThan(0.1)
    // Strength 0 collapses the contribution to exactly zero (empty field).
    f.shoreWaveStrength = 0
    for (let i = 0; i < 40; i++) {
      advanceWaveField(f, 0.1)
      expect(sampleHeight(f, -40, 0)).toBe(0)
    }
  })

  it('contributes nothing on dry land or in deep water', () => {
    const f = createWaveField([])
    setShoreField(f, rampShore())
    advanceWaveField(f, 1.3)
    // Land (x = +40, depth < 0).
    expect(sampleHeight(f, 40, 0)).toBe(0)
    // Deep water (x = −95 → depth ≈ 4.75 ≥ SHORE_BAND_DEPTH).
    expect(SHORE_BAND_DEPTH).toBeLessThan(4.75)
    expect(sampleHeight(f, -95, 0)).toBe(0)
  })

  it('never breaches the seabed (|height| ≤ SHORE_DEPTH_CAP · depth)', () => {
    const f = createWaveField([])
    const shore = rampShore()
    setShoreField(f, shore)
    for (let i = 0; i < 30; i++) {
      advanceWaveField(f, 0.17)
      for (let x = -85; x <= -5; x += 5) {
        const s = sampleSurface(f, x, 0) // unused beyond keeping parity warm
        void s
        const y = sampleHeight(f, x, 0)
        // depth at this x from the same field the term reads.
        const depth = -0.05 * x
        expect(Math.abs(y)).toBeLessThanOrEqual(SHORE_DEPTH_CAP * depth + 1e-3)
      }
    }
  })

  it('sampleHeight and sampleSurface agree on height with a shore field', () => {
    const f = createWaveField(defaultWaves())
    setShoreField(f, rampShore())
    for (let i = 0; i < 10; i++) {
      advanceWaveField(f, 0.37)
      for (let x = -80; x <= -10; x += 10) {
        for (let z = -30; z <= 30; z += 15) {
          expect(sampleHeight(f, x, z)).toBeCloseTo(sampleSurface(f, x, z).y, 9)
        }
      }
    }
  })

  it('shore ∂y/∂t (vy) matches a finite difference of height', () => {
    const f = createWaveField([]) // isolate shore so vy is purely the shore term
    setShoreField(f, rampShore())
    advanceWaveField(f, 2.0)
    const x = -35
    const z = 0
    const vy = sampleSurface(f, x, z).vy
    const eps = 1e-3
    advanceWaveField(f, eps)
    const hp = sampleHeight(f, x, z)
    advanceWaveField(f, -2 * eps)
    const hm = sampleHeight(f, x, z)
    const numeric = (hp - hm) / (2 * eps)
    expect(vy).toBeCloseTo(numeric, 3)
  })

  it('leaves the field untouched when no shore field is installed', () => {
    const a = createWaveField(defaultWaves())
    const b = createWaveField(defaultWaves())
    setShoreField(b, null)
    advanceWaveField(a, 1.1)
    advanceWaveField(b, 1.1)
    for (let x = -50; x <= 50; x += 25) {
      expect(sampleHeight(a, x, 7)).toBe(sampleHeight(b, x, 7))
    }
  })
})
