/**
 * Wire types + canonical signing payload shared between the client
 * (`./remote.ts`) and the server (`party/leaderboard.ts`). Touching
 * either side without the other means the HMAC signature won't verify
 * and submissions silently fail — so both ends import these types
 * directly to keep the contract honest.
 *
 * The HMAC covers a deterministically-serialized subset of the submit
 * body (see `canonicalSubmitPayload`) so reordering fields or stamping
 * the timestamp differently on the wire can't change the signature.
 */

import type { LeaderboardEntry } from './core'

export type SubmitBody = {
  trackId: string
  handle: string
  bikeId: string
  bestLap: number
  /** Wall-clock ms at the client when the submit was prepared. Server
   *  rejects bodies more than ±SUBMIT_TS_WINDOW_MS off its own clock
   *  to bound replay attacks. */
  ts: number
  /** Random 16-byte hex nonce. Server keeps a rolling set of recent
   *  nonces and rejects duplicates so a captured submission can't be
   *  replayed inside the window. */
  nonce: string
  /** `sha256:<hex>` HMAC over `canonicalSubmitPayload`. */
  signature: string
}

/** ±5 min around the server clock — wide enough to forgive laptop clock
 *  skew, tight enough that replay attacks have a small window. */
export const SUBMIT_TS_WINDOW_MS = 5 * 60 * 1000

/** Build the canonical bytes the signature commits to. Order MUST be
 *  fixed and identical on both ends; we sort keys alphabetically to
 *  avoid relying on insertion-order JSON. */
export function canonicalSubmitPayload(body: Omit<SubmitBody, 'signature'>): string {
  // Manual stringify with sorted keys — sidesteps JSON.stringify's
  // implementation-defined insertion-order behaviour. Numbers are
  // toString()'d so 60.0 and 60 don't disagree across runtimes.
  const parts: string[] = []
  parts.push(`bestLap:${body.bestLap.toString()}`)
  parts.push(`bikeId:${body.bikeId}`)
  parts.push(`handle:${body.handle}`)
  parts.push(`nonce:${body.nonce}`)
  parts.push(`trackId:${body.trackId}`)
  parts.push(`ts:${body.ts.toString()}`)
  return parts.join('|')
}

export type SubmitOkResponse = {
  ok: true
  rank: number | null
  improved: boolean
  total: number
}

export type SubmitErrResponse = {
  ok: false
  /** Coarse error code so the client can render a useful message
   *  without parsing free-form text. */
  error:
    | 'bad-request'
    | 'bad-signature'
    | 'stale-timestamp'
    | 'replay'
    | 'rate-limited'
    | 'profanity'
    | 'blocked-handle'
    | 'implausible-time'
    /** The server has no `LEADERBOARD_HMAC_SECRET`, so it cannot verify
     *  anything and refuses to accept writes. Distinct from
     *  `bad-signature`: the submission may be perfectly valid — the
     *  *server* is misconfigured. Clients treat it like an offline board
     *  and keep the local best. */
    | 'unconfigured'
    | 'internal'
  /** Optional context — e.g. "wait 3 s" for rate-limit. */
  detail?: string
}

export type SubmitResponse = SubmitOkResponse | SubmitErrResponse

export type BoardResponse = {
  trackId: string
  entries: LeaderboardEntry[]
  /** Server wall-clock when the snapshot was assembled. Clients can
   *  use it to decide whether to refresh. */
  servedAt: number
}

/** Per-track plausibility floor — used by both the local cache (advisory
 *  only) and the server (hard reject). Conservative: anything below
 *  this for the given track is rejected as implausible. Tracks not
 *  listed fall through to `DEFAULT_MIN_LAP_SECONDS`. The floor is
 *  intentionally tighter than the v1 lap-target so legit speedruns
 *  still land, but loose enough that obvious 1-second cheats bounce. */
export const MIN_LAP_SECONDS_BY_TRACK: Readonly<Record<string, number>> = Object.freeze({
  // Procedural dev tracks — players can legitimately set sub-30s laps
  // but anything in single-digit seconds is implausible.
  lagoon: 8,
  cliffside: 8,
  'big-bay': 8,
  // V1 ship tracks — derived from `V1_TRACKS.lapTarget × 0.4`. Numbers
  // here are static so the server doesn't need the menu catalogue.
  sandbar: 24,
  'mexico-city': 18,
  'hatteras-light': 20,
  'cape-town-drift': 19,
  'the-maw': 24,
  'shibuya-submerged': 20,
  'kilauea-crown': 22,
  'marina-bay-7': 20,
  'doges-drift': 18,
  'golden-gate-drowned': 23,
  aqualand: 14,
  'angkor-drowned': 22,
  'liberty-drowned': 24,
})

export const DEFAULT_MIN_LAP_SECONDS = 5
export const MAX_LAP_SECONDS = 60 * 30 // 30 min upper bound — past this, almost certainly broken instrumentation
