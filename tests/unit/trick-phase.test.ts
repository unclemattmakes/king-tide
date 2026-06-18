/**
 * trickPhase() — the named view over TrickState's flag soup
 * (docs/systems-review.md §6.1). Asserts the precedence that resolves the
 * otherwise-implicit states, including representable-but-invalid combos.
 */
import { describe, expect, it } from 'vitest'
import { trickPhase } from '../../src/game/systems/trick-hop'

const base = { trickWindowOpen: false, bufferedPressTimerSec: 0, hopLockoutActive: false }

describe('trickPhase', () => {
  it('is grounded when nothing is active', () => {
    expect(trickPhase(base)).toBe('grounded')
  })

  it('is airborne whenever the window is open (highest precedence)', () => {
    expect(trickPhase({ ...base, trickWindowOpen: true })).toBe('airborne')
    // Window wins even over a (representable-but-invalid) concurrent lockout.
    expect(trickPhase({ ...base, trickWindowOpen: true, hopLockoutActive: true })).toBe('airborne')
  })

  it('is buffered when a press is held and no window is open', () => {
    expect(trickPhase({ ...base, bufferedPressTimerSec: 0.1 })).toBe('buffered')
  })

  it('is hop-lockout after a courtesy hop with no window/buffer', () => {
    expect(trickPhase({ ...base, hopLockoutActive: true })).toBe('hop-lockout')
  })
})
