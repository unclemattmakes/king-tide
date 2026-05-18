import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EMITTER_CONFIG,
  lerpRgba,
  lerpScalar,
  readEmitterConfig,
  spawnCountForDt,
} from '../../src/engine/render/particle-system'

/**
 * Unit tests for the pure logic that drives the unified particle
 * system. We avoid spinning up three.js / WebGPU here — the
 * test surface that matters at the algorithm level is:
 *
 *   * Deterministic per-tick spawn counts given a known emit rate +
 *     accumulator. Drives the "no extra particles at small dt" guard
 *     that makes burst counts predictable.
 *   * Per-particle aging: size/colour ramps lerp from start → end at
 *     t=0, t=lifetime/2, t=lifetime. The runtime uses the same
 *     ``lerpScalar`` / ``lerpRgba`` helpers in its tight loop.
 *   * ``readEmitterConfig`` round-trips Blender extras (snake_case)
 *     and applies the documented defaults for missing fields. This is
 *     the contract authors rely on when they leave a stamp-by-default
 *     field alone in custom properties.
 */

describe('spawnCountForDt — deterministic per-tick spawn counts', () => {
  it('zero rate yields zero spawns', () => {
    expect(spawnCountForDt(0, 0, 1.0)).toEqual({ spawn: 0, accum: 0 })
    expect(spawnCountForDt(0.4, 0, 1.0)).toEqual({ spawn: 0, accum: 0.4 })
  })

  it('exact rate produces exactly one particle per second', () => {
    // 30 particles/s × 1/30 s = 1.0 → 1 spawn, accum back to 0
    const a = spawnCountForDt(0, 30, 1 / 30)
    expect(a.spawn).toBe(1)
    expect(a.accum).toBeCloseTo(0, 6)
  })

  it('accumulator carries fractional spawns across frames', () => {
    // 30/s at 60 fps = 0.5 spawns per frame. After two frames, exactly
    // one spawn, accumulator back to zero.
    let state = { spawn: 0, accum: 0 }
    let totalSpawns = 0
    for (let i = 0; i < 2; i++) {
      state = spawnCountForDt(state.accum, 30, 1 / 60)
      totalSpawns += state.spawn
    }
    expect(totalSpawns).toBe(1)
    expect(state.accum).toBeCloseTo(0, 6)
  })

  it('large dt + large rate produces correct integer batch', () => {
    // 100/s × 0.1 s = 10 exactly.
    const a = spawnCountForDt(0, 100, 0.1)
    expect(a.spawn).toBe(10)
    expect(a.accum).toBeCloseTo(0, 6)
  })

  it('carries non-trivial accumulator forward without losing fractional spawns', () => {
    // Pre-existing accumulator 0.4 plus 30/s × 1/60 (= 0.5) = 0.9
    // → 0 spawns, accum 0.9.
    const a = spawnCountForDt(0.4, 30, 1 / 60)
    expect(a.spawn).toBe(0)
    expect(a.accum).toBeCloseTo(0.9, 6)
    // Next tick (+0.5) crosses 1 → 1 spawn, accum 0.4.
    const b = spawnCountForDt(a.accum, 30, 1 / 60)
    expect(b.spawn).toBe(1)
    expect(b.accum).toBeCloseTo(0.4, 6)
  })

  it('matches the documented 8-emitter steady state bound', () => {
    // Sanity check that the system caps don't drift. 8 emitters at 30/s
    // with default 1.5 s lifetime → expected steady state ≤ 360 alive
    // across all pools (8 × 30 × 1.5 = 360). The runtime budget for
    // shared cells is 256 each so two distinct cells can hold this
    // comfortably; the tick should produce ~30 spawns/second/emitter.
    let accum = 0
    let total = 0
    for (let i = 0; i < 60; i++) {
      const r = spawnCountForDt(accum, 30, 1 / 60)
      accum = r.accum
      total += r.spawn
    }
    // 30 particles per simulated second per emitter, within rounding.
    expect(total).toBe(30)
  })
})

