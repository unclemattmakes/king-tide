/**
 * PartyKit Party for the global Time Trial leaderboard.
 *
 * One global room (`room.id === 'global'`); per-track top-N entries
 * live in `room.storage` keyed by `track:<id>`. Submits run through
 * the same `mergeEntry` core the client cache uses so the local
 * optimistic rank and the server's authoritative rank agree on
 * identical input.
 *
 * Threat model:
 *   1. HMAC + nonce + timestamp window  — bouncer for scripted curl
 *      abuse. A determined cheater can extract the secret from the
 *      shipped JS bundle; the signature is not real auth.
 *   2. Plausibility floor              — rejects laps below the
 *      per-track minimum.
 *   3. Per-IP rate limit               — 1 submit per 5 s.
 *   4. Profanity filter + blocklist    — front line for offensive
 *      handles.
 *   5. Admin endpoints                 — reactive removal (handle
 *      wipe, entry wipe, block, audit). The actual line of defence.
 *
 * Routes (all relative to `/parties/leaderboard/global`):
 *
 *   POST   /submit              — signed submit
 *   GET    /board/:trackId      — top-N read
 *   GET    /health              — uptime ping (public)
 *   DELETE /admin/handle/:h     — wipe handle everywhere + block
 *   DELETE /admin/entry/:t/:r   — wipe one row by rank (1-indexed)
 *   POST   /admin/block         — add handle to blocklist
 *   GET    /admin/audit         — recent submissions
 *
 * Admin endpoints require `Authorization: Bearer <LEADERBOARD_ADMIN_TOKEN>`.
 *
 * @see src/engine/leaderboard/core.ts      — shared merge logic
 * @see src/engine/leaderboard/protocol.ts  — wire types + canonical signing payload
 * @see src/engine/leaderboard/hmac.ts      — sign/verify helpers (browser + worker compat)
 * @see src/engine/leaderboard/profanity.ts — banned-stem list
 * @see docs/leaderboard-backend.md         — ops doc
 */

import type * as Party from 'partykit/server'

import {
  type LeaderboardEntry,
  MAX_ENTRIES_PER_TRACK,
  mergeEntry,
  normalizeHandle,
} from '../src/engine/leaderboard/core'
import { DEV_HMAC_SECRET, verifySignature } from '../src/engine/leaderboard/hmac'
import { containsProfanity } from '../src/engine/leaderboard/profanity'
import {
  type BoardResponse,
  canonicalSubmitPayload,
  DEFAULT_MIN_LAP_SECONDS,
  MAX_LAP_SECONDS,
  MIN_LAP_SECONDS_BY_TRACK,
  SUBMIT_TS_WINDOW_MS,
  type SubmitBody,
  type SubmitErrResponse,
  type SubmitOkResponse,
} from '../src/engine/leaderboard/protocol'

const TRACK_PREFIX = 'track:'
const BLOCKLIST_KEY = 'blocklist'
const AUDIT_KEY = 'audit'
const RATE_LIMIT_WINDOW_MS = 5_000
const AUDIT_LOG_LIMIT = 1000
const NONCE_TTL_MS = SUBMIT_TS_WINDOW_MS

type AuditEntry = {
  ts: number
  ip: string
  trackId: string
  handle: string
  bestLap: number
  /** Coarse outcome for grep-ability when reviewing the log. */
  outcome:
    | 'accepted'
    | 'duplicate'
    | 'profanity'
    | 'blocked'
    | 'implausible'
    | 'rate-limited'
    | 'bad-signature'
    | 'replay'
    | 'stale'
    | 'malformed'
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    },
  })
}

function errResponse(status: number, err: SubmitErrResponse['error'], detail?: string): Response {
  const body: SubmitErrResponse = { ok: false, error: err, ...(detail ? { detail } : {}) }
  return jsonResponse(status, body)
}

