/**
 * localStorage-backed persistence for best lap times. One number per
 * (track, bike) combination. Reads gracefully degrade to "no record" if
 * localStorage is unavailable (private browsing, sandboxed iframe, etc).
 */

const STORAGE_KEY = 'hoverbike.bestLaps.v1'

export type BestLapKey = { trackId: string; bikeId: string }
type Store = Record<string, number>

function keyFor(k: BestLapKey): string {
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

function saveStore(store: Store): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Quota / unavailable — just drop the write silently. Next session
    // will start fresh, which is acceptable for a leaderboard nicety.
  }
}

export function getBestLap(key: BestLapKey): number | null {
  const store = loadStore()
  const v = store[keyFor(key)]
  return typeof v === 'number' ? v : null
}

/**
 * Save `seconds` as the best lap for (track, bike) if it beats the
 * existing record (or there's none). Returns true if it was a new
 * record.
 */
export function recordLapTime(key: BestLapKey, seconds: number): boolean {
  if (!Number.isFinite(seconds) || seconds <= 0) return false
  const store = loadStore()
  const k = keyFor(key)
  const existing = store[k]
  if (existing !== undefined && existing <= seconds) return false
  store[k] = seconds
  saveStore(store)
  return true
}

export function getAllBestLaps(): Record<string, number> {
  return loadStore()
}

/** Clear all saved records. Used by the "reset records" button in the
 *  garage menu. */
export function clearBestLaps(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore — see saveStore's catch.
  }
}
