import type { TrackManifestEntry } from '@/game/assets/manifest'

/**
 * v1 ship-track + cup catalogues.
 *
 * Pure data backing the cathedral-shell menus. Lives separate from the
 * existing `catalog.ts` (which surfaces today's procedural + manifest
 * tracks for the race-mode flow) so the "shape of the game" data (12
 * named v1 tracks, 4 cups) doesn't churn with the dev workflow.
 *
 * Until each v1 track ships, its tile renders disabled with the
 * `gateLabel` shown on hover. The visual convention is locked once in
 * the `.bc-disabled` style and reused by every gated tile across the
 * app, so a designer never needs to invent a second "not ready yet"
 * look.
 *
 * Test tracks (lagoon, cliffside, every GLB under public/assets/tracks)
 * are deliberately isolated into the Dev Cup so the real race-cup
 * lineup stays clean as it lights up sprint by sprint.
 */

export type CupId = 'reef' | 'harbor' | 'continental' | 'drowned' | 'dev' | 'dev-placeholder'

export type V1TrackEntry = {
  /** Canonical track id passed to ?track=. Hyphenated kebab-case to
   *  match the existing GLB-track naming convention. */
  id: string
  name: string
  /** Post-flood real-world landmark blurb shown on the disabled tile. */
  location: string
  /** Named hero set-piece per track-themes.md. */
  setPiece: string
  cup: Exclude<CupId, 'dev' | 'dev-placeholder'>
  /** Tile accent stripe + selected outline (hex, with #). */
  accent: string
  /** Casual-band lap target in seconds — surfaced on the tile as a hint. */
  lapTarget: number
  laps: number
  /** Hover gate label — shown when the tile is disabled. Empty once the
   *  track has shipped and `status` flips to 'ship'. */
  gateLabel: string
  /** Art state, orthogonal to `status`: 'ship' means wired + playable,
   *  NOT art-complete (CLAUDE.md). Greybox venues stay raceable but the
   *  tile badges them "EARLY ROUTE · ART PASS COMING" so the card's
   *  promise matches what loads — the playtest's biggest trust break
   *  was "neon still on" opening onto beige dunes. Flip to 'dressed'
   *  when the v2 art pass lands. */
  art: 'dressed' | 'greybox'
  /** Lights up when the track is fully built + AI-lined + audio-set. */
  status: 'ship' | 'pending'
}

/** 13 v1 tracks. Tutorial sits outside the cup structure; the other 12
 *  fall into the four cups per `docs/track-themes.md`. */
