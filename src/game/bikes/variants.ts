import type { BikeStatsData } from '@/game/components'
import { defaultBikeStats } from './stats'

/**
 * Bike archetypes. Three flavors with explicit handling tradeoffs so
 * picking a bike feels like a real choice, not just a recolor.
 *
 * - racer: the balanced default. Numbers come straight from
 *   defaultBikeStats(); preserves every existing test and tuning.
 * - cruiser: heavy, high top speed, sluggish handling. Loves long
 *   straights, wallows through chop. Lowest surfaceFollow so waves
 *   don't toss it around.
 * - stunt: light, agile, lower top speed but strong accel + handling.
 *   Highest surfaceFollow — banks the wave geometry hard, fun on
 *   Cliffside's drops.
 */
export type BikeVariantId = 'cruiser' | 'racer' | 'stunt'

export type BikeVariant = {
  id: BikeVariantId
  /** Display name for the garage menu. */
  name: string
  /** One-line tooltip describing the feel. */
  tagline: string
  /** Body color of the rendered mesh. */
  bodyColor: number
  /** Accent color shown in the menu / on the trail. */
  accentColor: number
  /** Sim-side stats for the bike. */
  stats: BikeStatsData
}

function withDefaults(overrides: Partial<BikeStatsData>): BikeStatsData {
  return { ...defaultBikeStats(), ...overrides }
}

export const BIKE_VARIANTS: Record<BikeVariantId, BikeVariant> = {
  cruiser: {
    id: 'cruiser',
    name: 'Cruiser',
    tagline: 'Heavy hitter — big top speed, plows through chop',
    bodyColor: 0x335599,
    accentColor: 0x55aaff,
    stats: withDefaults({
      mass: 160,
      accel: 18,
      topSpeed: 32,
      turnTorque: 3.5,
      lateralDrag: 6,
      surfaceFollow: 0.42,
      hoverSpring: 24,
      hoverDamp: 7,
    }),
  },
  racer: {
    id: 'racer',
    name: 'Racer',
    tagline: 'Balanced all-rounder — the default',
    bodyColor: 0xff7733,
    accentColor: 0xffaa55,
    stats: withDefaults({}), // stays at defaults
  },
  stunt: {
    id: 'stunt',
    name: 'Stunt',
    tagline: 'Light + agile — banks every wave',
    bodyColor: 0x33aa66,
    accentColor: 0x66ff99,
    stats: withDefaults({
      mass: 90,
      accel: 26,
      topSpeed: 25,
      turnTorque: 5.5,
      lateralDrag: 8,
      surfaceFollow: 0.95,
      hoverSpring: 32,
      hoverDamp: 5,
    }),
  },
}

export const DEFAULT_BIKE_VARIANT: BikeVariantId = 'racer'

export function resolveBikeVariant(id: string | null | undefined): BikeVariant {
  if (id && id in BIKE_VARIANTS) return BIKE_VARIANTS[id as BikeVariantId]
  return BIKE_VARIANTS[DEFAULT_BIKE_VARIANT]
}
