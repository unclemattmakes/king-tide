/**
 * Client-side fetch wrapper for the leaderboard Party. Two operations:
 *
 *  - `submitRemote()` — POSTs a signed submission to `/parties/leaderboard/global`.
 *    Returns the server-authoritative `SubmitResponse` so the caller
 *    can update its rank pill with the true rank (not the local cache's
 *    optimistic guess).
 *
 *  - `fetchBoard()` — GETs the top-N for a track. Returns a typed
 *    `BoardResponse` or an error code.
 *
 * Network failures are coarse Result types — callers should fall back
 * to the local cache and surface a "GLOBAL UNAVAILABLE" indicator
 * rather than throw. The fetch deadline is intentionally short
 * (~3.5 s) so a flaky network doesn't stall the finish overlay.
 */

import { newNonce, signPayload } from './hmac'
import {
  type BoardResponse,
  canonicalSubmitPayload,
  type SubmitBody,
  type SubmitResponse,
} from './protocol'

export type SubmitNetworkResult =
  | { ok: true; response: SubmitResponse }
  | { ok: false; error: 'network' | 'timeout' | 'malformed' }

export type FetchBoardResult =
  | { ok: true; board: BoardResponse }
  | { ok: false; error: 'network' | 'timeout' | 'malformed' | 'not-found' }

export type RemoteEndpoint = {
  /** Hostname e.g. `hoverbike.occ-matt.partykit.dev` or
   *  `localhost:1999`. No protocol prefix. */
  host: string
  /** Shared HMAC secret — bundled at build time via
   *  `VITE_LEADERBOARD_HMAC_SECRET`, falls back to `DEV_HMAC_SECRET`
   *  in dev. */
  secret: string
  /** Room id on the leaderboard Party. Single global room today; the
   *  hook is here in case we shard by region later. */
  room?: string
  /** ms before aborting a request. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 3500

function partyUrl(endpoint: RemoteEndpoint, suffix: string): string {
  const isLocal = endpoint.host.startsWith('localhost')
  const proto = isLocal ? 'http' : 'https'
  const room = endpoint.room ?? 'global'
  return `${proto}://${endpoint.host}/parties/leaderboard/${encodeURIComponent(room)}${suffix}`
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController()
  const id = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(id)
  }
}

export type SubmitInput = {
  trackId: string
  handle: string
  bikeId: string
  bestLap: number
}

export async function submitRemote(
  input: SubmitInput,
  endpoint: RemoteEndpoint,
): Promise<SubmitNetworkResult> {
  const body: Omit<SubmitBody, 'signature'> = {
    trackId: input.trackId,
    handle: input.handle,
    bikeId: input.bikeId,
    bestLap: input.bestLap,
    ts: Date.now(),
    nonce: newNonce(),
  }
  const signature = await signPayload(canonicalSubmitPayload(body), endpoint.secret)
  const wire: SubmitBody = { ...body, signature }
  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let res: Response
  try {
    res = await fetchWithTimeout(
      partyUrl(endpoint, '/submit'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(wire),
      },
      timeoutMs,
    )
  } catch (e) {
    const aborted =
      typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError'
    return { ok: false, error: aborted ? 'timeout' : 'network' }
  }
  try {
    const parsed = (await res.json()) as SubmitResponse
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.ok === 'boolean') {
      return { ok: true, response: parsed }
    }
    return { ok: false, error: 'malformed' }
  } catch {
    return { ok: false, error: 'malformed' }
  }
}

export async function fetchBoard(
  trackId: string,
  endpoint: RemoteEndpoint,
): Promise<FetchBoardResult> {
  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let res: Response
  try {
    res = await fetchWithTimeout(
      partyUrl(endpoint, `/board/${encodeURIComponent(trackId)}`),
      { method: 'GET' },
      timeoutMs,
    )
  } catch (e) {
    const aborted =
      typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError'
    return { ok: false, error: aborted ? 'timeout' : 'network' }
  }
  if (res.status === 404) return { ok: false, error: 'not-found' }
  if (!res.ok) return { ok: false, error: 'network' }
  try {
    const parsed = (await res.json()) as BoardResponse
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray(parsed.entries) &&
      typeof parsed.trackId === 'string'
    ) {
      return { ok: true, board: parsed }
    }
    return { ok: false, error: 'malformed' }
  } catch {
    return { ok: false, error: 'malformed' }
  }
}