function clientIp(req: Party.Request): string {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

function adminToken(env: Record<string, unknown>): string | null {
  const tok = env.LEADERBOARD_ADMIN_TOKEN
  return typeof tok === 'string' && tok.length > 0 ? tok : null
}

function isAdmin(req: Party.Request, env: Record<string, unknown>): boolean {
  const expected = adminToken(env)
  if (!expected) return false
  const got = req.headers.get('authorization')
  if (!got?.startsWith('Bearer ')) return false
  const provided = got.slice('Bearer '.length).trim()
  return constantTimeEquals(provided, expected)
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function hmacSecret(env: Record<string, unknown>): string {
  const v = env.LEADERBOARD_HMAC_SECRET
  return typeof v === 'string' && v.length > 0 ? v : DEV_HMAC_SECRET
}

function plausibilityFloor(trackId: string): number {
  return MIN_LAP_SECONDS_BY_TRACK[trackId] ?? DEFAULT_MIN_LAP_SECONDS
}

export default class LeaderboardServer implements Party.Server {
  /** Per-IP last-submit timestamps. In-memory only — survives only as
   *  long as the Durable Object instance is hot. That's fine for a
   *  5-second window. */
  private lastSubmitByIp = new Map<string, number>()
  /** Recently-seen nonces — protects against a captured-and-replayed
   *  submission inside the signature window. Map value is the ts the
   *  nonce was accepted; old entries are GC'd lazily. */
  private recentNonces = new Map<string, number>()

  constructor(readonly room: Party.Room) {}

  async onRequest(req: Party.Request): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return jsonResponse(200, { ok: true })
    }
    const url = new URL(req.url)
    const path = url.pathname

    // PartyKit routes everything under `/parties/leaderboard/global/*`;
    // strip that prefix so the handlers can switch on the suffix.
    const suffixMatch = path.match(/\/parties\/[^/]+\/[^/]+(\/.*)?$/)
    const suffix = suffixMatch?.[1] ?? '/'

    if (req.method === 'GET' && suffix === '/health') {
      return jsonResponse(200, { ok: true, servedAt: Date.now() })
    }
    if (req.method === 'POST' && suffix === '/submit') {
      return this.handleSubmit(req)
    }
    const boardMatch = suffix.match(/^\/board\/([^/]+)$/)
    if (req.method === 'GET' && boardMatch) {
      return this.handleBoard(decodeURIComponent(boardMatch[1] ?? ''))
    }
    const handleMatch = suffix.match(/^\/admin\/handle\/([^/]+)$/)
    if (req.method === 'DELETE' && handleMatch) {
      if (!isAdmin(req, this.room.env))
        return jsonResponse(401, { ok: false, error: 'unauthorized' })
      return this.handleAdminWipeHandle(decodeURIComponent(handleMatch[1] ?? ''))
    }
    const entryMatch = suffix.match(/^\/admin\/entry\/([^/]+)\/(\d+)$/)
    if (req.method === 'DELETE' && entryMatch) {
      if (!isAdmin(req, this.room.env))
        return jsonResponse(401, { ok: false, error: 'unauthorized' })
      const rank = parseInt(entryMatch[2] ?? '0', 10)
      return this.handleAdminWipeEntry(decodeURIComponent(entryMatch[1] ?? ''), rank)
    }
    if (req.method === 'POST' && suffix === '/admin/block') {
      if (!isAdmin(req, this.room.env))
        return jsonResponse(401, { ok: false, error: 'unauthorized' })
      return this.handleAdminBlock(req)
    }
    if (req.method === 'GET' && suffix === '/admin/audit') {
      if (!isAdmin(req, this.room.env))
        return jsonResponse(401, { ok: false, error: 'unauthorized' })
      return this.handleAdminAudit(url)
    }
    return jsonResponse(404, { ok: false, error: 'not-found' })
  }

  private async handleSubmit(req: Party.Request): Promise<Response> {
    const ip = clientIp(req)
    const now = Date.now()
    let body: SubmitBody
    try {
      body = (await req.json()) as SubmitBody
    } catch {
      await this.audit({ ts: now, ip, trackId: '?', handle: '?', bestLap: 0, outcome: 'malformed' })
      return errResponse(400, 'bad-request', 'JSON parse failed')
    }
    const valid = validateSubmitShape(body)
    if (!valid.ok) {
      await this.audit({ ts: now, ip, trackId: '?', handle: '?', bestLap: 0, outcome: 'malformed' })
      return errResponse(400, 'bad-request', valid.detail)
    }
    if (Math.abs(now - body.ts) > SUBMIT_TS_WINDOW_MS) {
      await this.audit({
        ts: now,
        ip,
        trackId: body.trackId,
        handle: body.handle,
        bestLap: body.bestLap,
        outcome: 'stale',
      })
      return errResponse(400, 'stale-timestamp')
    }
    this.evictExpiredNonces(now)
    if (this.recentNonces.has(body.nonce)) {
      await this.audit({
        ts: now,
        ip,
        trackId: body.trackId,
        handle: body.handle,
        bestLap: body.bestLap,
        outcome: 'replay',
      })
      return errResponse(400, 'replay')
    }
    const sigOk = await verifySignature(
      canonicalSubmitPayload({
        trackId: body.trackId,
        handle: body.handle,
        bikeId: body.bikeId,
        bestLap: body.bestLap,
        ts: body.ts,
        nonce: body.nonce,
      }),
      body.signature,
      hmacSecret(this.room.env),
    )
    if (!sigOk) {
      await this.audit({
        ts: now,
        ip,
        trackId: body.trackId,
        handle: body.handle,
        bestLap: body.bestLap,
        outcome: 'bad-signature',
      })
      return errResponse(401, 'bad-signature')
    }

    const last = this.lastSubmitByIp.get(ip) ?? 0
    if (now - last < RATE_LIMIT_WINDOW_MS) {
      const wait = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - last)) / 1000)
      await this.audit({
        ts: now,
        ip,
        trackId: body.trackId,
        handle: body.handle,
        bestLap: body.bestLap,
        outcome: 'rate-limited',
      })
      return errResponse(429, 'rate-limited', `wait ${wait}s`)
    }
    this.lastSubmitByIp.set(ip, now)

    const normalized = normalizeHandle(body.handle) ?? 'YOU'
    if (containsProfanity(normalized)) {
      await this.audit({
        ts: now,
        ip,
        trackId: body.trackId,
        handle: normalized,
        bestLap: body.bestLap,
        outcome: 'profanity',
      })
      return errResponse(400, 'profanity')
    }
    const blocklist = await this.loadBlocklist()
    if (blocklist.has(normalized)) {
      await this.audit({
        ts: now,
        ip,
        trackId: body.trackId,
        handle: normalized,
        bestLap: body.bestLap,
        outcome: 'blocked',
      })
      return errResponse(400, 'blocked-handle')
    }

    const floor = plausibilityFloor(body.trackId)
    if (body.bestLap < floor || body.bestLap > MAX_LAP_SECONDS) {
      await this.audit({
        ts: now,
        ip,
        trackId: body.trackId,
        handle: normalized,
        bestLap: body.bestLap,
        outcome: 'implausible',
      })
      return errResponse(400, 'implausible-time', `min ${floor}s`)
    }

    const key = TRACK_PREFIX + body.trackId
    const entries = await this.loadEntries(key)
    const { next, result } = mergeEntry(entries, {
      handle: normalized,
      bikeId: body.bikeId,
      bestLap: body.bestLap,
      recordedAt: now,
    })
    if (result.improved) {
      await this.room.storage.put(key, next)
    }
    this.recentNonces.set(body.nonce, now)
    await this.audit({
      ts: now,
      ip,
      trackId: body.trackId,
      handle: normalized,
      bestLap: body.bestLap,
      outcome: result.improved ? 'accepted' : 'duplicate',
    })

    const ok: SubmitOkResponse = {
      ok: true,
      rank: result.rank,
      improved: result.improved,
      total: result.total,
    }
    return jsonResponse(200, ok)
  }

  private async handleBoard(trackId: string): Promise<Response> {
    if (!trackId) return jsonResponse(400, { ok: false, error: 'bad-request' })
    const entries = await this.loadEntries(TRACK_PREFIX + trackId)
    const body: BoardResponse = { trackId, entries, servedAt: Date.now() }
    return jsonResponse(200, body)
  }

  private async handleAdminWipeHandle(rawHandle: string): Promise<Response> {
    const handle = normalizeHandle(rawHandle)
    if (!handle) return jsonResponse(400, { ok: false, error: 'bad-request' })
    // List + rewrite — Durable Object storage doesn't support pattern-
    // delete inline. Track count is small (≤12 today), keeps this O(n).
    const all = await this.room.storage.list<LeaderboardEntry[]>({ prefix: TRACK_PREFIX })
    let touched = 0
    for (const [key, entries] of all) {
      const filtered = entries.filter((e) => e.handle !== handle)
      if (filtered.length !== entries.length) {
        await this.room.storage.put(key, filtered)
        touched++
      }
    }
    // Block future submissions from this handle too.
    const blocklist = await this.loadBlocklist()
    blocklist.add(handle)
    await this.room.storage.put(BLOCKLIST_KEY, Array.from(blocklist))
    return jsonResponse(200, { ok: true, handle, tracksTouched: touched })
  }

  private async handleAdminWipeEntry(trackId: string, rank: number): Promise<Response> {
    if (!trackId || !Number.isFinite(rank) || rank < 1) {
      return jsonResponse(400, { ok: false, error: 'bad-request' })
    }
    const key = TRACK_PREFIX + trackId
    const entries = await this.loadEntries(key)
    if (rank > entries.length) {
      return jsonResponse(404, { ok: false, error: 'not-found' })
    }
    const removed = entries[rank - 1]
    const next = entries.filter((_, i) => i !== rank - 1)
    await this.room.storage.put(key, next)
    return jsonResponse(200, { ok: true, removed })
  }

  private async handleAdminBlock(req: Party.Request): Promise<Response> {
    let body: { handle?: string }
    try {
      body = (await req.json()) as { handle?: string }
    } catch {
      return jsonResponse(400, { ok: false, error: 'bad-request' })
    }
    const handle = normalizeHandle(body.handle ?? '')
    if (!handle) return jsonResponse(400, { ok: false, error: 'bad-request' })
    const blocklist = await this.loadBlocklist()
    blocklist.add(handle)
    await this.room.storage.put(BLOCKLIST_KEY, Array.from(blocklist))
    return jsonResponse(200, { ok: true, handle, blocklistSize: blocklist.size })
  }

  private async handleAdminAudit(url: URL): Promise<Response> {
    const limit = Math.max(
      1,
      Math.min(AUDIT_LOG_LIMIT, parseInt(url.searchParams.get('limit') ?? '100', 10) || 100),
    )
    const log = (await this.room.storage.get<AuditEntry[]>(AUDIT_KEY)) ?? []
    return jsonResponse(200, { ok: true, entries: log.slice(-limit) })
  }

  private async loadEntries(key: string): Promise<LeaderboardEntry[]> {
    const raw = await this.room.storage.get<LeaderboardEntry[]>(key)
    return Array.isArray(raw) ? raw.slice(0, MAX_ENTRIES_PER_TRACK) : []
  }

  private async loadBlocklist(): Promise<Set<string>> {
    const raw = await this.room.storage.get<string[]>(BLOCKLIST_KEY)
    return new Set(Array.isArray(raw) ? raw : [])
  }

  private async audit(entry: AuditEntry): Promise<void> {
    const existing = (await this.room.storage.get<AuditEntry[]>(AUDIT_KEY)) ?? []
    existing.push(entry)
    const trimmed = existing.length > AUDIT_LOG_LIMIT ? existing.slice(-AUDIT_LOG_LIMIT) : existing
    await this.room.storage.put(AUDIT_KEY, trimmed)
  }

  private evictExpiredNonces(now: number): void {
    for (const [nonce, ts] of this.recentNonces) {
      if (now - ts > NONCE_TTL_MS) this.recentNonces.delete(nonce)
    }
  }
}

LeaderboardServer satisfies Party.Worker

function validateSubmitShape(body: unknown): { ok: true } | { ok: false; detail: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, detail: 'not an object' }
  const b = body as Record<string, unknown>
  if (typeof b.trackId !== 'string' || b.trackId.length === 0)
    return { ok: false, detail: 'trackId' }
  if (typeof b.handle !== 'string') return { ok: false, detail: 'handle' }
  if (typeof b.bikeId !== 'string' || b.bikeId.length === 0) return { ok: false, detail: 'bikeId' }
  if (typeof b.bestLap !== 'number' || !Number.isFinite(b.bestLap))
    return { ok: false, detail: 'bestLap' }
  if (typeof b.ts !== 'number' || !Number.isFinite(b.ts)) return { ok: false, detail: 'ts' }
  if (typeof b.nonce !== 'string' || b.nonce.length < 8) return { ok: false, detail: 'nonce' }
  if (typeof b.signature !== 'string' || !b.signature.startsWith('sha256:'))
    return { ok: false, detail: 'signature' }
  return { ok: true }
}
