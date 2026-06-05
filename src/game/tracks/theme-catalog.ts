/**
 * Per-track theme metadata — the prose layer the race intro UI reads from.
 *
 * Source of truth is [docs/track-themes.md](../../../docs/track-themes.md),
 * the v1 content bible. Each ship track + the tutorial is keyed here so the
 * broadcast intro overlay can show the postcard caption (location, set-piece,
 * a one-line lore tag) without re-deriving it from the markdown.
 *
 * Tracks that aren't in the catalog (test tracks, blockout maps) fall back
 * to a derived theme that uses `track.name` as the title and labels the
 * cup as `—`. The fallback path is hit during dev + by the procedural
 * Lagoon/Cliffside dev tracks; ship builds are expected to register every
 * shipping track explicitly.
 */

export type CupName = 'Tutorial' | 'Reef' | 'Harbor' | 'Continental' | 'Drowned'

export type TrackTheme = {
  /** Optional broadcast display name. Overrides the JSON-authored
   *  `track.name` (which is usually the slug-cased id, e.g. "the-maw")
   *  for the title card. Absent → caller falls back to `track.name`. */
  displayName?: string
  /** Hero caption — usually the real-world place. */
  location: string
  /** Cup this track belongs to (drives the corner-of-screen chip). */
  cup: CupName
  /** Hero set-piece name (e.g. "The Lamp Room"). */
  setPiece: string
  /** One-line lore tag from the content bible. Surfaces under the title. */
  lore: string
  /** Short visual mood tag for the conditions strip ("Pastel Miami pink"). */
  palette: string
  /** Time-of-day label shown in the conditions strip. Hand-curated rather
   *  than derived because the sky shader's `timeOfDay` cycle doesn't map
   *  to wall-clock prose cleanly (e.g. "golden hour" is an art call, not
   *  a sun-elevation threshold). */
  timeLabel: string
  /** Weather-headline tag for the conditions strip. */
  weatherLabel: string
}

const CATALOG: Record<string, TrackTheme> = {
  sandbar: {
    displayName: 'Sandbar',
    location: 'Pilot Cove · Sandbar Atoll',
    cup: 'Tutorial',
    setPiece: 'Training Gates',
    lore: 'A retrofitted marina, calm water, one ramp. Welcome to the Circuit.',
    palette: 'Soft turquoise lagoon',
    timeLabel: 'Mid-morning',
    weatherLabel: 'Calm · Beaufort 1',
  },
  'south-beach-sunken': {
    displayName: 'South Beach Sunken',
    location: 'Drowned Miami Beach · Florida',
    cup: 'Reef',
    setPiece: 'Versace Steps',
    lore: 'South Beach kept the lights on. Permanent spring break on the roofs.',
    palette: 'Pastel pink + neon mint',
    timeLabel: 'Late afternoon',
    weatherLabel: 'Clear · Beaufort 2',
  },
  'golden-gate-drowned': {
    displayName: 'Golden Gate Drowned',
    location: 'Drowned San Francisco · The Bay',
    cup: 'Harbor',
    setPiece: 'The Break',
    lore: 'They said the bridge would outlast the city. It outlasted the coastline too.',
    palette: 'International Orange + fog grey',
    timeLabel: 'Foggy morning',
    weatherLabel: 'Marine layer · Beaufort 3',
  },
  'needle-sound': {
    displayName: 'Needle Sound',
    location: 'Drowned Seattle · Puget Sound',
    cup: 'Harbor',
    setPiece: 'The Saucer',
    lore: 'The Sound took the waterfront back. The Needle still stands; the band still plays.',
    palette: 'Evergreen + rain-slick slate',
    timeLabel: 'Overcast midday',
    weatherLabel: 'Drizzle · Beaufort 3',
  },
  'opera-drowned': {
    displayName: 'Opera Drowned',
    location: 'Drowned Sydney · The Harbour',
    cup: 'Harbor',
    setPiece: 'The Coathanger',
    lore: 'Sydney threw the best closing party on Earth and never stopped. The sails held.',
    palette: 'Sail white + sandstone gold',
    timeLabel: 'Golden hour',
    weatherLabel: 'Harbour chop · Beaufort 4',
  },
  'cape-town-drift': {
    displayName: 'Cape Town Drift',
    location: 'V&A Waterfront · Cape Town',
    cup: 'Reef',
    setPiece: 'Two Oceans Wreck',
    lore: "Table Mountain didn't notice. Everything below it did.",
    palette: 'Atlantic blue + container red',
    timeLabel: 'Midday',
    weatherLabel: 'Bright + breezy · Beaufort 4',
  },
  'shibuya-submerged': {
    displayName: 'Shibuya Submerged',
    location: 'Drowned Tokyo · Shinjuku',
    cup: 'Continental',
    setPiece: 'Shibuya Crossing Cables',
    lore: "Tokyo didn't evacuate. They moved up. The neon's still on.",
    palette: 'Hot pink + electric blue neon',
    timeLabel: 'Dusk',
    weatherLabel: 'Light rain · Beaufort 3',
  },
  'kilauea-crown': {
    displayName: 'Kilauea Crown',
    location: 'Big Island · Hawaii',
    cup: 'Continental',
    setPiece: 'The Black Beach',
    lore: "Pele kept building. The mountain's taller now than it was in '26.",
    palette: 'Lava orange + basalt black',
    timeLabel: 'Volcanic dusk',
    weatherLabel: 'Steam plumes · Beaufort 4',
  },
  'marina-bay-7': {
    displayName: 'Marina Bay 7',
    location: 'Tuas Megaport · Singapore',
    cup: 'Continental',
    setPiece: 'The Gauntlet',
    lore: "Singapore's port automated itself in the '40s. Nobody told it to stop.",
    palette: 'Sodium yellow + container orange',
    timeLabel: 'Industrial night',
    weatherLabel: 'Humid haze · Beaufort 3',
  },
  'doges-drift': {
    displayName: "Doge's Drift",
    location: 'Drowned Venice · Adriatic',
    cup: 'Continental',
    setPiece: 'The Campanile Climb',
    lore: 'Venice was already half-flooded. The rest just took longer.',
    palette: 'Ochre, terracotta, Adriatic teal',
    timeLabel: 'Warm afternoon',
    weatherLabel: 'Calm canals · Beaufort 2',
  },
  aqualand: {
    displayName: 'Aqualand',
    location: 'Abandoned Aqualand · Florida',
    cup: 'Drowned',
    setPiece: 'The Tsunami',
    lore: "Aqualand closed in '32. The wave generator's on a solar circuit.",
    palette: 'Bleached primary + algae',
    timeLabel: 'High noon',
    weatherLabel: 'Pool weather · Beaufort 1',
  },
  'angkor-drowned': {
    displayName: 'Angkor Drowned',
    location: 'Angkor Wat · Cambodia',
    cup: 'Drowned',
    setPiece: 'The Smiling Faces',
    lore: "Angkor outlasted the Khmer Empire. The flood is just the latest thing it'll outlast.",
    palette: 'Mossy stone + jungle green',
    timeLabel: 'Dappled afternoon',
    weatherLabel: 'Jungle humid · Beaufort 2',
  },
  'liberty-drowned': {
    displayName: 'Liberty Drowned',
    location: 'Drowned Manhattan · NY Harbor',
    cup: 'Drowned',
    setPiece: 'The Torch Arm',
    lore: "She fell forward in '71. Nobody could lift her up again.",
    palette: 'Copper-green + sunset orange',
    timeLabel: 'End-of-day finale light',
    weatherLabel: 'Harbor chop · Beaufort 5',
  },
}

