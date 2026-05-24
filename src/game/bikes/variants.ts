import type { BikeStatsData } from '@/game/components'
import { defaultBikeStats } from './stats'

/**
 * Bike archetypes. Five flavors with explicit handling tradeoffs so
 * picking a bike feels like a real choice, not just a recolor. Closes
 * Phase F of `docs/v1-asset-pipeline-plan.md` (the design-targets target
 * of five variants — three middleweights bracketed by a heavy + a light
 * so wave-pump feel reads across the band).
 *
 * - racer: the balanced default. Numbers come straight from
 *   defaultBikeStats(); preserves every existing test and tuning.
 * - cruiser: heavy, high top speed, sluggish handling. Loves long
 *   straights, wallows through chop. Lowest surfaceFollow so waves
 *   don't toss it around.
 * - stunt: light, agile, lower top speed but strong accel + handling.
 *   Highest surfaceFollow — banks the wave geometry hard, fun on
 *   Cliffside's drops.
 * - scout: heavyweight — punishing wave-pump timing, biggest launch.
 *   Soft hover spring + low surfaceFollow means the bike feels late
 *   off the crest; nail the timing and the inertia carries through
 *   the chop. Per v1-work-breakdown.md: "heavy = punishing wave-pump
 *   timing + biggest launch".
 * - sparrow: lightweight — forgiving wave-pump timing, further air
 *   on small swells. Stiff hover spring + high surfaceFollow means
 *   even a sloppy crest read produces a clean launch. Per
 *   v1-work-breakdown.md: "light = forgiving + further launch".
 */
export type BikeVariantId = 'cruiser' | 'racer' | 'stunt' | 'scout' | 'sparrow'

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
      mass: 200,
      accel: 16,
      topSpeed: 32,
      turnTorque: 3.0,
      lateralDrag: 7,
      surfaceFollow: 0.55,
      hoverSpring: 24,
      hoverDamp: 9,
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
    tagline: 'Light + agile — banks every wave, inside-drift carve',
    bodyColor: 0x33aa66,
    accentColor: 0x66ff99,
    stats: withDefaults({
      mass: 115,
      accel: 24,
      topSpeed: 25,
      turnTorque: 5.0,
      lateralDrag: 9,
      surfaceFollow: 1.0,
      hoverSpring: 32,
      hoverDamp: 6,
      // Inside-drift sport-bike feel — sharper initial cut, wider
      // overall arc. Pairs with the high turnTorque so the bike
      // really snaps into the apex on the first 250 ms.
      driftStyle: 'inward',
    }),
  },
  // Heavyweight #4 — wears the punishing-pump role from
  // v1-asset-pipeline-plan.md Phase F. Soft hover spring (22 vs 34
  // default) is what makes the timing "punishing": the bike reacts
  // late to the crest, so an early E flick is wasted and a late one
  // launches off air. Once airborne, the heaviest mass in the lineup
  // carries the most kinetic energy through the chop.
  scout: {
    id: 'scout',
    name: 'Scout',
    tagline: 'Heavyweight — punishing pump, biggest launch',
    bodyColor: 0xff6633,
    accentColor: 0x5cf2ff,
    stats: withDefaults({
      mass: 220,
      accel: 14,
      topSpeed: 32,
      turnTorque: 2.5,
      lateralDrag: 6,
      surfaceFollow: 0.4,
      hoverSpring: 22,
      hoverDamp: 10,
      hoverHeight: 0.8,
    }),
  },
  // Lightweight #5 — the design-targets "forgiving + further air".
  // Stiff hover spring (38) means the bike springs off a crest with a
  // wide tolerance window for the pump input; high surfaceFollow
  // (1.05) keeps the chassis tracking small wavelets so even sloppy
  // wave-reading still produces meaningful lift. Modest top speed
  // keeps it from out-running the Cruiser on long straights — the
  // tradeoff for the pump latitude.
  sparrow: {
    id: 'sparrow',
    name: 'Sparrow',
    tagline: 'Lightweight — forgiving pump, inside-drift sport bike',
    bodyColor: 0xddbb44,
    accentColor: 0xfff088,
    stats: withDefaults({
      mass: 80,
      accel: 22,
      topSpeed: 26,
      turnTorque: 5.5,
      lateralDrag: 9,
      surfaceFollow: 1.05,
      hoverSpring: 38,
      hoverDamp: 5.5,
      // Inside-drift sport-bike feel. The Sparrow's high turn-torque
      // (5.5 vs the 4.0 default) means the initial cut is dramatic;
      // the wider-arc tail is what stops the lightweight bike from
      // just rotating in place mid-drift.
      driftStyle: 'inward',
    }),
  },
}

export const DEFAULT_BIKE_VARIANT: BikeVariantId = 'racer'

export function resolveBikeVariant(id: string | null | undefined): BikeVariant {
  if (id && id in BIKE_VARIANTS) return BIKE_VARIANTS[id as BikeVariantId]
  return BIKE_VARIANTS[DEFAULT_BIKE_VARIANT]
}
