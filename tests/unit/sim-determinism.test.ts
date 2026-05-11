/**
 * M10.1 — sim determinism (PRNG layer).
 *
 * Multiplayer lockstep requires that two peers with the same seed and the
 * same inputs produce bit-identical state. This file covers the PRNG and
 * the sim-side RNG-using helpers. Full physics-level determinism is
 * verified separately in M10.2 (needs Rapier WASM init, runs as e2e).
 */
import { describe, expect, it } from 'vitest'
import { createSimWorld } from '../../src/engine/sim/ecs/world'
import { createRng } from '../../src/engine/sim/rng'
import { pickRandomPickupType } from '../../src/game/entities/pickup-spawn'

describe('rng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    const seqA = Array.from({ length: 100 }, () => a.next())
    const seqB = Array.from({ length: 100 }, () => b.next())
    expect(seqA).toEqual(seqB)
  })

  it('produces a different sequence for a different seed', () => {
    const a = createRng(42)
    const b = createRng(43)
    expect(a.next()).not.toBe(b.next())
  })

  it('stays inside [0, 1)', () => {
    const r = createRng(0xc0ffee)
    for (let i = 0; i < 1000; i++) {
      const v = r.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('nextInt stays inside [0, max)', () => {
    const r = createRng(1)
    for (let i = 0; i < 1000; i++) {
      const v = r.nextInt(5)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(5)
    }
  })

  it('survives a state() / setState() round-trip', () => {
    const r = createRng(7)
    for (let i = 0; i < 10; i++) r.next()
    const snapshot = r.state()
    const expected = Array.from({ length: 20 }, () => r.next())
    r.setState(snapshot)
    const replayed = Array.from({ length: 20 }, () => r.next())
    expect(replayed).toEqual(expected)
  })

  it('refuses to lock onto a zero state (mulberry32 degenerate case)', () => {
    const r = createRng(0)
    // Should not be all zeros forever.
    const distinct = new Set<number>()
    for (let i = 0; i < 10; i++) distinct.add(r.next())
    expect(distinct.size).toBeGreaterThan(1)
  })
})

describe('SimWorld rng', () => {
  it('two worlds with the same seed produce the same sequence', () => {
    const a = createSimWorld({ seed: 12345 })
    const b = createSimWorld({ seed: 12345 })
    const seqA = Array.from({ length: 50 }, () => a.rng.next())
    const seqB = Array.from({ length: 50 }, () => b.rng.next())
    expect(seqA).toEqual(seqB)
  })

  it('default seed is stable across construction', () => {
    const a = createSimWorld()
    const b = createSimWorld()
    expect(a.rng.next()).toBe(b.rng.next())
  })
})

describe('pickRandomPickupType', () => {
  it('returns the same sequence for the same seed', () => {
    const a = createSimWorld({ seed: 99 })
    const b = createSimWorld({ seed: 99 })
    const seqA = Array.from({ length: 30 }, () => pickRandomPickupType(a.rng))
    const seqB = Array.from({ length: 30 }, () => pickRandomPickupType(b.rng))
    expect(seqA).toEqual(seqB)
  })

  it('only emits values from the pool', () => {
    const w = createSimWorld({ seed: 1 })
    const pool = new Set(['boost', 'missile', 'mine', 'shield'])
    for (let i = 0; i < 200; i++) {
      expect(pool.has(pickRandomPickupType(w.rng))).toBe(true)
    }
  })
})
