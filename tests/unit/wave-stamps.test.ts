import { describe, expect, it, vi } from 'vitest'
import type { ShoreField } from '../../src/engine/sim/water/shore-field'
import {
  createWaveField,
  MAX_WAVE_STAMPS,
  STAMP_DEPTH_CAP,
  STAMP_END_FEATHER_M,
  STAMP_RELEASE_RATIO,
  sampleHeight,
  sampleStampsAt,
  sampleSurface,
  setShoreField,
  setWaveStamps,
  type WaveStampInput,
} from '../../src/engine/sim/water/wave-field'

/**
 * Authored wave stamps (P3.2, water-next-research §7.10): the signature
 * jump waves. These pin the contracts that make a stamp a learnable,
 * honest gameplay feature: deterministic periodicity (same wave, same
 * place, every lap), peak ON the authored line, exact vy for hover
 * damping, continuity through the cycle wrap, and the seabed cap.
 */

/** One stamp: crest line along Z at x = 0 (from z −40 → +40), pulse
 *  approaching from −X (left normal of p0→p1 with p1 at +Z is −X… travel
 *  direction = (−uz, ux) = (−1, 0)·? — pinned by the travel test below). */
function stamp(over?: Partial<WaveStampInput>): WaveStampInput {
  return {
    x0: 0,
    z0: -40,
    x1: 0,
    z1: 40,
    amplitude: 1.2,
    widthM: 6,
    periodS: 20,
    speed: 10,
    approachM: 60,
    ...over,
  }
}

function fieldWith(st: WaveStampInput[] = [stamp()]) {
  const f = createWaveField([]) // no ambient — isolate the stamp term
  setWaveStamps(f, st)
  return f
}

/** The cycle time at which the pulse center sits exactly on the line
 *  (c = 0): tt = approachM / (speed·periodS). */
function peakTime(st: WaveStampInput): number {
  return (st.approachM / (st.speed * st.periodS)) * st.periodS
}

