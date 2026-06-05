/**
 * sessionStorage-backed state for an in-progress cup (championship).
 *
 * One cup runs at a time. Each race in the cup writes the whole field's
 * finish here (every rival, not just the player); the post-race "NEXT"
 * button reads the state to figure out which track loads next, and the
 * final-race podium reads the accumulated standings to award the trophy.
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
 *
 * **Full-field model (v2).** A cup seeds a *stable rival roster* at start
 * (`buildCupRoster`) so the same opponents — same names, bikes, liveries —
 * race the whole championship, MK8-style. Each race records every racer's
 * finishing slot, and `cupStandings()` sums points across the lineup so
 * the trophy goes to the actual top-of-table rider. The player-centric
 * `position` / `raceTime` fields on each result are kept as a convenience
 * for the in-line finish recap.
 */

import { aiCallSign } from '@/game/bikes/callsigns'
import { resolveBikeVariant, variantForAiSlot } from '@/game/bikes/variants'

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

/** Default AI grid size for a championship. The live race grid is 2×4 —
 *  the player takes the pole, leaving seven rivals. Mirrors
 *  `spawn-bikes.NUM_AI` without importing the boot layer. */
export const CUP_AI_COUNT = 7

/** Points awarded for `position` (1-based). Returns 0 for positions
 *  beyond the table or invalid inputs (DNF / null). */
export function pointsForPosition(position: number | null): number {
  if (position === null || !Number.isFinite(position) || position < 1) return 0
  const idx = Math.floor(position)
  return idx < CUP_POINTS.length ? (CUP_POINTS[idx] ?? 0) : 0
}

/** A single rider's stable identity for the duration of a cup. Seeded at
 *  cup start so the broadcast intro, the per-race results board, and the
 *  championship standings all agree on who's who. */
export type CupRacerIdentity = {
  /** Grid slot — 0 is the player, 1.. are the AI rivals. */
  slot: number
  isPlayer: boolean
  /** Display name: 'YOU' for the player, an AI call-sign otherwise. */
  name: string
  /** Bike variant id (drives the livery shown on the podium). */
  variantId: string
  /** Body colour (hex int) used for the standings swatch + podium tint. */
  bodyColor: number
}

/** One racer's result in a single race of the cup. */
export type CupFinisher = {
  slot: number
  /** Finish position (1-based) at the moment the player crossed the line.
   *  Null = DNF. */
  position: number | null
  /** Race time in seconds when recorded — null if not yet finished / DNF. */
  raceTime: number | null
}

export type CupRaceResult = {
  trackId: string
  /** Player's finish position (1-based). Null = DNF / unrecorded. Kept as
   *  a convenience mirror of the player's entry in `finishers`. */
  position: number | null
  /** Total racers in this race — used to display "1st of 8". */
  totalRacers: number
  /** Player's race time in seconds — null if DNF. */
  raceTime: number | null
  /** Every racer's finish for this race, keyed implicitly by `slot`. Empty
   *  when a result was recorded via the legacy player-only path. */
  finishers: CupFinisher[]
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
  /** Stable rider roster for the whole cup (slot → identity). May be
   *  empty for cups seeded before the full-field model existed. */
  roster: CupRacerIdentity[]
  /** Results so far, keyed by trackId — populated as the cup advances. */
  results: Record<string, CupRaceResult>
  /** Wall-clock timestamp the cup started — surfaced in the results
   *  overlay so the player can see how long the run took. */
  startedAt: number
}

/** Build a stable rival roster for a cup. Player is slot 0; rivals 1.. use
 *  the same per-slot variant rotation the live grid spawns, with names
 *  seeded off the *cup id* so they don't change track to track. */
export function buildCupRoster(args: {
  cupId: string
  bikeId: string
  aiCount?: number
}): CupRacerIdentity[] {
  const aiCount = Math.max(0, args.aiCount ?? CUP_AI_COUNT)
  const player = resolveBikeVariant(args.bikeId)
  const roster: CupRacerIdentity[] = [
    { slot: 0, isPlayer: true, name: 'YOU', variantId: player.id, bodyColor: player.bodyColor },
  ]
  for (let slot = 1; slot <= aiCount; slot++) {
    const v = variantForAiSlot(slot)
    roster.push({
      slot,
      isPlayer: false,
      name: aiCallSign(args.cupId, slot),
      variantId: v.id,
      bodyColor: v.bodyColor,
    })
  }
  return roster
}

