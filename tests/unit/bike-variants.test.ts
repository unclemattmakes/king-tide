import { describe, expect, it } from 'vitest'
import { defaultBikeStats } from '../../src/game/bikes/stats'
import {
  BIKE_VARIANTS,
  DEFAULT_BIKE_VARIANT,
  resolveBikeVariant,
} from '../../src/game/bikes/variants'

describe('bike variants', () => {
  it('exposes exactly three archetypes', () => {
    expect(Object.keys(BIKE_VARIANTS).sort()).toEqual(['cruiser', 'racer', 'stunt'])
  })

  it('every variant carries a full stats block (no undefined leaks)', () => {
    const required = Object.keys(defaultBikeStats()) as Array<
      keyof ReturnType<typeof defaultBikeStats>
    >
    for (const v of Object.values(BIKE_VARIANTS)) {
      for (const k of required) {
        expect(v.stats[k], `${v.id} missing ${k}`).not.toBeUndefined()
      }
    }
  })

  it('racer variant matches defaultBikeStats() — no behavior drift from M9.13', () => {
    expect(BIKE_VARIANTS.racer.stats).toEqual(defaultBikeStats())
  })

  it('cruiser is heavier with higher top speed and lower turn rate', () => {
    expect(BIKE_VARIANTS.cruiser.stats.mass).toBeGreaterThan(BIKE_VARIANTS.racer.stats.mass)
    expect(BIKE_VARIANTS.cruiser.stats.topSpeed).toBeGreaterThan(BIKE_VARIANTS.racer.stats.topSpeed)
    expect(BIKE_VARIANTS.cruiser.stats.turnTorque).toBeLessThan(
      BIKE_VARIANTS.racer.stats.turnTorque,
    )
    expect(BIKE_VARIANTS.cruiser.stats.surfaceFollow).toBeLessThan(
      BIKE_VARIANTS.racer.stats.surfaceFollow,
    )
  })

  it('stunt is lighter with stronger handling and higher surface follow', () => {
    expect(BIKE_VARIANTS.stunt.stats.mass).toBeLessThan(BIKE_VARIANTS.racer.stats.mass)
    expect(BIKE_VARIANTS.stunt.stats.turnTorque).toBeGreaterThan(
      BIKE_VARIANTS.racer.stats.turnTorque,
    )
    expect(BIKE_VARIANTS.stunt.stats.surfaceFollow).toBeGreaterThan(
      BIKE_VARIANTS.racer.stats.surfaceFollow,
    )
  })

  it('resolveBikeVariant picks the named variant', () => {
    expect(resolveBikeVariant('cruiser').id).toBe('cruiser')
    expect(resolveBikeVariant('stunt').id).toBe('stunt')
    expect(resolveBikeVariant('racer').id).toBe('racer')
  })

  it('resolveBikeVariant falls back to default for unknown / null / empty inputs', () => {
    expect(resolveBikeVariant(null).id).toBe(DEFAULT_BIKE_VARIANT)
    expect(resolveBikeVariant(undefined).id).toBe(DEFAULT_BIKE_VARIANT)
    expect(resolveBikeVariant('').id).toBe(DEFAULT_BIKE_VARIANT)
    expect(resolveBikeVariant('does-not-exist').id).toBe(DEFAULT_BIKE_VARIANT)
  })
})
