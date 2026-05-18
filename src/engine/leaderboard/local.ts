/**
 * localStorage-backed Time Trial leaderboard cache. The player's
 * client-side mirror of the global board — written immediately on a TT
 * PB so the finish overlay can show a rank pill without waiting on the
 * network round-trip. The authoritative state lives in the leaderboard
 * Party (see `party/leaderboard.ts`); this cache is overwritten by the
 * remote board entries the menu view fetches when it loads.
 *
 * Pure merge semantics + handle normalization come from `./core.ts` so
 * the server applies the exact same rules. The `local.ts` wrapper is
 * just the storage shim.
 *
 * Storage is small (~80 bytes/entry × 25 entries × ~12 tracks → 24 KB
 * worst case), well under any quota. Reads gracefully degrade to an
 * empty board when localStorage is unavailable.
 */

import {
  type LeaderboardEntry,
  MAX_ENTRIES_PER_TRACK,
  mergeEntry,
  normalizeHandle,
  type SubmitResult,
} from './core'

const STORAGE_KEY = 'hoverbike.leaderboard.v1'

type Store = Record<string, LeaderboardEntry[]>

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

export { type LeaderboardEntry, normalizeHandle, type SubmitResult }

export type SubmitOpts = {
  trackId: string
  handle: string
  bikeId: string
  bestLap: number
}

/** Insert `opts` into the local cache. Falls back to 'YOU' when the
 *  handle is unusable so the player always sees themselves on the
 *  board even before they pick a name. */
export function submitEntry(opts: SubmitOpts): SubmitResult {
  const handle = normalizeHandle(opts.handle) ?? 'YOU'
  const store = loadStore()
  const { next, result } = mergeEntry(store[opts.trackId] ?? [], {
    handle,
    bikeId: opts.bikeId,
    bestLap: opts.bestLap,
    recordedAt: Date.now(),
  })
  if (result.improved) {
    store[opts.trackId] = next
    saveStore(store)
  }
  return result
}

/** Replace the cached entries for one track with the server's
 *  authoritative top-N. Called after a successful remote fetch so the
 *  next render shows the global board (with the player's row still
 *  highlighted by handle match). */
export function setCachedEntries(trackId: string, entries: LeaderboardEntry[]): void {
  const store = loadStore()
  store[trackId] = entries.slice(0, MAX_ENTRIES_PER_TRACK)
  saveStore(store)
}

/** Read-only snapshot of one track's top-N. Already sorted by bestLap
 *  asc; callers can slice for display without re-sorting. */
export function getEntries(trackId: string, limit = MAX_ENTRIES_PER_TRACK): LeaderboardEntry[] {
  const store = loadStore()
  const entries = store[trackId] ?? []
  return entries.slice(0, Math.max(0, Math.min(limit, entries.length)))
}

/** Map of trackId → entry count, for the leaderboard-screen track list. */
export function getEntryCounts(): Record<string, number> {
  const store = loadStore()
  const out: Record<string, number> = {}
  for (const k of Object.keys(store)) out[k] = store[k]?.length ?? 0
  return out
}

/** Wipe every track's board. Backs the "CLEAR LOCAL TIMES" button on
 *  the leaderboards screen — separate from `clearGhosts` so the player
 *  can reset times without also losing ghost playback. The global
 *  board is unaffected; the next remote fetch repopulates the cache. */
export function clearLeaderboards(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* unavailable — see saveStore */
  }
}

export const __test__ = { STORAGE_KEY, MAX_ENTRIES_PER_TRACK }
