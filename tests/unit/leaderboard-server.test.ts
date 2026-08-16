/**
 * In-process tests for the leaderboard PartyKit server. We can't spin
 * up a real Cloudflare Worker in vitest, so we build a tiny shim that
 * matches the `Party.Room` surface the server actually touches:
 *
 *   - `storage` — a Map-backed mock with `get` / `put` / `list`
 *   - `env`     — a plain object of secrets
 *
 * Then exercise `onRequest()` with real `Request` instances. This
 * gives high-confidence coverage of the routing, validation, HMAC
 * check, plausibility floor, rate limit, audit log, and admin
 * endpoints — everything except the actual Durable Object durability
 * (which is the platform's job).
 */

import type * as Party from 'partykit/server'
import { beforeEach, describe, expect, it } from 'vitest'
import LeaderboardServer from '../../party/leaderboard'
import { DEV_HMAC_SECRET, signPayload } from '../../src/engine/leaderboard/hmac'
import {
  canonicalSubmitPayload,
  type SubmitBody,
  type SubmitResponse,
} from '../../src/engine/leaderboard/protocol'

const SECRET = 'leaderboard-server-test-secret'
const ADMIN_TOKEN = 'admin-test-token'

type Storage = {
  data: Map<string, unknown>
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  // Returns a Map matching the prefix subset. Mirrors DurableObjectStorage.
  list<T>(opts: { prefix: string }): Promise<Map<string, T>>
}

function mockStorage(): Storage {
  const data = new Map<string, unknown>()
  return {
    data,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined
    },
    async put<T>(key: string, value: T): Promise<void> {
      data.set(key, value)
    },
    async list<T>(opts: { prefix: string }): Promise<Map<string, T>> {
      const out = new Map<string, T>()
      for (const [k, v] of data) {
        if (k.startsWith(opts.prefix)) out.set(k, v as T)
      }
      return out
    },
  }
}

function mockRoom(env: Record<string, string>): {
  storage: Storage
  env: Record<string, unknown>
  id: string
} {
  // The mock matches the slice of `Party.Room` the server actually
  // touches; cast through unknown to satisfy the full Room shape.
  return {
    storage: mockStorage(),
    env,
    id: 'global',
  } as unknown as { storage: Storage; env: Record<string, unknown>; id: string }
}

function makeServer(
  env: Record<string, string> = {
    LEADERBOARD_HMAC_SECRET: SECRET,
    LEADERBOARD_ADMIN_TOKEN: ADMIN_TOKEN,
  },
) {
  const room = mockRoom(env)
  const server = new LeaderboardServer(room as unknown as Party.Room)
  return { server, room }
}

async function buildSignedBody(
  partial: Partial<SubmitBody> & {
    trackId: string
    handle: string
    bikeId: string
    bestLap: number
  },
  secret = SECRET,
): Promise<SubmitBody> {
  const body = {
    trackId: partial.trackId,
    handle: partial.handle,
    bikeId: partial.bikeId,
    bestLap: partial.bestLap,
    ts: partial.ts ?? Date.now(),
    nonce: partial.nonce ?? cryptoNonce(),
  }
  const signature = await signPayload(canonicalSubmitPayload(body), secret)
  return { ...body, signature }
}

function cryptoNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += (b < 16 ? '0' : '') + b.toString(16)
  return out
}

// PartyKit's `Party.Request` extends Cloudflare's CFRequest, which
// has fields the standard `Request` constructor doesn't populate
// (e.g. `fetcher`). Tests don't exercise those — cast through unknown.
function asPartyRequest(req: Request): Party.Request {
  return req as unknown as Party.Request
}

function submitReq(body: SubmitBody, ip = '203.0.113.1'): Party.Request {
  return asPartyRequest(
    new Request('http://example.com/parties/leaderboard/global/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify(body),
    }),
  )
}