export const V1_TRACKS: V1TrackEntry[] = [
  {
    id: 'sandbar',
    name: 'Mayday Bay',
    location: 'Tutorial lagoon — fictional storm-hit resort town',
    setPiece: 'Scripted training gates',
    cup: 'reef',
    accent: '#9bdcf2',
    lapTarget: 60,
    laps: 1,
    gateLabel: '',
    art: 'dressed',
    status: 'ship',
  },
  {
    // Slug stays `mexico-city`: the GLB, the track JSON, the R2 asset
    // keys and the Blender seed all key off it, and the leaderboard
    // ledger is written against it. Only the player-facing name moved
    // fictional — same divergence `sandbar` → "Mayday Bay" already has.
    id: 'mexico-city',
    name: 'Angel Basin',
    location: 'A drowned highland capital — the lake came back',
    setPiece: 'El Ángel — gilded boulevard launch',
    cup: 'reef',
    accent: '#e4007c',
    lapTarget: 45,
    laps: 3,
    gateLabel: '',
    art: 'dressed',
    status: 'ship',
  },
  {
    // Slug stays `cape-town-drift` for the same reason as above.
    id: 'cape-town-drift',
    name: 'Container Chaos',
    location: 'A stacked container port under the flat-top mountain',
    setPiece: 'The Aquarium Wreck — toppled container maze',
    cup: 'reef',
    accent: '#3aa9d7',
    lapTarget: 48,
    laps: 3,
    gateLabel: '',
    art: 'greybox',
    status: 'ship',
  },
  // ── Harbor Cup (v2) — drowned harbor cities, the antithesis of open
  //    sea. Replaces the retired Open Sea Cup: Seattle opens, San
  //    Francisco moves up from Continental, Sydney closes. The two new
  //    concepts ship as gated tiles until their geometry is built; the
  //    cup itself stays `pending` until then (a championship can't run
  //    through two unbuilt tracks).
  {
    id: 'needle-sound',
    name: 'Needle Sound',
    location: 'Drowned Seattle — Puget Sound over the waterfront',
    setPiece: 'The Saucer — Space Needle big-air',
    cup: 'harbor',
    accent: '#3fb59a',
    lapTarget: 55,
    laps: 3,
    gateLabel: 'Concept locked · build pending',
    art: 'greybox',
    status: 'pending',
  },
  {
    id: 'golden-gate-drowned',
    name: 'Golden Gate Drowned',
    location: 'Drowned San Francisco — Financial District + the hills',
    setPiece: 'The Break — street-to-bay cliff drop',
    cup: 'harbor',
    accent: '#c8472e',
    lapTarget: 58,
    laps: 3,
    gateLabel: '',
    art: 'greybox',
    status: 'ship',
  },
  {
    id: 'opera-drowned',
    name: 'Opera Drowned',
    location: 'Drowned Sydney — half-sunk Opera House + the Coathanger',
    setPiece: 'The Coathanger — Harbour Bridge arch launch',
    cup: 'harbor',
    accent: '#e9a84e',
    lapTarget: 60,
    laps: 3,
    gateLabel: 'Concept locked · build pending',
    art: 'greybox',
    status: 'pending',
  },
  {
    id: 'marina-bay-7',
    name: 'Marina Bay 7',
    location: 'Drowned Singapore megaport',
    setPiece: 'The Gauntlet — gantry crane timers',
    cup: 'continental',
    accent: '#d4a02e',
    lapTarget: 55,
    laps: 3,
    gateLabel: '',
    art: 'greybox',
    status: 'ship',
  },
  {
    id: 'doges-drift',
    name: 'Doge’s Drift',
    location: 'Drowned Venice — Murano still blowing glass',
    setPiece: 'Campanile Climb',
    cup: 'continental',
    accent: '#d8a14a',
    lapTarget: 60,
    laps: 3,
    gateLabel: '',
    art: 'greybox',
    status: 'ship',
  },
  {
    id: 'shibuya-submerged',
    name: 'Shibuya Submerged',
    location: 'Drowned Tokyo — neon still on',
    setPiece: 'Shibuya Crossing Cables',
    cup: 'continental',
    accent: '#ff52a2',
    lapTarget: 58,
    laps: 3,
    gateLabel: '',
    art: 'greybox',
    status: 'ship',
  },
  {
    id: 'kilauea-crown',
    name: 'Kilauea Crown',
    location: 'Big Island — caldera + lava waterfall',
    setPiece: 'The Black Beach',
    cup: 'continental',
    accent: '#ff5a2b',
    lapTarget: 65,
    laps: 3,
    gateLabel: '',
    art: 'greybox',
    status: 'ship',
  },
  {
    id: 'aqualand',
    name: 'Aqualand',
    location: 'Florida waterpark — doubly drowned',
    setPiece: 'The Tsunami wave-pool timer',
    cup: 'drowned',
    accent: '#6bd1a4',
    lapTarget: 22,
    laps: 5,
    gateLabel: '',
    art: 'greybox',
    status: 'ship',
  },
  {
    id: 'angkor-drowned',
    name: 'Angkor Drowned',
    location: 'Cambodia — jungle reclaiming the towers',
    setPiece: 'Bayon’s sixteen Smiling Faces',
    cup: 'drowned',
    accent: '#7ba364',
    lapTarget: 62,
    laps: 3,
    gateLabel: '',
    art: 'greybox',
    status: 'ship',
  },
  {
    id: 'liberty-drowned',
    name: 'Liberty Drowned',
    location: 'Drowned Manhattan — sunset finale',
    setPiece: 'The Torch Arm anti-grav showcase',
    cup: 'drowned',
    accent: '#5eb89a',
    lapTarget: 70,
    laps: 3,
    gateLabel: '',
    art: 'greybox',
    status: 'ship',
  },
]