describe('lerpScalar / lerpRgba — per-particle aging math', () => {
  it('lerpScalar at t=0 returns start', () => {
    expect(lerpScalar(0.4, 1.2, 0)).toBeCloseTo(0.4, 6)
  })

  it('lerpScalar at t=1 returns end', () => {
    expect(lerpScalar(0.4, 1.2, 1)).toBeCloseTo(1.2, 6)
  })

  it('lerpScalar at t=0.5 returns midpoint', () => {
    expect(lerpScalar(0.4, 1.2, 0.5)).toBeCloseTo(0.8, 6)
  })

  it('lerpRgba at lifetime/2 lands halfway on every channel', () => {
    const start: [number, number, number, number] = [1, 1, 1, 1]
    const end: [number, number, number, number] = [1, 0.2, 0, 0]
    const mid = lerpRgba(start, end, 0.5)
    expect(mid[0]).toBeCloseTo(1.0, 6)
    expect(mid[1]).toBeCloseTo(0.6, 6)
    expect(mid[2]).toBeCloseTo(0.5, 6)
    expect(mid[3]).toBeCloseTo(0.5, 6)
  })

  it('lerpRgba at t=0 returns start, at t=1 returns end', () => {
    const start: [number, number, number, number] = [0.5, 0.6, 0.7, 0.8]
    const end: [number, number, number, number] = [0.1, 0.2, 0.3, 0.4]
    const at0 = lerpRgba(start, end, 0)
    const at1 = lerpRgba(start, end, 1)
    // toEqual on floats trips on IEEE noise (1*0.5 + 0*0.1 isn't bit-exact);
    // compare channel-wise with toBeCloseTo.
    for (let i = 0; i < 4; i++) {
      expect(at0[i]!).toBeCloseTo(start[i]!, 9)
      expect(at1[i]!).toBeCloseTo(end[i]!, 9)
    }
  })

  it('size ramp at three timepoints — t=0, lifetime/2, lifetime', () => {
    const sizeStart = 0.4
    const sizeEnd = 1.2
    expect(lerpScalar(sizeStart, sizeEnd, 0)).toBeCloseTo(sizeStart, 6)
    expect(lerpScalar(sizeStart, sizeEnd, 0.5)).toBeCloseTo((sizeStart + sizeEnd) * 0.5, 6)
    expect(lerpScalar(sizeStart, sizeEnd, 1)).toBeCloseTo(sizeEnd, 6)
  })
})

describe('readEmitterConfig — Blender extras → runtime', () => {
  it('returns defaults when no extras present', () => {
    const cfg = readEmitterConfig('emitter_00', {})
    expect(cfg).toEqual({ name: 'emitter_00', ...DEFAULT_EMITTER_CONFIG })
  })

  it('reads snake_case Blender extras', () => {
    const cfg = readEmitterConfig('emitter_03', {
      atlas_cell: 7,
      emit_rate: 60,
      lifetime_s: 0.5,
      velocity_cone_deg: 90,
      speed_min: 5,
      speed_max: 12,
      size_start: 0.2,
      size_end: 0.8,
      color_start: [1, 0.5, 0, 1],
      color_end: [1, 0, 0, 0],
      gravity: -9.8,
      max_particles: 512,
    })
    expect(cfg.name).toBe('emitter_03')
    expect(cfg.atlasCell).toBe(7)
    expect(cfg.emitRate).toBe(60)
    expect(cfg.lifetimeS).toBe(0.5)
    expect(cfg.velocityConeDeg).toBe(90)
    expect(cfg.speedMin).toBe(5)
    expect(cfg.speedMax).toBe(12)
    expect(cfg.sizeStart).toBe(0.2)
    expect(cfg.sizeEnd).toBe(0.8)
    expect(cfg.colorStart).toEqual([1, 0.5, 0, 1])
    expect(cfg.colorEnd).toEqual([1, 0, 0, 0])
    expect(cfg.gravity).toBe(-9.8)
    expect(cfg.maxParticles).toBe(512)
  })

  it('clamps atlas_cell into [0, 15]', () => {
    expect(readEmitterConfig('e', { atlas_cell: -5 }).atlasCell).toBe(0)
    expect(readEmitterConfig('e', { atlas_cell: 99 }).atlasCell).toBe(15)
    expect(readEmitterConfig('e', { atlas_cell: 8.7 }).atlasCell).toBe(8)
  })

  it('falls back to defaults for non-finite or wrong-type extras', () => {
    const cfg = readEmitterConfig('e', {
      emit_rate: 'oops' as unknown as number,
      lifetime_s: Number.NaN,
      color_start: 'not-an-array' as unknown as number[],
    })
    expect(cfg.emitRate).toBe(DEFAULT_EMITTER_CONFIG.emitRate)
    expect(cfg.lifetimeS).toBe(DEFAULT_EMITTER_CONFIG.lifetimeS)
    expect(cfg.colorStart).toEqual(DEFAULT_EMITTER_CONFIG.colorStart)
  })

  it('rejects negative emit_rate and lifetimes', () => {
    expect(readEmitterConfig('e', { emit_rate: -5 }).emitRate).toBe(0)
    // Tiny floor of 0.01 stops a division-by-zero in the aging code.
    expect(readEmitterConfig('e', { lifetime_s: 0 }).lifetimeS).toBeGreaterThanOrEqual(0.01)
  })

  it('accepts camelCase as a fallback for hand-coded fixtures', () => {
    // The Blender side always writes snake_case, but tests that construct
    // userData by hand sometimes prefer camelCase. Tolerated.
    const cfg = readEmitterConfig('e', { emitRate: 45, sizeStart: 0.3 })
    expect(cfg.emitRate).toBe(45)
    expect(cfg.sizeStart).toBe(0.3)
  })
})
