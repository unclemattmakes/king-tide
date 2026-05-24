/**
 * Surface-type registry + profiles — the per-material grip system that
 * lets a track mix asphalt / sand / ice / metal patches.
 *
 * Pins the three things the rest of the engine depends on:
 *  1. `SURFACE_PROFILES` grip ordering (ice < sand < default = asphalt
 *     = water < metal) — so a tuning edit can't silently invert a
 *     surface's feel.
 *  2. `asSurfaceType` / `surfaceGripMul` narrowing + safe fallback —
 *     untrusted JSON / GLB reads must never throw or grip-multiply by
 *     undefined.
 *  3. `createSurfaceRegistry` tag/get/clear semantics, including the
 *     DEFAULT short-circuit (no map entry for the common case).
 */

import { describe, expect, it } from 'vitest'
import {
  asSurfaceType,
  createSurfaceRegistry,
  SURFACE_PROFILES,
  SurfaceType,
  surfaceGripMul,
} from '../../src/engine/sim/surface-types'

describe('SURFACE_PROFILES', () => {
  it('DEFAULT + ASPHALT + WATER are neutral (1.0) so existing tracks are unchanged', () => {
    expect(SURFACE_PROFILES.default.lateralGripMul).toBe(1.0)
    expect(SURFACE_PROFILES.asphalt.lateralGripMul).toBe(1.0)
    // Water's distinctive lateral feel is owned by the isWater path in
    // hover.ts — the profile stays neutral to avoid double-counting.
    expect(SURFACE_PROFILES.water.lateralGripMul).toBe(1.0)
  })

  it('grip ordering: ice < sand < default < metal', () => {
    const ice = SURFACE_PROFILES.ice.lateralGripMul
    const sand = SURFACE_PROFILES.sand.lateralGripMul
    const def = SURFACE_PROFILES.default.lateralGripMul
    const metal = SURFACE_PROFILES.metal.lateralGripMul
    expect(ice).toBeLessThan(sand)
    expect(sand).toBeLessThan(def)
    expect(def).toBeLessThan(metal)
  })

  it('every surface type has a profile + a label', () => {
    for (const type of Object.values(SurfaceType)) {
      expect(SURFACE_PROFILES[type]).toBeDefined()
      expect(typeof SURFACE_PROFILES[type].label).toBe('string')
      expect(SURFACE_PROFILES[type].label.length).toBeGreaterThan(0)
    }
  })
})

describe('asSurfaceType', () => {
  it('returns the value for every known surface type', () => {
    for (const type of Object.values(SurfaceType)) {
      expect(asSurfaceType(type)).toBe(type)
    }
  })

  it('returns undefined for unknown strings + non-strings', () => {
    expect(asSurfaceType('lava')).toBeUndefined()
    expect(asSurfaceType('DEFAULT')).toBeUndefined() // case-sensitive
    expect(asSurfaceType('')).toBeUndefined()
    expect(asSurfaceType(null)).toBeUndefined()
    expect(asSurfaceType(42)).toBeUndefined()
    expect(asSurfaceType(undefined)).toBeUndefined()
  })
})

describe('surfaceGripMul', () => {
  it('matches the profile table for each type', () => {
    expect(surfaceGripMul(SurfaceType.ICE)).toBe(SURFACE_PROFILES.ice.lateralGripMul)
    expect(surfaceGripMul(SurfaceType.METAL)).toBe(SURFACE_PROFILES.metal.lateralGripMul)
  })

  it('falls back to 1.0 for undefined — a missing tag is always safe', () => {
    expect(surfaceGripMul(undefined)).toBe(1.0)
  })
})

describe('createSurfaceRegistry', () => {
  it('returns DEFAULT for an untagged handle', () => {
    const reg = createSurfaceRegistry()
    expect(reg.get(7)).toBe(SurfaceType.DEFAULT)
  })

  it('tags + reads back a non-default surface', () => {
    const reg = createSurfaceRegistry()
    reg.tag(7, SurfaceType.ICE)
    expect(reg.get(7)).toBe(SurfaceType.ICE)
    expect(reg.size()).toBe(1)
  })

  it('does NOT store a DEFAULT tag — the lookup falls back anyway', () => {
    const reg = createSurfaceRegistry()
    reg.tag(7, SurfaceType.DEFAULT)
    expect(reg.size()).toBe(0)
    expect(reg.get(7)).toBe(SurfaceType.DEFAULT)
  })

  it('clear() drops every tag', () => {
    const reg = createSurfaceRegistry()
    reg.tag(1, SurfaceType.SAND)
    reg.tag(2, SurfaceType.METAL)
    expect(reg.size()).toBe(2)
    reg.clear()
    expect(reg.size()).toBe(0)
    expect(reg.get(1)).toBe(SurfaceType.DEFAULT)
  })

  it('a later tag on the same handle overwrites the earlier one', () => {
    const reg = createSurfaceRegistry()
    reg.tag(3, SurfaceType.SAND)
    reg.tag(3, SurfaceType.ICE)
    expect(reg.get(3)).toBe(SurfaceType.ICE)
    expect(reg.size()).toBe(1)
  })
})