/** Cups the shipping menus are allowed to surface.
 *
 *  The catalogue above deliberately keeps the whole four-cup slate —
 *  cup rosters, the leaderboard schema, the docs and the art-pass
 *  backlog all read from it, and deleting entries to hide them would
 *  throw away that structure. Instead the front end renders only the
 *  cups named here, so the card the player sees matches what's
 *  actually finished. Widen this list (one entry per cup) as each
 *  cup's tracks come out of greybox.
 *
 *  Dev cups are unaffected — they're separate constants below and stay
 *  gated on `isDevBuild()` instead. */
export const VISIBLE_CUPS: readonly CupId[] = ['reef']

export function isCupVisible(id: CupId): boolean {
  return VISIBLE_CUPS.includes(id)
}

/** The v1 tracks the menus may show — `V1_TRACKS` filtered to
 *  `VISIBLE_CUPS`. Every player-facing surface (race track-select, the
 *  Time Trial venue picker, the leaderboards screen) renders from this
 *  rather than reaching for `V1_TRACKS` directly. */
export function visibleV1Tracks(): V1TrackEntry[] {
  return V1_TRACKS.filter((t) => isCupVisible(t.cup))
}

/** The cups the cup-select screen may show — `V1_CUPS` filtered the
 *  same way. Declared after `V1_CUPS` is initialised at module scope,
 *  so it's safe to call from render code. */
export function visibleV1Cups(): CupEntry[] {
  return V1_CUPS.filter((c) => isCupVisible(c.id))
}

/** Player-facing display name for a track id, from the same ship-track
 *  catalogue the menu tiles render. Returns `undefined` for anything
 *  not in the v1 slate — procedural + Dev Cup tracks (lagoon, cliffside,
 *  raw GLBs) have no curated name here, so callers fall back to the raw
 *  `track.name` slug from the track JSON. */
export function trackDisplayName(id: string): string | undefined {
  return V1_TRACKS.find((t) => t.id === id)?.name
}

export type CupEntry = {
  id: CupId
  name: string
  tagline: string
  /** Hex accent (with #). */
  accent: string
  status: 'ship' | 'pending'
  gateLabel: string
  /** Ordered list of track ids the cup races through in championship
   *  mode. Empty for the legacy `Dev Cup`, which is a browse-only
   *  sandbox (its track list is built per-render from the manifest).
   *  Ship cups are pre-wired to their filtered v1 tracks here so the
   *  championship lineup is locked the moment all four tracks flip to
   *  `status: 'ship'` — no extra wiring required at that point. */
  races: string[]
}

/** Ship-cup race lineup built from the v1 catalogue. The order matches
 *  the v1-work-breakdown sprint plan — Reef Cup leads with the
 *  tutorial-adjacent tracks, Drowned Cup closes on the Liberty finale. */
function shipCupRaces(id: Exclude<CupId, 'dev' | 'dev-placeholder'>): string[] {
  return V1_TRACKS.filter((t) => t.cup === id).map((t) => t.id)
}

/** The four v1 race cups, in the order they unlock. */
export const V1_CUPS: CupEntry[] = [
  {
    id: 'reef',
    name: 'Reef Cup',
    tagline: 'Starters. Bright, shallow, instructive.',
    accent: '#36c8c0',
    // All three Reef tracks are built + wired (Mayday Bay, Angel Basin,
    // Container Chaos), so the cup ships. Angel Basin's build landed via
    // the Texcoco art pass; the opener gate was flipped 2026-06-10.
    status: 'ship',
    gateLabel: '',
    races: shipCupRaces('reef'),
  },
  {
    id: 'harbor',
    name: 'Harbor Cup',
    tagline: 'Showcase. Drowned harbor cities — bridge to bridge.',
    accent: '#2fa7bf',
    status: 'pending',
    gateLabel: 'Opens when Seattle + Sydney ship',
    races: shipCupRaces('harbor'),
  },
  {
    id: 'continental',
    name: 'Continental Cup',
    tagline: 'Spectacle. Volcano, port, Venice, Tokyo.',
    accent: '#ff7a52',
    status: 'ship',
    gateLabel: '',
    races: shipCupRaces('continental'),
  },
  {
    id: 'drowned',
    name: 'Drowned Cup',
    tagline: 'Finale. Chaos, jungle climb, Liberty.',
    accent: '#e8503a',
    status: 'ship',
    gateLabel: '',
    races: shipCupRaces('drowned'),
  },
]

