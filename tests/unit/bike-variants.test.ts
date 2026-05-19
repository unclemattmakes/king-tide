import { describe, expect, it } from 'vitest'
import { defaultBikeStats } from '../../src/game/bikes/stats'
import {
  BIKE_VARIANTS,
  DEFAULT_BIKE_VARIANT,
  resolveBikeVariant,
} from '../../src/game/bikes/variants'

describe('bike variants', () => {
  it('exposes the v1 five-archetype lineup (Phase F of v1-asset-pipeline-plan.md)', () => {
    expect(Object.keys(BIKE_VARIANTS).sort()).toEqual([
      'cruiser',
      'racer',
      'scout',
      'sparrow',
      'stunt',
    ])
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

  it('scout (heavyweight) is heaviest with the softest hover spring — punishing pump timing', () => {
    // Heaviest in the lineup so launch carries through chop.
    const masses = Object.values(BIKE_VARIANTS).map((v) => v.stats.mass)
    expect(BIKE_VARIANTS.scout.stats.mass).toBe(Math.max(...masses))
    // Softer hover spring than the default — late reaction to crests
    // is what makes the timing "punishing" per the design-targets.
    expect(BIKE_VARIANTS.scout.stats.hoverSpring).toBeLessThan(
      BIKE_VARIANTS.racer.stats.hoverSpring,
    )
    // Plows through chop — low surfaceFollow.
    expect(BIKE_VARIANTS.scout.stats.surfaceFollow).toBeLessThan(
      BIKE_VARIANTS.cruiser.stats.surfaceFollow,
    )
  })

  it('sparrow (lightweight) is lightest with the stiffest hover spring — forgiving pump', () => {
    // Lightest in the lineup so even small swells launch it cleanly.
    const masses = Object.values(BIKE_VARIANTS).map((v) => v.stats.mass)
    expect(BIKE_VARIANTS.sparrow.stats.mass).toBe(Math.min(...masses))
    // Stiff hover spring + high surfaceFollow = forgiving pump per
    // the v1-work-breakdown's "light = forgiving + further launch".
    expect(BIKE_VARIANTS.sparrow.stats.hoverSpring).toBeGreaterThan(
      BIKE_VARIANTS.racer.stats.hoverSpring,
    )
    expect(BIKE_VARIANTS.sparrow.stats.surfaceFollow).toBeGreaterThan(
      BIKE_VARIANTS.stunt.stats.surfaceFollow,
    )
  })

  it('resolveBikeVariant picks the named variant — all five archetypes round-trip', () => {
    expect(resolveBikeVariant('cruiser').id).toBe('cruiser')
    expect(resolveBikeVariant('stunt').id).toBe('stunt')
    expect(resolveBikeVariant('racer').id).toBe('racer')
    expect(resolveBikeVariant('scout').id).toBe('scout')
    expect(resolveBikeVariant('sparrow').id).toBe('sparrow')
  })

  it('resolveBikeVariant falls back to default for unknown / null / empty inputs', () => {
    expect(resolveBikeVariant(null).id).toBe(DEFAULT_BIKE_VARIANT)
    expect(resolveBikeVariant(undefined).id).toBe(DEFAULT_BIKE_VARIANT)
    expect(resolveBikeVariant('').id).toBe(DEFAULT_BIKE_VARIANT)
    expect(resolveBikeVariant('does-not-exist').id).toBe(DEFAULT_BIKE_VARIANT)
  })
})
