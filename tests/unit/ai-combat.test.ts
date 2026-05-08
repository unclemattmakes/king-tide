import { describe, expect, it } from 'vitest'
import { shouldAIFire } from '../../src/game/systems/ai-combat'

describe('shouldAIFire', () => {
  describe('boost', () => {
    it('fires on a straight (throttle > 0.85)', () => {
      expect(shouldAIFire('boost', 0.95, 0, false, false)).toBe(true)
    })
    it('does NOT fire mid-turn (throttle scaled down)', () => {
      expect(shouldAIFire('boost', 0.5, 0.7, false, false)).toBe(false)
    })
    it('boundary: 0.85 exactly does not fire (strict >)', () => {
      expect(shouldAIFire('boost', 0.85, 0, false, false)).toBe(false)
    })
  })

  describe('shield', () => {
    it('fires whenever held — purely defensive', () => {
      expect(shouldAIFire('shield', 0, 0, false, false)).toBe(true)
      expect(shouldAIFire('shield', 1, 0.9, true, true)).toBe(true)
    })
  })

  describe('mine', () => {
    it('fires when a chaser is close behind', () => {
      expect(shouldAIFire('mine', 1, 0, true, false)).toBe(true)
    })
    it('fires mid-corner (steer | > 0.4) to litter the apex', () => {
      expect(shouldAIFire('mine', 0.5, 0.6, false, false)).toBe(true)
    })
    it('does NOT fire on a clean straight with no chaser', () => {
      expect(shouldAIFire('mine', 1, 0, false, false)).toBe(false)
    })
    it('boundary: steer = 0.4 exactly does not fire (strict >)', () => {
      expect(shouldAIFire('mine', 1, 0.4, false, false)).toBe(false)
    })
  })

  describe('missile', () => {
    it('fires when target acquired AND on a straight', () => {
      expect(shouldAIFire('missile', 0.9, 0, false, true)).toBe(true)
    })
    it('does NOT fire without a target, even on a straight', () => {
      expect(shouldAIFire('missile', 1, 0, false, false)).toBe(false)
    })
    it('does NOT fire mid-corner even with a target acquired', () => {
      expect(shouldAIFire('missile', 0.5, 0.7, false, true)).toBe(false)
    })
    it('boundary: throttle = 0.8 exactly does not fire (strict >)', () => {
      expect(shouldAIFire('missile', 0.8, 0, false, true)).toBe(false)
    })
  })
})
