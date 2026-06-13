import { describe, expect, it } from 'vitest'

import {
  autoTier,
  QUALITY_PRESETS,
  type QualityPreset,
  resolveQuality,
} from '../../src/engine/render/quality-preset'

/**
 * The quality ladder's pure resolution logic — the "various devices" knob.
 * Tier knob bundles + auto-tiering are the bits a regression would silently
 * mis-pick (e.g. a WebGL2 phone landing on High), so pin them.
 */

describe('autoTier', () => {
  it('drops a WebGL2 (no-WebGPU) fallback device to low', () => {
    expect(autoTier({ backend: 'webgl2', isDeck: false })).toBe('low')
    // WebGL2 wins even if the deck signal also fires.
    expect(autoTier({ backend: 'webgl2', isDeck: true })).toBe('low')
  })

  it('puts a Steam Deck on medium', () => {
    expect(autoTier({ backend: 'webgpu', isDeck: true })).toBe('medium')
  })

  it('gives a real WebGPU desktop/laptop high', () => {
    expect(autoTier({ backend: 'webgpu', isDeck: false })).toBe('high')
  })
})

describe('resolveQuality', () => {
  const desktop = { backend: 'webgpu' as const, isDeck: false }

  it('passes explicit tiers straight through, ignoring device context', () => {
    for (const tier of ['high', 'medium', 'low'] as const) {
      const { tier: resolved } = resolveQuality(tier, {
        backend: 'webgl2',
        isDeck: true,
      })
      expect(resolved).toBe(tier)
    }
  })

  it('resolves auto via the device context', () => {
    expect(resolveQuality('auto', desktop).tier).toBe('high')
    expect(resolveQuality('auto', { backend: 'webgl2', isDeck: false }).tier).toBe('low')
  })

  it('high keeps every pass; low sheds the structural ones', () => {
    const high = resolveQuality('high', desktop).knobs
    expect(high.shadows).toBe(true)
    expect(high.msaa).toBe(true)
    expect(high.reflection).toBe(true)
    expect(high.bloom).toBe(true)

    const low = resolveQuality('low', desktop).knobs
    expect(low.shadows).toBe(false)
    expect(low.msaa).toBe(false)
    expect(low.reflection).toBe(false)
    expect(low.bloom).toBe(false)
    // Low still renders water, just at a coarser mesh.
    expect(low.waterSubdivisions).toBeLessThan(high.waterSubdivisions)
  })

  it('medium is a middle ground — keeps the look, sheds the GPU fill', () => {
    const m = resolveQuality('medium', desktop).knobs
    expect(m.shadows).toBe(true) // look-defining, kept
    expect(m.reflection).toBe(true)
    expect(m.bloom).toBe(true)
    expect(m.msaa).toBe(false) // cheap-to-lose fill, dropped
    expect(m.shadowMapSize).toBeLessThan(resolveQuality('high', desktop).knobs.shadowMapSize)
  })

  it('every preset value resolves to a known tier (no gaps)', () => {
    for (const p of QUALITY_PRESETS) {
      const { tier, knobs } = resolveQuality(p as QualityPreset, desktop)
      expect(['high', 'medium', 'low']).toContain(tier)
      expect(typeof knobs.waterSubdivisions).toBe('number')
    }
  })
})