/** Look up a theme by track id. Returns null for unknown ids so callers
 *  can decide how to render the fallback (typically: title from
 *  `track.name`, no lore line, derived time/weather labels). */
export function getTrackTheme(trackId: string): TrackTheme | null {
  return CATALOG[trackId] ?? null
}

/** Build a best-effort theme for unknown / test / procedural tracks.
 *  Mirrors the data shape so the intro UI can consume one type. */
export function deriveFallbackTheme(
  trackId: string,
  trackName: string,
  sky: { timeOfDay?: number; cloudiness?: number; seaStateBeaufort?: number } | undefined,
): TrackTheme {
  const elevDeg = sunElevationDeg(sky?.timeOfDay ?? 0)
  const timeLabel = timeLabelForElevation(elevDeg)
  const cloudiness = sky?.cloudiness ?? 0.45
  const beaufort = sky?.seaStateBeaufort
  const weatherLabel = weatherLabelFor(cloudiness, beaufort)

  return {
    location: trackName,
    cup: 'Tutorial',
    setPiece: '—',
    lore: '',
    palette: '—',
    timeLabel,
    weatherLabel,
  }
}

/** Mirrors `sky.ts:applyStaticState` — degrees above the horizon for
 *  a given `timeOfDay`. Pure, used by the fallback theme to produce a
 *  reasonable "Sunrise / Midday / Sunset / Night" label without
 *  reaching into the live sky system. */
function sunElevationDeg(timeOfDay: number): number {
  const SUN_CYCLE_SECONDS = 360
  const phase = (timeOfDay / SUN_CYCLE_SECONDS) * Math.PI * 2
  return 22.5 + 47.5 * Math.sin(phase * 0.7)
}

function timeLabelForElevation(elevDeg: number): string {
  if (elevDeg > 55) return 'Midday'
  if (elevDeg > 35) return 'Afternoon'
  if (elevDeg > 12) return 'Morning'
  if (elevDeg > -2) return 'Golden hour'
  return 'Twilight'
}

function weatherLabelFor(cloudiness: number, beaufort: number | undefined): string {
  const sky = cloudiness < 0.2 ? 'Clear' : cloudiness < 0.55 ? 'Scattered cloud' : 'Overcast'
  if (beaufort === undefined) return sky
  return `${sky} · Beaufort ${Math.round(beaufort)}`
}