function normalizeResult(raw: unknown, trackId: string): CupRaceResult | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<CupRaceResult>
  return {
    trackId: typeof r.trackId === 'string' ? r.trackId : trackId,
    position: typeof r.position === 'number' ? r.position : null,
    totalRacers: typeof r.totalRacers === 'number' ? r.totalRacers : 0,
    raceTime: typeof r.raceTime === 'number' ? r.raceTime : null,
    finishers: Array.isArray(r.finishers) ? (r.finishers as CupFinisher[]) : [],
  }
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
      // Normalize fields added after a cup may have been seeded so an
      // in-flight cup from an older build can't crash the new readers.
      const results: Record<string, CupRaceResult> = {}
      for (const [trackId, value] of Object.entries(parsed.results as Record<string, unknown>)) {
        const r = normalizeResult(value, trackId)
        if (r) results[trackId] = r
      }
      const progress: CupProgress = {
        cupId: parsed.cupId,
        bikeId: parsed.bikeId,
        races: parsed.races,
        currentRaceIndex: parsed.currentRaceIndex,
        roster: Array.isArray(parsed.roster) ? (parsed.roster as CupRacerIdentity[]) : [],
        results,
        startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : Date.now(),
      }
      return progress
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
export function startCup(args: {
  cupId: string
  bikeId: string
  races: string[]
  /** Stable rival roster for the cup. Optional so legacy callers (and
   *  tests) can omit it; the standings fall back to a slot-derived
   *  roster when it's empty. */
  roster?: CupRacerIdentity[]
}): CupProgress {
  const p: CupProgress = {
    cupId: args.cupId,
    bikeId: args.bikeId,
    races: [...args.races],
    currentRaceIndex: 0,
    roster: args.roster ? [...args.roster] : [],
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
  /** Every racer's finish for this race. Optional for back-compat with
   *  the player-only path; when supplied it powers the full-field
   *  championship standings + podium. */
  finishers?: CupFinisher[]
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
    finishers: args.finishers ? [...args.finishers] : [],
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

/** Sum of the *player's* points across every recorded race. */
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

// ───────────────────────────── standings ──────────────────────────────

export type TrophyTier = 'gold' | 'silver' | 'bronze' | null

/** Trophy awarded for a final championship rank. Top three take a medal;
 *  everyone else finishes the cup without one (MK8 convention). */
export function trophyForRank(rank: number): TrophyTier {
  if (rank === 1) return 'gold'
  if (rank === 2) return 'silver'
  if (rank === 3) return 'bronze'
  return null
}

/** One rider's accumulated line in the championship table. */
export type CupStandingRow = {
  identity: CupRacerIdentity
  /** Total points across every recorded race. */
  totalPoints: number
  /** Race wins (1st-place finishes). */
  wins: number
  /** Per-race finish position keyed by trackId (1-based; null = DNF / not
   *  recorded). Ordered alongside `progress.races`. */
  positionsByTrack: Record<string, number | null>
  /** Sum of recorded race times — deep tiebreak only. */
  totalTime: number
  /** 1-based overall rank after the standings sort. */
  rank: number
}

/** Reconstruct a roster from recorded finishers when a cup was seeded
 *  before the roster field existed (or by the legacy player-only path). */
function fallbackRoster(p: CupProgress): CupRacerIdentity[] {
  const slots = new Set<number>()
  for (const r of Object.values(p.results)) {
    for (const f of r.finishers) slots.add(f.slot)
  }
  if (slots.size === 0) {
    return [{ slot: 0, isPlayer: true, name: 'YOU', variantId: p.bikeId, bodyColor: 0x5cf2ff }]
  }
  return Array.from(slots)
    .sort((a, b) => a - b)
    .map((slot) => ({
      slot,
      isPlayer: slot === 0,
      name: slot === 0 ? 'YOU' : `RIVAL ${slot}`,
      variantId: slot === 0 ? p.bikeId : 'racer',
      bodyColor: 0x88aabb,
    }))
}

/** Compute the full championship table, sorted best-first. Points are the
 *  primary key; ties break on wins, then aggregate time, then slot. */
export function cupStandings(p: CupProgress): CupStandingRow[] {
  const roster = p.roster.length > 0 ? p.roster : fallbackRoster(p)
  const rows: CupStandingRow[] = roster.map((identity) => {
    let totalPoints = 0
    let wins = 0
    let totalTime = 0
    const positionsByTrack: Record<string, number | null> = {}
    for (const trackId of p.races) {
      const result = p.results[trackId]
      const fin = result?.finishers.find((f) => f.slot === identity.slot)
      // Prefer the full-field finisher; fall back to the player mirror for
      // legacy results that only recorded the player.
      const pos = fin ? fin.position : identity.isPlayer ? (result?.position ?? null) : null
      positionsByTrack[trackId] = pos
      totalPoints += pointsForPosition(pos)
      if (pos === 1) wins += 1
      const t = fin?.raceTime ?? (identity.isPlayer ? (result?.raceTime ?? null) : null)
      if (typeof t === 'number' && t > 0) totalTime += t
    }
    return { identity, totalPoints, wins, totalTime, positionsByTrack, rank: 0 }
  })
  rows.sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints
    if (b.wins !== a.wins) return b.wins - a.wins
    // Lower aggregate time wins; racers with no recorded time rank last.
    const at = a.totalTime || Number.POSITIVE_INFINITY
    const bt = b.totalTime || Number.POSITIVE_INFINITY
    if (at !== bt) return at - bt
    return a.identity.slot - b.identity.slot
  })
  rows.forEach((r, i) => {
    r.rank = i + 1
  })
  return rows
}

/** The player's row in the championship table, or null if absent. */
export function playerCupStanding(p: CupProgress): CupStandingRow | null {
  return cupStandings(p).find((r) => r.identity.isPlayer) ?? null
}
