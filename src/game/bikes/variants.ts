import type { BikeStatsData } from '@/game/components'
import { defaultBikeStats } from './stats'

/**
 * Bike roster. Five peers in a SINGLE class — pick by playstyle, not by
 * tier. Each bike wins on a couple of axes and gives ground on the others,
 * so none is a strict upgrade over another (Mario-Kart-style balance):
 * the heavier chassis trade handling for top speed, mass and launch; the
 * lighter chassis trade top speed and mass for acceleration, agility and
 * wave-grip; the Racer sits dead-centre with no weak axis. The spread is
 * tuned to a roughly equal competitive budget — final balance is a
 * playtest call, so treat these numbers as the starting point.
 *
 * What each bike wins on:
 * - racer:   the balanced default. Exactly `defaultBikeStats()` — the test
 *            suite and every tuning baseline key off it, so it stays put.
 * - cruiser: top speed + boost. Fastest flat-out and the strongest boost
 *            multiplier; pays with sluggish turn-in and the least wave-grip.
 *            Loves long straights, wallows in the chop.
 * - scout:   mass + launch. Heaviest chassis in the field (wins every
 *            contact) and the biggest air — its soft hover spring (24 vs the
 *            34 default) reacts late to a crest, so a well-timed pump
 *            slingshots the most kinetic energy of any bike. Low ride,
 *            modest accel + agility.
 * - stunt:   agility. Sharpest turn authority and high wave-grip — banks the
 *            wave geometry hard and carves the tightest line. Inside-drift.
 *            Low top speed is the price.
 * - sparrow: acceleration + forgiveness. Quickest off the line, lightest
 *            chassis, stiffest hover spring (37) for the widest pump window,
 *            highest wave-grip. Lowest top speed. Inside-drift.
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
  /** Named seated clip in `rider_mannequin.glb` this bike's rider poses with.
   *  Resolved per-bike in `rider-mannequin.ts`; falls back to `Sitting_Idle_Loop`
   *  until an Action of this name exists in the rig (so naming a pose that
   *  isn't authored yet is harmless). Author the pose in
   *  `rider-src/rider_riding_pose.blend` with a matching Action name. */
  riderClip?: string
}

function withDefaults(overrides: Partial<BikeStatsData>): BikeStatsData {
  return { ...defaultBikeStats(), ...overrides }
}

export const BIKE_VARIANTS: Record<BikeVariantId, BikeVariant> = {
  cruiser: {
    id: 'cruiser',
    riderClip: 'Ride_cruiser',
    name: 'Cruiser',
    tagline: 'Top-speed cruiser — fastest flat-out, wide through the turns',
    bodyColor: 0x335599,
    accentColor: 0x55aaff,
    // Straight-line specialist: highest top speed + strongest boost,
    // bought with the weakest turn authority and the least wave-grip.
    stats: withDefaults({
      mass: 190,
      accel: 17,
      topSpeed: 32,
      turnTorque: 3.6,
      lateralDrag: 7,
      surfaceFollow: 0.7,
      hoverSpring: 30,
      hoverDamp: 9,
      boostMul: 1.7,
    }),
  },
  racer: {
    id: 'racer',
    riderClip: 'Ride_racer',
    name: 'Racer',
    tagline: 'Balanced all-rounder — no weak axis',
    bodyColor: 0xff7733,
    accentColor: 0xffaa55,
    stats: withDefaults({}), // the balanced centre — stays at defaults
  },
  stunt: {
    id: 'stunt',
    riderClip: 'Ride_stunt',
    name: 'Stunt',
    tagline: 'Carver — sharpest handling, banks every wave, inside-drift',
    bodyColor: 0x33aa66,
    accentColor: 0x66ff99,
    // Agility specialist: top turn authority + high wave-grip, with the
    // inside-drift sport-bike carve. Lowest-but-one top speed is the cost.
    stats: withDefaults({
      mass: 128,
      accel: 21,
      topSpeed: 27,
      turnTorque: 5.3,
      lateralDrag: 9,
      surfaceFollow: 0.98,
      hoverSpring: 31,
      hoverDamp: 6.5,
      // Inside-drift: sharper initial cut, wider tail. Pairs with the high
      // turnTorque so the bike really snaps into the apex on the first 250 ms.
      driftStyle: 'inward',
    }),
  },
  scout: {
    id: 'scout',
    riderClip: 'Ride_scout',
    name: 'Scout',
    tagline: 'Big-air bruiser — heaviest chassis, biggest launch off ramps',
    bodyColor: 0xff6633,
    accentColor: 0x5cf2ff,
    // Mass + launch specialist. Soft hover spring (24 vs 34 default) reacts
    // late to a crest — an early pump is wasted, a late one launches off
    // air. The heaviest chassis then carries the most kinetic energy
    // through the chop and bullies the field in contact. Rides low.
    stats: withDefaults({
      mass: 210,
      accel: 17,
      topSpeed: 30,
      turnTorque: 3.5,
      lateralDrag: 6,
      surfaceFollow: 0.66,
      hoverSpring: 24,
      hoverDamp: 10,
      hoverHeight: 0.9,
    }),
  },
  sparrow: {
    id: 'sparrow',
    riderClip: 'Ride_sparrow',
    name: 'Sparrow',
    tagline: 'Sprinter — quickest off the line, forgiving pump, inside-drift',
    bodyColor: 0xddbb44,
    accentColor: 0xfff088,
    // Acceleration + forgiveness specialist. Lightest chassis, stiffest
    // hover spring (37) → the widest pump window (even a sloppy crest read
    // still launches) and the highest wave-grip. Lowest top speed is the
    // tradeoff, so it can't out-drag the Cruiser on a long straight.
    stats: withDefaults({
      mass: 115,
      accel: 23,
      topSpeed: 26,
      turnTorque: 4.7,
      lateralDrag: 9,
      surfaceFollow: 1.05,
      hoverSpring: 37,
      hoverDamp: 6,
      // Rides tallest in the lineup — high taut stance, it springs.
      hoverHeight: 1.35,
      // Inside-drift: dramatic initial cut, wider-arc tail keeps the light
      // chassis from just rotating in place mid-drift.
      driftStyle: 'inward',
    }),
  },
}

export const DEFAULT_BIKE_VARIANT: BikeVariantId = 'racer'

export function resolveBikeVariant(id: string | null | undefined): BikeVariant {
  if (id && id in BIKE_VARIANTS) return BIKE_VARIANTS[id as BikeVariantId]
  return BIKE_VARIANTS[DEFAULT_BIKE_VARIANT]
}

/**
 * Per-slot variant palette for the AI grid. Rotates through the roster so
 * the field has handling *and* visual variety — slot 1 rides a Cruiser,
 * slot 2 a Stunt, and so on, wrapping for larger grids. Slot 0 is the
 * player, so AI grid slots are 1-based.
 *
 * Single source of truth shared by the sim-side spawn (which applies each
 * AI's variant stats — see `spawn-bikes.ts`), the broadcast intro roster,
 * and the replay recorder, so all three agree on which bike each AI rides.
 */
export const AI_VARIANT_ROTATION: readonly BikeVariantId[] = [
  'cruiser',
  'stunt',
  'racer',
  'scout',
  'sparrow',
  'cruiser',
  'stunt',
]

/** Resolve the bike variant for a 1-based AI grid slot (slot 0 = player). */
export function variantForAiSlot(slot: number): BikeVariant {
  const id = AI_VARIANT_ROTATION[(slot - 1) % AI_VARIANT_ROTATION.length] ?? DEFAULT_BIKE_VARIANT
  return BIKE_VARIANTS[id]
}
