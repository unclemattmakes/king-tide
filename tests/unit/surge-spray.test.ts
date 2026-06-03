import { describe, expect, it } from 'vitest'
import { createSurgeSprayDriver } from '../../src/engine/render/surge-spray'

describe('surge spray driver', () => {
  it('fires in-range emitters once per surge cycle, on the rising edge', () => {
    const fired: string[] = []
    const d = createSurgeSprayDriver({
      zones: [{ x: 0, z: 0, radius: 50, periodS: 8, amplitude: 2 }],
      emitters: [
        { name: 'spray', x: 10, z: 0 }, // in range
        { name: 'far', x: 999, z: 0 }, // out of range — never fires
      ],
      triggerBurst: (n) => fired.push(n),
      burstCount: 5,
    })
    // ~two full 8 s periods at 0.1 s steps
    for (let t = 0; t <= 16; t += 0.1) d.tick(t)
    expect(fired.every((n) => n === 'spray')).toBe(true)
    expect(fired.filter((n) => n === 'spray').length).toBe(2) // one peak per period
  })

  it('drops zones with no nearby emitter and ignores zones without a surge', () => {
    const fired: string[] = []
    const d = createSurgeSprayDriver({
      zones: [
        { x: 0, z: 0, radius: 5, periodS: 8, amplitude: 2 }, // emitter too far
        { x: 0, z: 0, radius: 999, periodS: 0, amplitude: 0 }, // no surge
      ],
      emitters: [{ name: 'spray', x: 100, z: 0 }],
      triggerBurst: (n) => fired.push(n),
    })
    for (let t = 0; t <= 16; t += 0.1) d.tick(t)
    expect(fired.length).toBe(0)
  })
})
