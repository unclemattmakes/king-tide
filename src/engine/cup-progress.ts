/**
 * sessionStorage-backed state for an in-progress cup (championship).
 *
 * One cup runs at a time. Each race in the cup writes its finish position
 * here; the post-race "NEXT" button reads the state to figure out which
 * track loads next, and the final-race finish screen reads the full
 * standings to render the cup-results overlay.
 *
 * sessionStorage (not localStorage) is deliberate: a cup is a single
 * sitting. Closing the tab or exiting to the menu starts a fresh cup
 * next time. The persistent ledger (best laps per track) lives in
 * localStorage via `save-state.ts`; that's separate.
 *
 * Points use the Mario Kart 8 / F1 lineage — first place takes 15, with
 * a long tail down to 1 for 12th. That's enough headroom for the v1
 * 8-bike grid and matches what players already intuit from racing-game
 * conventions.
 */

const STORAGE_KEY = 'hoverbike.cupProgress.v1'

/** Points awarded for finishing in 1st, 2nd, … 12th place. MK8 / F1
 *  classic curve. Index 0 is unused (positions are 1-based). */
export const CUP_POINTS: ReadonlyArray<number> = [
  0, // unused — positions are 1-based
  15,
  12,
  10,
  9,
  8,
  7,
  6,
  5,
  4,
  3,
  2,
  1,
]

/** Points awarded for `position` (1-based). Returns 0 for positions
 *  beyond the table or invalid inputs (DNF / null). */
export function pointsForPosition(position: number | null): number {
  if (position === null || !Number.isFinite(position) || position < 1) return 0
  const idx = Math.floor(position)
  return idx < CUP_POINTS.length ? (CUP_POINTS[idx] ?? 0) : 0
}

export type CupRaceResult = {
  trackId: string
  /** Player's finish position (1-based). Null = DNF / unrecorded. */
  position: number | null
  /** Total racers in this race — used to display "1st of 5" in the
   *  results overlay. */
  totalRacers: number
  /** Player's race time in seconds — null if DNF. */
  raceTime: number | null
}

export type CupProgress = {
  /** Cup id (`'dev-placeholder'`, `'reef'`, …). */
  cupId: string
  /** Bike variant the cup is running with — fixed at cup-start so the
   *  championship is a single-loadout commitment. */
  bikeId: string
  /** Ordered list of track ids this cup races through. Snapshot at
   *  start time so a future cup-roster change can't desync mid-cup. */
  races: string[]
  /** Index into `races` for the race currently being raced (or about
   *  to be raced). Advances on each finish; equals `races.length` once
   *  the cup is over. */
  currentRaceIndex: number
  /** Results so far, keyed by trackId — populated as the cup advances. */
  results: Record<string, CupRaceResult>
  /** Wall-clock timestamp the cup started — surfaced in the results
   *  overlay so the player can see how long the run took. */
  startedAt: number
}

function readStore(): CupProgress | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.cupId === 'string' &&
      typeof parsed.bikeId === 'string' &&
      Array.isArray(parsed.races) &&
      typeof parsed.currentRaceIndex === 'number' &&
      parsed.results &&
      typeof parsed.results === 'object'
    ) {
      return parsed as CupProgress
    }
  } catch {
    /* corrupt blob — fall through */
  }
  return null
}

function writeStore(p: CupProgress | null): void {
  try {
    if (p === null) {
      window.sessionStorage.removeItem(STORAGE_KEY)
    } else {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(p))
    }
  } catch {
    /* private mode / quota — silently drop. Cup will play through but
     *  the post-race NEXT button can't find state and will fall back
     *  to single-race semantics. Acceptable degradation. */
  }
}

/** Seed a fresh cup. Overwrites any prior in-progress cup — exit/menu
 *  is the only "preserve" path, and that explicitly clears via
 *  `clearCupProgress`. */
export function startCup(args: { cupId: string; bikeId: string; races: string[] }): CupProgress {
  const p: CupProgress = {
    cupId: args.cupId,
    bikeId: args.bikeId,
    races: [...args.races],
    currentRaceIndex: 0,
    results: {},
    startedAt: Date.now(),
  }
  writeStore(p)
  return p
}

export function getCupProgress(): CupProgress | null {
  return readStore()
}

/** Returns the currently-active cup ONLY if the on-disk cupId matches
 *  the caller-supplied id. Guards against the race URL carrying a
 *  `?cup=` that doesn't match what we last seeded — a stale tab
 *  pointing at a fresh cup. */
export function getCupProgressFor(cupId: string): CupProgress | null {
  const p = readStore()
  if (!p || p.cupId !== cupId) return null
  return p
}

/** Record this race's finish for the active cup and advance the
 *  pointer. Returns the updated progress (or null if no cup is active). */
export function recordCupRaceFinish(args: {
  cupId: string
  trackId: string
  position: number | null
  totalRacers: number
  raceTime: number | null
}): CupProgress | null {
  const p = getCupProgressFor(args.cupId)
  if (!p) return null
  // Match by trackId rather than currentRaceIndex so a finish from a
  // race the player retried still lands in the right slot.
  const idx = p.races.indexOf(args.trackId)
  if (idx < 0) return p
  p.results[args.trackId] = {
    trackId: args.trackId,
    position: args.position,
    totalRacers: args.totalRacers,
    raceTime: args.raceTime,
  }
  // Advance the pointer past this race ONLY if it's the current one —
  // a player retrying a finished race shouldn't un-skip forward.
  if (idx === p.currentRaceIndex) {
    p.currentRaceIndex = idx + 1
  }
  writeStore(p)
  return p
}

/** The trackId of the next race the cup expects, or null if the cup
 *  is finished. */
export function nextCupTrackId(p: CupProgress): string | null {
  if (p.currentRaceIndex >= p.races.length) return null
  return p.races[p.currentRaceIndex] ?? null
}

/** True once every race in the cup has a recorded result. */
export function isCupComplete(p: CupProgress): boolean {
  return p.currentRaceIndex >= p.races.length && p.races.every((t) => t in p.results)
}

/** Sum of points across every recorded race. */
export function totalCupPoints(p: CupProgress): number {
  let sum = 0
  for (const r of Object.values(p.results)) {
    sum += pointsForPosition(r.position)
  }
  return sum
}

export function clearCupProgress(): void {
  writeStore(null)
}
