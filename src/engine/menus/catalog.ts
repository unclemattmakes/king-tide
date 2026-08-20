import type { TrackManifestEntry } from '@/game/assets/manifest'
import { BIKE_VARIANTS, type BikeVariantId } from '@/game/bikes/variants'
import { formatLap } from '../garage'
import { getBestLap } from '../save-state'

/** Sports-broadcast UI catalogues for tracks + bikes.
 *
 *  Pure data. The menu screens read these to render their cards, stat
 *  bars, and best-lap callouts.
 */

export type TrackEntry = {
  id: string
  name: string
  tagline: string
  /** Hex color used as the card's accent stripe + selected outline. */
  accent: string
}

const PROCEDURAL_TRACKS: TrackEntry[] = [
  {
    id: 'lagoon',
    name: 'Lagoon Loop',
    tagline: 'Stadium oval with a jump on the right straight.',
    accent: '#66ddff',
  },
  {
    id: 'cliffside',
    name: 'Cliffside',
    tagline: 'Mesa loop with a 15m cliff drop. The signature moment.',
    accent: '#c8b07a',
  },
]

export function buildTrackList(manifest?: TrackManifestEntry[]): TrackEntry[] {
  const out = [...PROCEDURAL_TRACKS]
  const known = new Set(out.map((t) => t.id))
  for (const m of manifest ?? []) {
    if (known.has(m.id)) continue
    out.push({
      id: m.id,
      name: m.displayName,
      tagline: 'Custom track.',
      accent: '#88aabb',
    })
    known.add(m.id)
  }
  return out
}

/** Bike stat bars normalised to 0..1 for visual comparison. The five
 *  attributes here map onto the underlying BikeStatsData with sensible
 *  ranges so each variant has a recognisable profile in the picker. */
export type BikeCard = {
  id: BikeVariantId
  name: string
  tagline: string
  accent: string
  bars: { label: string; value: number; raw: string }[]
}

function pct(value: number, min: number, max: number): number {
  const t = (value - min) / (max - min)
  return Math.max(0, Math.min(1, t))
}

export function buildBikeCards(): BikeCard[] {
  return Object.values(BIKE_VARIANTS).map((v) => {
    const s = v.stats
    return {
      id: v.id,
      name: v.name.toUpperCase(),
      tagline: v.tagline,
      accent: `#${v.accentColor.toString(16).padStart(6, '0')}`,
      bars: [
        { label: 'TOP', value: pct(s.topSpeed, 24, 33), raw: `${s.topSpeed.toFixed(0)}` },
        { label: 'ACCEL', value: pct(s.accel, 15, 24), raw: `${s.accel.toFixed(0)}` },
        { label: 'AGILITY', value: pct(s.turnTorque, 3.0, 5.5), raw: `${s.turnTorque.toFixed(1)}` },
        { label: 'WEIGHT', value: pct(s.mass, 100, 220), raw: `${s.mass.toFixed(0)}` },
        { label: 'WAVE', value: pct(s.surfaceFollow, 0.6, 1.1), raw: s.surfaceFollow.toFixed(2) },
      ],
    }
  })
}

export function bestLapFor(trackId: string, bikeId: BikeVariantId): string | null {
  const t = getBestLap({ trackId, bikeId })
  return t != null ? formatLap(t) : null
}