/** Dev Cup — the fenced-off bin for test maps so the four ship-cups
 *  stay clean of playtest pollution. Visible only on dev builds (gated
 *  by `isDevBuild()` below). Browse-only — click a tile to jump into a
 *  one-off race against that track. The actual championship-wiring
 *  proof lives in `DEV_PLACEHOLDER_CUP` below. */
export const DEV_CUP: CupEntry = {
  id: 'dev',
  name: 'Dev Cup',
  tagline: 'Playtest tracks. Dev builds only — kept off the ship cups.',
  accent: '#a78bff',
  status: 'ship',
  gateLabel: '',
  races: [],
}

/** Dev Placeholder Cup — the live wiring proof for championship mode.
 *  Three dev tracks strung into a 3-race cup so the post-race NEXT
 *  flow, the points table, and the cup-results overlay can be
 *  exercised before any of the four real cups have shipped tracks.
 *
 *  Lineup is `lagoon` (procedural oval) → `cliffside` (procedural
 *  mesa loop) → `big-bay` (GLB-backed open bay). The two procedurals
 *  are baked into the code; the GLB pulls from the asset manifest so
 *  the chain also exercises the GLB-loader path. A dev rebuilding
 *  the asset bundle without `big-bay.glb` would need to swap the
 *  third entry to whatever they have — the placeholder cup is a
 *  dev-environment fixture, not a robust product surface. */
export const DEV_PLACEHOLDER_CUP: CupEntry = {
  id: 'dev-placeholder',
  name: 'Dev Placeholder Cup',
  tagline: 'Wiring proof. 3 dev tracks, full championship flow.',
  accent: '#ff8aa1',
  status: 'ship',
  gateLabel: '',
  races: ['lagoon', 'cliffside', 'big-bay'],
}

export type DevTrackEntry = {
  id: string
  name: string
  tagline: string
  accent: string
  /** Where the track loads from — `procedural` is baked into code,
   *  `glb` is fetched via the manifest. Surfaced as a chip on the tile
   *  so the dev can see the loader path at a glance. */
  source: 'procedural' | 'glb'
}

/** Hard-coded procedural tracks (lagoon, cliffside) that don't appear
 *  in the asset manifest. Joined with the manifest entries at runtime
 *  to form the full Dev Cup track list. */
const DEV_PROCEDURAL: DevTrackEntry[] = [
  {
    id: 'lagoon',
    name: 'Lagoon Loop',
    tagline: 'Procedural — stadium oval with right-straight jump.',
    accent: '#66ddff',
    source: 'procedural',
  },
  {
    id: 'cliffside',
    name: 'Cliffside',
    tagline: 'Procedural — mesa loop with the 15m cliff drop.',
    accent: '#c8b07a',
    source: 'procedural',
  },
]

/** Build the Dev Cup track list: procedurals first, then every GLB
 *  track surfaced by the asset manifest. */
export function buildDevCupTracks(manifest?: TrackManifestEntry[]): DevTrackEntry[] {
  const out: DevTrackEntry[] = [...DEV_PROCEDURAL]
  const known = new Set(out.map((t) => t.id))
  for (const m of manifest ?? []) {
    if (known.has(m.id)) continue
    out.push({
      id: m.id,
      name: m.displayName,
      tagline: 'GLB-backed playtest track.',
      accent: '#88aabb',
      source: 'glb',
    })
    known.add(m.id)
  }
  return out
}

/** True while running under Vite's dev server. The Dev Cup tile + the
 *  test-track list are gated through this so production bundles ship
 *  without any "Dev Cup" residue. */
export function isDevBuild(): boolean {
  try {
    return Boolean(import.meta.env?.DEV)
  } catch {
    return false
  }
}
