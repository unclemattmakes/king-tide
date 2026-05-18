/**
 * localStorage-backed persistence for Time Trial ghosts. One ReplayFile
 * per (track, bike) combination — the player's saved best-lap slice,
 * loaded on TT start and overwritten when a faster lap is set.
 *
 * Reads gracefully degrade to "no ghost" if localStorage is unavailable
 * or the stored payload is corrupt. Writes silently drop when the quota
 * is exceeded (a single ghost is small but several tracks × bikes can
 * push toward the 5 MB ceiling some browsers enforce).
 */

import { parseReplay, type ReplayFile, serializeReplay } from './format'

const STORAGE_KEY = 'hoverbike.ghosts.v1'

export type GhostKey = { trackId: string; bikeId: string }

type Store = Record<string, string>

function keyFor(k: GhostKey): string {
  return `${k.trackId}::${k.bikeId}`
}

function loadStore(): Store {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as Store
    return {}
  } catch {
    return {}
  }
}

function saveStore(store: Store): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
    return true
  } catch {
    return false
  }
}

/** Return the saved ghost for (track, bike), or null if none exists or
 *  the payload failed to parse. Corrupt entries are silently dropped
 *  from the store. */
export function getGhost(key: GhostKey): ReplayFile | null {
  const store = loadStore()
  const raw = store[keyFor(key)]
  if (!raw) return null
  try {
    return parseReplay(raw)
  } catch {
    delete store[keyFor(key)]
    saveStore(store)
    return null
  }
}

/** Persist `replay` as the ghost for (track, bike). Overwrites any
 *  existing ghost. Returns true on a successful write. */
export function setGhost(key: GhostKey, replay: ReplayFile): boolean {
  const store = loadStore()
  store[keyFor(key)] = serializeReplay(replay)
  return saveStore(store)
}

/** Returns the best-lap time recorded in the saved ghost, or null. Used
 *  by the recorder caller to decide "is this lap a new PB?" without
 *  fetching/parsing the full replay payload twice. */
export function getGhostBestLap(key: GhostKey): number | null {
  const ghost = getGhost(key)
  if (!ghost) return null
  const v = ghost.meta.bestLap
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

export function clearGhosts(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* unavailable — see saveStore */
  }
}
