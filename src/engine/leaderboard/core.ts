/**
 * Pure leaderboard logic — dedupe by handle, sort by bestLap ascending,
 * truncate to top-N. No I/O, no Date.now() (the caller passes the
 * timestamp). Shared between:
 *
 *  - `local.ts`   — localStorage-backed cache that the player sees
 *    immediately while the remote round-trip is in flight
 *  - `party/leaderboard.ts` — PartyKit Party that owns the global board
 *
 * Both sides apply identical merge semantics so a local rank and the
 * server's authoritative rank agree on the same fixed input. The
 * server-side check is what enforces the constraints (the local cache
 * trusts the player); keep both in lockstep here.
 */

export type LeaderboardEntry = {
  handle: string
  bikeId: string
  bestLap: number
  recordedAt: number
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

export type MergeOpts = {
  handle: string
  bikeId: string
  bestLap: number
  /** Caller-supplied — `Date.now()` on the client; `Date.now()` on the
   *  server, which is the *authoritative* recordedAt. */
  recordedAt: number
}

/** Max entries kept per track on either side. The board view paginates
 *  at 10; keeping 25 gives some buffer for ties + rolling churn. */
export const MAX_ENTRIES_PER_TRACK = 25

/** Insert `opts` into `entries` (mutates a clone), returning the next
 *  board state + the rank achieved. Dedupe semantics: each handle
 *  occupies exactly one slot — a faster lap from the same handle
 *  replaces the slower one; a slower lap is dropped (improved=false).
 *  The output is sorted by bestLap ascending and truncated to
 *  MAX_ENTRIES_PER_TRACK.
 *
 *  Pure: passes `entries` by reference but treats it as input-only;
 *  the caller is responsible for persisting `next`. */
export function mergeEntry(
  entries: ReadonlyArray<LeaderboardEntry>,
  opts: MergeOpts,
): { next: LeaderboardEntry[]; result: SubmitResult } {
  if (!Number.isFinite(opts.bestLap) || opts.bestLap <= 0) {
    return {
      next: [...entries],
      result: { rank: null, improved: false, total: entries.length },
    }
  }
  const handle = opts.handle
  const existingIdx = entries.findIndex((e) => e.handle === handle)
  if (existingIdx >= 0) {
    const current = entries[existingIdx]
    if (current && current.bestLap <= opts.bestLap) {
      return {
        next: [...entries],
        result: { rank: existingIdx + 1, improved: false, total: entries.length },
      }
    }
  }
  const filtered = entries.filter((_, i) => i !== existingIdx)
  filtered.push({
    handle,
    bikeId: opts.bikeId,
    bestLap: opts.bestLap,
    recordedAt: opts.recordedAt,
  })
  filtered.sort((a, b) => a.bestLap - b.bestLap)
  const next = filtered.slice(0, MAX_ENTRIES_PER_TRACK)
  const rankIdx = next.findIndex((e) => e.handle === handle)
  return {
    next,
    result: {
      rank: rankIdx >= 0 ? rankIdx + 1 : null,
      improved: true,
      total: next.length,
    },
  }
}

/** Validate + uppercase a free-form handle. Strips characters outside
 *  [A-Z0-9_-], clamps to 12 chars, and returns null if nothing usable
 *  is left. Identical implementation client + server so the same
 *  string survives a round-trip without re-normalization mismatch. */
export function normalizeHandle(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 12)
  return cleaned.length > 0 ? cleaned : null
}
