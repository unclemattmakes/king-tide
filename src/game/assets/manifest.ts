/**
 * Typed reader for `public/assets/manifest.json` — the index of all
 * GLB-backed assets the headless build pipeline produced.
 *
 * `tools/blender/run.mjs` writes this file at the end of every
 * `pnpm gen:*` invocation. The runtime fetches it once at boot, the
 * editor reads it to populate "+ Bike" / "+ Prop" pickers, and the
 * garage menu merges its tracks list with the procedural built-ins.
 *
 * Procedural tracks (lagoon, cliffside) live entirely in code and do
 * NOT appear in the manifest. JSON-backed tracks (with optional .glb
 * environment geometry) are surfaced via the manifest's `tracks`
 * entries.
 */

export type AssetManifest = {
  schemaVersion: number
  generatedAt?: string
  bikes: BikeManifestEntry[]
  props: PropManifestEntry[]
  riders: RiderManifestEntry[]
  tracks: TrackManifestEntry[]
}

export type BikeManifestEntry = {
  id: string
  displayName: string
  url: string
  specPath: string
  physics?: { massKg: number; topSpeedMps: number; hoverHeight: number }
  appearance?: {
    liveryColor: string
    metalColor: string
    glowColor: string
    glowIntensity: number
  }
}

export type PropManifestEntry = {
  id: string
  displayName: string
  url: string
  specPath: string
  category?: string
  /** When set, the prop's GLB carries `wave_rider_archetype` extras and
   *  the runtime will spawn a wave-rider entity for each placement
   *  instead of a static collider. Mirror of the spec's
   *  `waveRider.archetype` field; surfaced here so the editor can hint
   *  "rides waves" in the palette without re-parsing every spec. */
  waveRider?: 'buoy' | 'log'
}

export type RiderManifestEntry = {
  id: string
  displayName: string
  url: string
  specPath: string
}

export type TrackManifestEntry = {
  id: string
  displayName: string
  url: string
  specPath: string
}

const EMPTY_MANIFEST: AssetManifest = {
  schemaVersion: 1,
  bikes: [],
  props: [],
  riders: [],
  tracks: [],
}

let cached: Promise<AssetManifest> | undefined

/**
 * Fetch and cache the manifest. Returns an empty manifest if the file
 * is missing — that's the legitimate "haven't run gen:all yet" state
 * and shouldn't crash the app.
 */
export async function loadManifest(url = '/assets/manifest.json'): Promise<AssetManifest> {
  if (cached) return cached
  cached = (async () => {
    try {
      const res = await fetch(url)
      if (!res.ok) return EMPTY_MANIFEST
      const data = (await res.json()) as Partial<AssetManifest>
      const out: AssetManifest = {
        schemaVersion: data.schemaVersion ?? 1,
        bikes: Array.isArray(data.bikes) ? data.bikes : [],
        props: Array.isArray(data.props) ? data.props : [],
        riders: Array.isArray(data.riders) ? data.riders : [],
        tracks: Array.isArray(data.tracks) ? data.tracks : [],
      }
      if (typeof data.generatedAt === 'string') out.generatedAt = data.generatedAt
      return out
    } catch {
      return EMPTY_MANIFEST
    }
  })()
  return cached
}

/** Reset the cache. Test-only. */
export function _resetManifestCache(): void {
  cached = undefined
}
