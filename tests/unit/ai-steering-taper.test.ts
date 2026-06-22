/**
 * Speed-tapered AI steering gain (review §7 — "twitchy at 28 m/s, lazy at 8").
 * Pins the pure `taperedSteerKp` helper that scales the proportional steering
 * gain down as horizontal speed climbs, so the AI keeps full line-making
 * authority when slow but stops over-correcting at top speed.
 */
import { describe, expect, it } from 'vitest'
import { taperedSteerKp } from '../../src/game/systems/ai-control'

const KP = 0.85

describe('taperedSteerKp', () => {
  it('is identity when the taper is 0 (legacy speed-independent gain)', () => {
    for (const v of [0, 8, 28, 40]) {
      expect(taperedSteerKp(KP, v, 0)).toBe(KP)
    }
  })

  it('equals the raw gain at zero speed (no taper at a standstill)', () => {
    expect(taperedSteerKp(KP, 0, 0.02)).toBe(KP)
  })

  it('decreases monotonically as speed rises (less authority at speed)', () => {
    const taper = 0.02
    let prev = Number.POSITIVE_INFINITY
    for (const v of [0, 5, 10, 20, 30, 40]) {
      const g = taperedSteerKp(KP, v, taper)
      expect(g).toBeLessThan(prev)
      prev = g
    }
  })

  it('bleeds off meaningful gain at top speed but stays responsive when slow', () => {
    const taper = 0.02
    const slow = taperedSteerKp(KP, 8, taper) // ~0.733
    const fast = taperedSteerKp(KP, 28, taper) // ~0.545
    // Slow keeps most of the raw gain; fast is well below it.
    expect(slow).toBeGreaterThan(KP * 0.8)
    expect(fast).toBeLessThan(KP * 0.7)
    // And the high-speed gain is clearly softer than the low-speed gain.
    expect(fast).toBeLessThan(slow * 0.8)
  })

  it('matches the closed form Kp / (1 + v·k)', () => {
    expect(taperedSteerKp(0.85, 28, 0.02)).toBeCloseTo(0.85 / (1 + 28 * 0.02), 10)
    expect(taperedSteerKp(1.0, 10, 0.05)).toBeCloseTo(1.0 / 1.5, 10)
  })

  it('never amplifies the gain on a stray negative speed or taper', () => {
    expect(taperedSteerKp(KP, -5, 0.02)).toBe(KP)
    expect(taperedSteerKp(KP, 20, -0.02)).toBe(KP)
  })
})