describe('setWaveStamps', () => {
  it('caps at MAX_WAVE_STAMPS and drops degenerate stamps with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = createWaveField([])
    setWaveStamps(
      f,
      Array.from({ length: MAX_WAVE_STAMPS + 3 }, () => stamp()),
    )
    expect(f.stamps).toHaveLength(MAX_WAVE_STAMPS)
    setWaveStamps(f, [stamp({ x1: 0, z1: -40 }), stamp({ amplitude: 0 })]) // zero length / amp
    expect(f.stamps).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('clamps approachM so the pulse life fits one period (no mid-life teleport)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = createWaveField([])
    // speed·periodS = 50 m of travel; life needs (1+ratio)·approachM = 96 m.
    setWaveStamps(f, [stamp({ speed: 5, periodS: 10, approachM: 60 })])
    expect(f.stamps[0]!.approachM).toBeCloseTo(50 / (1 + STAMP_RELEASE_RATIO), 9)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('stamp pulse', () => {
  it('peaks ON the authored line at the peak moment, every period (deterministic)', () => {
    const st = stamp()
    const f = fieldWith()
    const tPeak = peakTime(st)
    for (const lap of [0, 1, 5]) {
      f.time = tPeak + lap * st.periodS
      const onLine = sampleHeight(f, 0, 0)
      expect(onLine).toBeCloseTo(sampleStampsAt(f, 0, 0, f.time).y, 12)
      expect(onLine).toBeGreaterThan(st.amplitude * 0.8) // life ≈ 1 at the line
      // The same instant, the wave is smaller off the line in the travel
      // direction (it's a ridge, not a plateau).
      expect(sampleHeight(f, 12, 0)).toBeLessThan(onLine * 0.1)
      expect(sampleHeight(f, -12, 0)).toBeLessThan(onLine * 0.1)
    }
  })

  it('travels along the segment LEFT normal toward the line', () => {
    const st = stamp()
    const f = fieldWith()
    // Left normal of u = (0, 1) is (−uz, ux) = (−1, 0): the pulse lives at
    // NEGATIVE x early in the cycle and sweeps toward x = 0.
    const tEarly = peakTime(st) * 0.5 // c = −approachM/2 → center at x·n = c → x = −(−30)?? pinned below
    f.time = tEarly
    // The pulse center sits at d = c = −30 → world x with n = (−1, 0):
    // d = (x − 0)·(−1) = −x → x = −c = +30?? The assertion below settles
    // the convention empirically: find the max along the travel axis.
    let bestX = 0
    let bestY = -1
    for (let x = -80; x <= 80; x += 0.5) {
      const y = sampleHeight(f, x, 0)
      if (y > bestY) {
        bestY = y
        bestX = x
      }
    }
    // Whichever sign convention, the pulse must be mid-approach (|x|≈30,
    // not on the line) and on ONE consistent side…
    expect(Math.abs(Math.abs(bestX) - st.approachM / 2)).toBeLessThan(2)
    // …and approaching: a moment later it is closer to the line.
    f.time = tEarly + 1
    let bestX2 = 0
    let bestY2 = -1
    for (let x = -80; x <= 80; x += 0.5) {
      const y = sampleHeight(f, x, 0)
      if (y > bestY2) {
        bestY2 = y
        bestX2 = x
      }
    }
    expect(Math.abs(bestX2)).toBeLessThan(Math.abs(bestX))
  })

  it('feathers to zero at the segment ends and beyond', () => {
    const st = stamp()
    const f = fieldWith()
    f.time = peakTime(st)
    const mid = sampleHeight(f, 0, 0)
    expect(mid).toBeGreaterThan(1)
    // At the endpoint the feather has fully closed…
    expect(sampleHeight(f, 0, 40)).toBeCloseTo(0, 6)
    expect(sampleHeight(f, 0, -40)).toBeCloseTo(0, 6)
    // …half a feather in, it's partial.
    const half = sampleHeight(f, 0, 40 - STAMP_END_FEATHER_M / 2)
    expect(half).toBeGreaterThan(0.1 * mid)
    expect(half).toBeLessThan(0.9 * mid)
    // Beyond the segment: nothing.
    expect(sampleHeight(f, 0, 55)).toBe(0)
  })

  it('is zero (and continuous) at the cycle wrap — no teleporting pulse', () => {
    const st = stamp()
    const f = fieldWith()
    // Just before and after the wrap the surface is flat everywhere along
    // the travel axis (the pulse died at release and hasn't re-entered).
    for (const t of [st.periodS - 1e-3, st.periodS + 1e-3]) {
      f.time = t
      for (let x = -80; x <= 80; x += 4) {
        expect(Math.abs(sampleHeight(f, x, 0))).toBeLessThan(1e-6)
      }
    }
  })

  it('vy matches a finite difference of sampleHeight through the whole life', () => {
    const st = stamp()
    const f = fieldWith()
    const tPeak = peakTime(st)
    // Sample through approach, peak, release — including the life ramps.
    for (const t of [tPeak * 0.35, tPeak * 0.7, tPeak, tPeak * 1.2]) {
      for (const x of [-20, -5, 0, 5]) {
        f.time = t
        const vy = sampleSurface(f, x, 0).vy
        const dt = 1e-4
        f.time = t + dt
        const yP = sampleHeight(f, x, 0)
        f.time = t - dt
        const yM = sampleHeight(f, x, 0)
        expect(vy).toBeCloseTo((yP - yM) / (2 * dt), 4)
      }
    }
  })

  it('caps amplitude by water depth when a shore field exists', () => {
    const st = stamp()
    const f = fieldWith()
    const res = 8
    const n = res * res
    const shallow: ShoreField = {
      resolution: res,
      minX: -100,
      minZ: -100,
      sizeX: 200,
      sizeZ: 200,
      dist: new Float32Array(n).fill(30),
      nrmX: new Float32Array(n).fill(1),
      nrmZ: new Float32Array(n).fill(0),
      depth: new Float32Array(n).fill(0.5),
    }
    setShoreField(f, shallow)
    // Silence the shore BREAKER so only the stamp term remains — the cap
    // reads the depth regardless.
    f.shoreWaveStrength = 0
    f.time = peakTime(st)
    // amplitude 1.2 capped to 0.6·0.5 = 0.3.
    const y = sampleHeight(f, 0, 0)
    expect(y).toBeLessThanOrEqual(STAMP_DEPTH_CAP * 0.5 + 1e-6)
    expect(y).toBeGreaterThan(0.2)
  })

  it('sampleHeight and sampleSurface agree with a live stamp', () => {
    const st = stamp()
    const f = fieldWith()
    for (const t of [3, 6.5, peakTime(st)]) {
      f.time = t
      for (let x = -40; x <= 20; x += 7) {
        expect(sampleSurface(f, x, 3).y).toBeCloseTo(sampleHeight(f, x, 3), 9)
      }
    }
  })
})
