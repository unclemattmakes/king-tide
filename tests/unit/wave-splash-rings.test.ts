import { describe, expect, it } from 'vitest'
import {
  MAX_SPLASH_RINGS,
  SPLASH_RING_AMP_MAX,
  SPLASH_RING_LIFE_S,
  SPLASH_RING_MIN_IMPACT,
  SPLASH_RING_SPEED,
  sampleSplashRings,
  spawnSplashRing,
} from '../../src/engine/sim/water/splash-rings'
import { createWaveField, sampleHeight, sampleSurface } from '../../src/engine/sim/water/wave-field'

/**
 * Splash rings (P4.1, water-next-research §7.5): deterministic landing
 * event waves. Pins spawn gating, pool discipline, the expanding-ring
 * shape, exact vy, and the strength scalar that keeps buoyancy and the
 * GPU on one dial.
 */

function field() {
  return createWaveField([]) // no ambient — isolate the rings
}

describe('spawnSplashRing', () => {
  it('gates on impact speed and on the strength kill switch', () => {
    const f = field()
    spawnSplashRing(f, 0, 0, SPLASH_RING_MIN_IMPACT - 0.5)
    expect(f.rings).toHaveLength(0)
    f.splashRingStrength = 0
    spawnSplashRing(f, 0, 0, 10)
    expect(f.rings).toHaveLength(0)
    f.splashRingStrength = 1
    spawnSplashRing(f, 0, 0, 10)
    expect(f.rings).toHaveLength(1)
  })

  it('scales amplitude with impact, capped', () => {
    const f = field()
    spawnSplashRing(f, 0, 0, SPLASH_RING_MIN_IMPACT + 2)
    spawnSplashRing(f, 0, 0, 100)
    expect(f.rings[0]!.amp).toBeCloseTo(0.12, 9)
    expect(f.rings[1]!.amp).toBe(SPLASH_RING_AMP_MAX)
  })

  it('reuses the oldest slot when the pool is full', () => {
    const f = field()
    for (let i = 0; i < MAX_SPLASH_RINGS; i++) {
      f.time = i
      spawnSplashRing(f, i, 0, 10)
    }
    expect(f.rings).toHaveLength(MAX_SPLASH_RINGS)
    f.time = 100
    spawnSplashRing(f, 999, 0, 10)
    expect(f.rings).toHaveLength(MAX_SPLASH_RINGS)
    // The t0 = 0 ring (x = 0) was replaced.
    expect(f.rings.some((r) => r.x === 999)).toBe(true)
    expect(f.rings.some((r) => r.x === 0 && r.t0 === 0)).toBe(false)
  })
})

describe('ring shape', () => {
  it('expands at SPLASH_RING_SPEED — the ridge peaks at r = R(age)', () => {
    const f = field()
    spawnSplashRing(f, 0, 0, 12)
    for (const age of [0.5, 1.0, 2.0]) {
      f.time = age
      const R = SPLASH_RING_SPEED * age
      let bestR = 0
      let bestY = -1
      for (let r = 0; r <= 40; r += 0.1) {
        const y = sampleHeight(f, r, 0)
        if (y > bestY) {
          bestY = y
          bestR = r
        }
      }
      expect(Math.abs(bestR - R)).toBeLessThan(0.3)
      expect(bestY).toBeGreaterThan(0)
    }
  })

  it('amplitude decays with age and the ring dies by LIFE', () => {
    const f = field()
    spawnSplashRing(f, 0, 0, 12)
    const peakAt = (age: number) => {
      f.time = age
      return sampleHeight(f, SPLASH_RING_SPEED * age, 0)
    }
    expect(peakAt(0.4)).toBeGreaterThan(peakAt(1.5))
    expect(peakAt(1.5)).toBeGreaterThan(peakAt(3.0))
    f.time = SPLASH_RING_LIFE_S + 0.01
    for (let r = 0; r <= 40; r += 2) {
      expect(sampleHeight(f, r, 0)).toBe(0)
    }
  })

  it('vy matches a finite difference of sampleHeight', () => {
    const f = field()
    spawnSplashRing(f, 0, 0, 12)
    for (const age of [0.3, 1.1, 2.6]) {
      for (const r of [age * SPLASH_RING_SPEED - 1, age * SPLASH_RING_SPEED + 2, 4]) {
        f.time = age
        const vy = sampleSurface(f, r, 0).vy
        const dt = 1e-4
        f.time = age + dt
        const yP = sampleHeight(f, r, 0)
        f.time = age - dt
        const yM = sampleHeight(f, r, 0)
        expect(vy).toBeCloseTo((yP - yM) / (2 * dt), 4)
      }
    }
  })

  it('strength scales the surface on both sampler paths', () => {
    const f = field()
    spawnSplashRing(f, 0, 0, 12)
    f.time = 1
    const r = SPLASH_RING_SPEED * 1
    const full = sampleHeight(f, r, 0)
    f.splashRingStrength = 0.5
    expect(sampleHeight(f, r, 0)).toBeCloseTo(full * 0.5, 9)
    expect(sampleSurface(f, r, 0).y).toBeCloseTo(full * 0.5, 9)
    f.splashRingStrength = 0
    expect(sampleHeight(f, r, 0)).toBe(0)
  })

  it('the direct sampler and sampleHeight agree (integration path)', () => {
    const f = field()
    spawnSplashRing(f, 3, -2, 9)
    f.time = 0.8
    for (const [x, z] of [
      [3, -2],
      [8, -2],
      [3, 4],
      [-3, -8],
    ] as const) {
      expect(sampleHeight(f, x, z)).toBeCloseTo(sampleSplashRings(f, x, z, f.time).y, 12)
    }
  })
})