/** An authenticated admin request. Pass `body` for the POST routes. */
function adminReq(method: string, suffix: string, body?: unknown): Party.Request {
  return asPartyRequest(
    new Request(`http://example.com/parties/leaderboard/global${suffix}`, {
      method,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

type UnblockResponse = {
  ok: boolean
  handle: string
  removed: boolean
  blocklistSize: number
}

type BlocklistResponse = { ok: boolean; handles: string[]; blocklistSize: number }

async function asJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

describe('leaderboard server — submit', () => {
  it('accepts a valid signed submission', async () => {
    const { server } = makeServer()
    const body = await buildSignedBody({
      trackId: 'lagoon',
      handle: 'ABC',
      bikeId: 'racer',
      bestLap: 42,
    })
    const res = await server.onRequest(submitReq(body))
    const json = await asJson<SubmitResponse>(res)
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, rank: 1, improved: true, total: 1 })
  })

  it('rejects a bad signature', async () => {
    const { server } = makeServer()
    const body = await buildSignedBody(
      { trackId: 'lagoon', handle: 'ABC', bikeId: 'racer', bestLap: 42 },
      'wrong-secret',
    )
    const res = await server.onRequest(submitReq(body))
    expect(res.status).toBe(401)
    expect(await asJson<SubmitResponse>(res)).toMatchObject({ ok: false, error: 'bad-signature' })
  })

  // The fail-open bug this guards: with no LEADERBOARD_HMAC_SECRET the server
  // used to fall back to DEV_HMAC_SECRET — a constant living in the source
  // tree — and so accepted anything signed with it, from anyone. An
  // unconfigured deploy must accept no writes at all.
  it('refuses submissions when no signing secret is configured', async () => {
    const { server } = makeServer({ LEADERBOARD_ADMIN_TOKEN: ADMIN_TOKEN })
    const body = await buildSignedBody(
      { trackId: 'lagoon', handle: 'ABC', bikeId: 'racer', bestLap: 42 },
      DEV_HMAC_SECRET,
    )
    const res = await server.onRequest(submitReq(body))
    expect(res.status).toBe(503)
    expect(await asJson<SubmitResponse>(res)).toMatchObject({ ok: false, error: 'unconfigured' })
  })

  it('refuses even a correctly-signed submission when unconfigured', async () => {
    // Nothing can be "correct" without a server-side key — including a body
    // signed with the very secret an operator is about to configure.
    const { server } = makeServer({})
    const body = await buildSignedBody({
      trackId: 'lagoon',
      handle: 'ABC',
      bikeId: 'racer',
      bestLap: 42,
    })
    const res = await server.onRequest(submitReq(body))
    expect(res.status).toBe(503)
    expect(await asJson<SubmitResponse>(res)).toMatchObject({ ok: false, error: 'unconfigured' })
  })

  it('still serves reads when unconfigured (writes fail closed, reads do not)', async () => {
    const { server } = makeServer({})
    const res = await server.onRequest(
      asPartyRequest(new Request('http://example.com/parties/leaderboard/global/board/lagoon')),
    )
    expect(res.status).toBe(200)
    expect(await asJson<{ trackId: string }>(res)).toMatchObject({ trackId: 'lagoon' })
  })

  it('rejects the dev secret once a real one is configured', async () => {
    const { server } = makeServer()
    const body = await buildSignedBody(
      { trackId: 'lagoon', handle: 'ABC', bikeId: 'racer', bestLap: 42 },
      DEV_HMAC_SECRET,
    )
    const res = await server.onRequest(submitReq(body))
    expect(res.status).toBe(401)
    expect(await asJson<SubmitResponse>(res)).toMatchObject({ ok: false, error: 'bad-signature' })
  })

  it('rejects a stale timestamp', async () => {
    const { server } = makeServer()
    const body = await buildSignedBody({
      trackId: 'lagoon',
      handle: 'ABC',
      bikeId: 'racer',
      bestLap: 42,
      ts: Date.now() - 10 * 60 * 1000, // 10 min ago — outside the ±5 min window
    })
    const res = await server.onRequest(submitReq(body))
    expect(res.status).toBe(400)
    expect(await asJson<SubmitResponse>(res)).toMatchObject({ ok: false, error: 'stale-timestamp' })
  })

  it('rejects a replayed nonce', async () => {
    const { server } = makeServer()
    const body = await buildSignedBody({
      trackId: 'lagoon',
      handle: 'ABC',
      bikeId: 'racer',
      bestLap: 42,
    })
    // First submit lands.
    const first = await server.onRequest(submitReq(body))
    expect(first.status).toBe(200)
    // Second submit with the same nonce — even though we change IP to
    // dodge the rate limit, the nonce should still be flagged.
    const second = await server.onRequest(submitReq(body, '198.51.100.5'))
    expect(second.status).toBe(400)
    expect(await asJson<SubmitResponse>(second)).toMatchObject({ ok: false, error: 'replay' })
  })

  it('rejects profanity', async () => {
    const { server } = makeServer()
    const body = await buildSignedBody({
      trackId: 'lagoon',
      handle: 'FUCKER',
      bikeId: 'racer',
      bestLap: 42,
    })
    const res = await server.onRequest(submitReq(body))
    expect(res.status).toBe(400)
    expect(await asJson<SubmitResponse>(res)).toMatchObject({ ok: false, error: 'profanity' })
  })

  it('rejects implausible lap times', async () => {
    const { server } = makeServer()
    const body = await buildSignedBody({
      trackId: 'lagoon',
      handle: 'ABC',
      bikeId: 'racer',
      bestLap: 0.5, // way under the lagoon floor (8 s)
    })
    const res = await server.onRequest(submitReq(body))
    expect(res.status).toBe(400)
    expect(await asJson<SubmitResponse>(res)).toMatchObject({
      ok: false,
      error: 'implausible-time',
    })
  })

  it('rate-limits a second submission from the same IP inside 5 s', async () => {
    const { server } = makeServer()
    const first = await buildSignedBody({
      trackId: 'lagoon',
      handle: 'ABC',
      bikeId: 'racer',
      bestLap: 42,
    })
    const second = await buildSignedBody({
      trackId: 'lagoon',
      handle: 'DEF',
      bikeId: 'racer',
      bestLap: 41,
    })
    const r1 = await server.onRequest(submitReq(first))
    const r2 = await server.onRequest(submitReq(second))
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(429)
    expect(await asJson<SubmitResponse>(r2)).toMatchObject({ ok: false, error: 'rate-limited' })
  })

  it('dedupes by handle — slower submit returns improved:false', async () => {
    const { server } = makeServer()
    const fast = await buildSignedBody({
      trackId: 'lagoon',
      handle: 'ABC',
      bikeId: 'racer',
      bestLap: 30,
    })
    const slow = await buildSignedBody({
      trackId: 'lagoon',
      handle: 'ABC',
      bikeId: 'racer',
      bestLap: 40,
    })
    const r1 = await server.onRequest(submitReq(fast))
    expect(r1.status).toBe(200)
    // Use a fresh IP to dodge rate limit.
    const r2 = await server.onRequest(submitReq(slow, '198.51.100.20'))
    expect(r2.status).toBe(200)
    expect(await asJson<SubmitResponse>(r2)).toMatchObject({
      ok: true,
      improved: false,
    })
  })
})

describe('leaderboard server — GET /board', () => {
  it('returns empty when no entries', async () => {
    const { server } = makeServer()
    const req = asPartyRequest(
      new Request('http://example.com/parties/leaderboard/global/board/lagoon'),
    )
    const res = await server.onRequest(req)
    expect(res.status).toBe(200)
    const body = await asJson<{ entries: unknown[] }>(res)
    expect(body.entries).toEqual([])
  })

  it('returns the stored entries sorted', async () => {
    const { server } = makeServer()
    for (const lap of [50, 30, 40]) {
      const body = await buildSignedBody({
        trackId: 'lagoon',
        handle: `H${lap}`,
        bikeId: 'racer',
        bestLap: lap,
      })
      await server.onRequest(submitReq(body, `203.0.113.${lap}`))
    }
    const req = asPartyRequest(
      new Request('http://example.com/parties/leaderboard/global/board/lagoon'),
    )
    const res = await server.onRequest(req)
    const body = await asJson<{ entries: Array<{ handle: string; bestLap: number }> }>(res)
    expect(body.entries.map((e) => e.handle)).toEqual(['H30', 'H40', 'H50'])
  })
})

describe('leaderboard server — admin', () => {
  beforeEach(() => {})

  it('rejects admin endpoints without bearer token', async () => {
    const { server } = makeServer()
    const req = asPartyRequest(
      new Request('http://example.com/parties/leaderboard/global/admin/audit', {
        method: 'GET',
      }),
    )
    const res = await server.onRequest(req)
    expect(res.status).toBe(401)
  })

  it('wipes every entry by handle + blocks future submissions', async () => {
    const { server } = makeServer()
    for (const trackId of ['lagoon', 'cliffside']) {
      const body = await buildSignedBody({
        trackId,
        handle: 'BADWIFE',
        bikeId: 'racer',
        bestLap: 30,
      })
      await server.onRequest(submitReq(body, `203.0.113.${trackId === 'lagoon' ? 1 : 2}`))
    }
    // Wipe.
    const wipe = await server.onRequest(
      asPartyRequest(
        new Request('http://example.com/parties/leaderboard/global/admin/handle/BADWIFE', {
          method: 'DELETE',
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
      ),
    )
    expect(wipe.status).toBe(200)
    const wipeBody = await asJson<{ tracksTouched: number }>(wipe)
    expect(wipeBody.tracksTouched).toBe(2)
    // Future submit with the blocked handle should bounce.
    const retry = await buildSignedBody({
      trackId: 'lagoon',
      handle: 'BADWIFE',
      bikeId: 'racer',
      bestLap: 20,
    })
    const res = await server.onRequest(submitReq(retry, '198.51.100.99'))
    expect(res.status).toBe(400)
    expect(await asJson<SubmitResponse>(res)).toMatchObject({ ok: false, error: 'blocked-handle' })
  })

  it('removes a specific entry by rank', async () => {
    const { server } = makeServer()
    for (const lap of [50, 30, 40]) {
      const body = await buildSignedBody({
        trackId: 'lagoon',
        handle: `H${lap}`,
        bikeId: 'racer',
        bestLap: lap,
      })
      await server.onRequest(submitReq(body, `203.0.113.${lap}`))
    }
    // Rank 2 should be H40 (30/40/50).
    const wipe = await server.onRequest(
      asPartyRequest(
        new Request('http://example.com/parties/leaderboard/global/admin/entry/lagoon/2', {
          method: 'DELETE',
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
      ),
    )
    expect(wipe.status).toBe(200)
    const board = await server.onRequest(
      asPartyRequest(new Request('http://example.com/parties/leaderboard/global/board/lagoon')),
    )
    const body = await asJson<{ entries: Array<{ handle: string }> }>(board)
    expect(body.entries.map((e) => e.handle)).toEqual(['H30', 'H50'])
  })

  it('blocks a handle without wiping past entries', async () => {
    const { server } = makeServer()
    // Pre-seed an entry from the soon-to-be-blocked handle.
    const seeded = await buildSignedBody({
      trackId: 'lagoon',
      handle: 'BORN1',
      bikeId: 'racer',
      bestLap: 30,
    })
    await server.onRequest(submitReq(seeded, '203.0.113.10'))
    // Block.
    const block = await server.onRequest(
      asPartyRequest(
        new Request('http://example.com/parties/leaderboard/global/admin/block', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${ADMIN_TOKEN}`,
          },
          body: JSON.stringify({ handle: 'BORN1' }),
        }),
      ),
    )
    expect(block.status).toBe(200)
    // Existing entry stays.
    const board = await server.onRequest(
      asPartyRequest(new Request('http://example.com/parties/leaderboard/global/board/lagoon')),
    )
    const body = await asJson<{ entries: Array<{ handle: string }> }>(board)
    expect(body.entries.map((e) => e.handle)).toContain('BORN1')
    // Future submit bounces.
    const retry = await buildSignedBody({
      trackId: 'lagoon',
      handle: 'BORN1',
      bikeId: 'racer',
      bestLap: 25,
    })
    const res = await server.onRequest(submitReq(retry, '198.51.100.100'))
    expect(await asJson<SubmitResponse>(res)).toMatchObject({ ok: false, error: 'blocked-handle' })
  })

  it('unblocks a handle — it can submit again', async () => {
    const { server } = makeServer()
    // Block, then confirm the block bites.
    const block = await server.onRequest(adminReq('POST', '/admin/block', { handle: 'TST' }))
    expect(block.status).toBe(200)
    const blocked = await server.onRequest(
      submitReq(
        await buildSignedBody({
          trackId: 'lagoon',
          handle: 'TST',
          bikeId: 'racer',
          bestLap: 30,
        }),
        '203.0.113.30',
      ),
    )
    expect(await asJson<SubmitResponse>(blocked)).toMatchObject({
      ok: false,
      error: 'blocked-handle',
    })
    // Unblock.
    const unblock = await server.onRequest(adminReq('DELETE', '/admin/block/TST'))
    expect(unblock.status).toBe(200)
    expect(await asJson<UnblockResponse>(unblock)).toMatchObject({
      ok: true,
      handle: 'TST',
      removed: true,
      blocklistSize: 0,
    })
    // Same handle now lands. Fresh IP to dodge the rate limit.
    const retry = await server.onRequest(
      submitReq(
        await buildSignedBody({
          trackId: 'lagoon',
          handle: 'TST',
          bikeId: 'racer',
          bestLap: 30,
        }),
        '198.51.100.30',
      ),
    )
    expect(retry.status).toBe(200)
    expect(await asJson<SubmitResponse>(retry)).toMatchObject({ ok: true, improved: true })
  })

  it('unblocks the block half of wipe-handle', async () => {
    const { server } = makeServer()
    await server.onRequest(adminReq('DELETE', '/admin/handle/OOPS'))
    const unblock = await server.onRequest(adminReq('DELETE', '/admin/block/OOPS'))
    expect(await asJson<UnblockResponse>(unblock)).toMatchObject({ removed: true })
    const res = await server.onRequest(
      submitReq(
        await buildSignedBody({
          trackId: 'lagoon',
          handle: 'OOPS',
          bikeId: 'racer',
          bestLap: 30,
        }),
        '198.51.100.31',
      ),
    )
    expect(res.status).toBe(200)
  })

  it('unblocking an unblocked handle is a no-op, not an error', async () => {
    const { server } = makeServer()
    const res = await server.onRequest(adminReq('DELETE', '/admin/block/NEVERBLOCKD'))
    expect(res.status).toBe(200)
    expect(await asJson<UnblockResponse>(res)).toMatchObject({ removed: false, blocklistSize: 0 })
  })

  it('rejects unblock without a bearer token', async () => {
    const { server } = makeServer()
    await server.onRequest(adminReq('POST', '/admin/block', { handle: 'TST' }))
    const res = await server.onRequest(
      asPartyRequest(
        new Request('http://example.com/parties/leaderboard/global/admin/block/TST', {
          method: 'DELETE',
        }),
      ),
    )
    expect(res.status).toBe(401)
    // And the handle is still blocked.
    const list = await server.onRequest(adminReq('GET', '/admin/blocklist'))
    expect(await asJson<BlocklistResponse>(list)).toMatchObject({ handles: ['TST'] })
  })

  it('rejects unblock with the wrong bearer token', async () => {
    const { server } = makeServer()
    await server.onRequest(adminReq('POST', '/admin/block', { handle: 'TST' }))
    const res = await server.onRequest(
      asPartyRequest(
        new Request('http://example.com/parties/leaderboard/global/admin/block/TST', {
          method: 'DELETE',
          headers: { authorization: 'Bearer not-the-admin-token' },
        }),
      ),
    )
    expect(res.status).toBe(401)
    const list = await server.onRequest(adminReq('GET', '/admin/blocklist'))
    expect(await asJson<BlocklistResponse>(list)).toMatchObject({ handles: ['TST'] })
  })

  it('lists the blocklist, sorted', async () => {
    const { server } = makeServer()
    const empty = await server.onRequest(adminReq('GET', '/admin/blocklist'))
    expect(empty.status).toBe(200)
    expect(await asJson<BlocklistResponse>(empty)).toMatchObject({ handles: [], blocklistSize: 0 })
    for (const handle of ['ZED', 'ABC']) {
      await server.onRequest(adminReq('POST', '/admin/block', { handle }))
    }
    await server.onRequest(adminReq('DELETE', '/admin/handle/MID'))
    const list = await server.onRequest(adminReq('GET', '/admin/blocklist'))
    expect(await asJson<BlocklistResponse>(list)).toMatchObject({
      handles: ['ABC', 'MID', 'ZED'],
      blocklistSize: 3,
    })
  })

  it('rejects GET /admin/blocklist without a bearer token', async () => {
    const { server } = makeServer()
    const res = await server.onRequest(
      asPartyRequest(
        new Request('http://example.com/parties/leaderboard/global/admin/blocklist', {
          method: 'GET',
        }),
      ),
    )
    expect(res.status).toBe(401)
  })

  it('audit log captures outcomes', async () => {
    const { server } = makeServer()
    const ok = await buildSignedBody({
      trackId: 'lagoon',
      handle: 'OK',
      bikeId: 'racer',
      bestLap: 30,
    })
    await server.onRequest(submitReq(ok, '203.0.113.5'))
    const bad = await buildSignedBody(
      { trackId: 'lagoon', handle: 'OK', bikeId: 'racer', bestLap: 25 },
      'wrong-secret',
    )
    await server.onRequest(submitReq(bad, '203.0.113.6'))
    const audit = await server.onRequest(
      asPartyRequest(
        new Request('http://example.com/parties/leaderboard/global/admin/audit?limit=10', {
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
      ),
    )
    const body = await asJson<{ entries: Array<{ outcome: string }> }>(audit)
    const outcomes = body.entries.map((e) => e.outcome)
    expect(outcomes).toContain('accepted')
    expect(outcomes).toContain('bad-signature')
  })
})
