/**
 * localStorage-backed Time Trial leaderboard. One per-track top-N list
 * of (handle, bike, bestLap, recordedAt) — sorted by bestLap ascending
 * and deduped so each handle only occupies one slot per track (its own
 * fastest lap). Writes when the player sets a TT PB and the
 * "Submit times" toggle is on; the menu's Leaderboards screen reads
 * the same store.
 *
 * v1 scope is local-only — the M16 leaderboard backend will replace
 * `loadStore`/`saveStore` with a fetch round-trip while keeping the
 * `LeaderboardEntry` shape stable. The "(local)" badge in the UI is
 * the player-facing signal that times are not yet syndicated.
 *
 * Storage is small (~80 bytes/entry × 25 entries × ~12 tracks → 24 KB
 * worst case), well under any quota. Reads gracefully degrade to an
 * empty board when localStorage is unavailable.
 */

const STORAGE_KEY = 'hoverbike.leaderboard.v1'
const MAX_ENTRIES_PER_TRACK = 25

/** Single entry on the local board. `handle` is uppercased + clamped
 *  to 1..12 chars by `submitEntry`; the menu renders it as-is. */
export type LeaderboardEntry = {
  handle: string
  bikeId: string
  bestLap: number
  recordedAt: number
}

/** Per-track top-N list. Keyed by trackId in the underlying store —
 *  all bikes share the same leaderboard so the fastest lap wins
 *  regardless of variant (per `docs/v1-work-breakdown.md`'s domain
 *  inventory). */
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

/** Validate + uppercase a free-form handle. Strips characters outside
 *  [A-Z0-9_-], clamps to 12 chars, and returns null if nothing usable
 *  is left. Shared between the settings input + the leaderboard writer
 *  so both apply identical normalization. */
export function normalizeHandle(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 12)
  return cleaned.length > 0 ? cleaned : null
}

export type SubmitResult = {
  /** 1-indexed rank in the post-submit top-N, or null if the entry was
   *  truncated off the end of the board. */
  rank: number | null
  /** True if this submission improved the entry for this handle (or
   *  was the handle's first entry). False if the existing entry was
   *  already faster — in which case nothing changed. */
  improved: boolean
  /** Total entries on the board after this submission (≤ MAX). */
  total: number
}

export type SubmitOpts = {
  trackId: string
  handle: string
  bikeId: string
  bestLap: number
}

/** Insert `opts` into the per-track board. Dedupe semantics: each
 *  handle occupies exactly one slot — a faster lap from the same handle
 *  replaces the slower one; a slower lap is dropped (improved=false).
 *  The board is re-sorted by bestLap asc and truncated to
 *  MAX_ENTRIES_PER_TRACK. */
export function submitEntry(opts: SubmitOpts): SubmitResult {
  if (!Number.isFinite(opts.bestLap) || opts.bestLap <= 0) {
    return { rank: null, improved: false, total: 0 }
  }
  const handle = normalizeHandle(opts.handle) ?? 'YOU'
  const store = loadStore()
  const entries = store[opts.trackId] ?? []
  const existing = entries.findIndex((e) => e.handle === handle)
  if (existing >= 0) {
    const current = entries[existing]
    if (current && current.bestLap <= opts.bestLap) {
      return { rank: existing + 1, improved: false, total: entries.length }
    }
    entries.splice(existing, 1)
  }
  const entry: LeaderboardEntry = {
    handle,
    bikeId: opts.bikeId,
    bestLap: opts.bestLap,
    recordedAt: Date.now(),
  }
  entries.push(entry)
  entries.sort((a, b) => a.bestLap - b.bestLap)
  const truncated = entries.slice(0, MAX_ENTRIES_PER_TRACK)
  store[opts.trackId] = truncated
  saveStore(store)
  const rankIdx = truncated.findIndex((e) => e.handle === handle)
  return {
    rank: rankIdx >= 0 ? rankIdx + 1 : null,
    improved: true,
    total: truncated.length,
  }
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
 *  can reset times without also losing ghost playback. */
export function clearLeaderboards(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* unavailable — see saveStore */
  }
}

export const __test__ = { STORAGE_KEY, MAX_ENTRIES_PER_TRACK }
