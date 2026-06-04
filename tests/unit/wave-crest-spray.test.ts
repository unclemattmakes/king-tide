import { describe, expect, it } from 'vitest'
import { breakingFoam, createWaveCrestSprayDriver } from '../../src/engine/render/wave-crest-spray'

type Fire = { x: number; y: number; z: number; strength: number }

describe('breakingFoam', () => {
  it('is zero for glassy (low-slope) or shallow (low-crest) water', () => {
    expect(breakingFoam(0, 0)).toBe(0)
    expect(breakingFoam(1.0, 0)).toBe(0) // steep but no crest height
    expect(breakingFoam(0, 2.0)).toBe(0) // tall but glassy
  })

  it('saturates to 1 for a tall, steep crest and rises monotonically with slope', () => {
    expect(breakingFoam(1.0, 1.5)).toBeCloseTo(1, 5)
    const a = breakingFoam(0.4, 1.5)
    const b = breakingFoam(0.6, 1.5)
    expect(b).toBeGreaterThan(a)
  })
})

describe('wave crest spray driver', () => {
  it('fires once per crest as foam rises through the threshold, then re-arms', () => {
    // One cell at the origin lattice point. Drive its foam through a full
    // rise-and-fall cycle twice and assert exactly two bursts.
    let foam = 0
    const fires: Fire[] = []
    const d = createWaveCrestSprayDriver({
      sample: () => ({ y: 1.2, foam }),
      emit: (x, y, z, strength) => fires.push({ x, y, z, strength }),
      // Tiny window so only the origin cell is swept.
      config: { radius: 1, spacing: 9, fireThreshold: 0.55, rearmThreshold: 0.3, cooldownS: 0 },
    })
    let t = 0
    const step = (f: number) => {
      foam = f
      t += 0.1
      d.tick(0, 0, t)
    }
    // First crest: rise past fire, fall back below re-arm.
    step(0.1) // seed (armed, no rising edge yet)
    step(0.4)
    step(0.7) // fires
    step(0.9)
    step(0.2) // re-arm
    // Second crest.
    step(0.5)
    step(0.8) // fires again
    step(0.1)
    expect(fires.length).toBe(2)
    expect(fires[0]?.y).toBe(1.2)
    expect(fires[0]?.strength).toBeGreaterThan(0.55)
  })

  it('does not fire on the cell it first sees mid-crest (no rising edge)', () => {
    const fires: Fire[] = []
    const d = createWaveCrestSprayDriver({
      sample: () => ({ y: 0, foam: 0.9 }), // already breaking on first sight
      emit: (x, y, z, s) => fires.push({ x, y, z, strength: s }),
      config: { radius: 1, spacing: 9, cooldownS: 0 },
    })
    d.tick(0, 0, 0.1)
    d.tick(0, 0, 0.2)
    expect(fires.length).toBe(0)
  })

  it('honours the cooldown floor even if foam oscillates fast', () => {
    let foam = 0
    const fires: Fire[] = []
    const d = createWaveCrestSprayDriver({
      sample: () => ({ y: 0, foam }),
      emit: (x, y, z, s) => fires.push({ x, y, z, strength: s }),
      config: { radius: 1, spacing: 9, fireThreshold: 0.5, rearmThreshold: 0.2, cooldownS: 1.0 },
    })
    let t = 0
    const step = (f: number) => {
      foam = f
      t += 0.1
      d.tick(0, 0, t)
    }
    step(0.0) // seed
    step(0.6) // fires at t≈0.2
    step(0.1) // re-arm
    step(0.6) // rising edge again at t≈0.4, but inside the 1 s cooldown → no fire
    expect(fires.length).toBe(1)
  })

  it('caps the number of cells that fire in a single tick', () => {
    // Big window, every cell breaking at once on a rising edge.
    let foam = 0
    const fires: Fire[] = []
    const d = createWaveCrestSprayDriver({
      sample: () => ({ y: 0, foam }),
      emit: (x, y, z, s) => fires.push({ x, y, z, strength: s }),
      config: { radius: 90, spacing: 9, maxFiresPerTick: 5, cooldownS: 0 },
    })
    d.tick(0, 0, 0.1) // seed all cells at foam 0
    foam = 0.9
    d.tick(0, 0, 0.2) // every cell crosses at once → capped
    expect(fires.length).toBe(5)
  })

  it('prunes cells that leave the window as the centre moves', () => {
    const d = createWaveCrestSprayDriver({
      sample: () => ({ y: 0, foam: 0.1 }),
      emit: () => {},
      config: { radius: 18, spacing: 9 },
    })
    d.tick(0, 0, 0.1)
    const near = d.activeCells()
    expect(near).toBeGreaterThan(0)
    // Travel far away — the original cells should be pruned, not accumulated.
    d.tick(10000, 10000, 0.2)
    expect(d.activeCells()).toBeLessThanOrEqual(near)
  })
})
