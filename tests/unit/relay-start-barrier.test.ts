/**
 * Relay synchronized-start barrier (race-loaded / race-go).
 *
 * Same hand-rolled fake-Room pattern as relay-ping.test.ts (no partykit
 * runtime). Pins the hold-and-release rules:
 *
 *  1. hello advertises the barrier capability,
 *  2. race-go fires once, only after every expected racer (cohort size
 *     captured at start-race) reports race-loaded,
 *  3. a racer whose race-loaded arrives after the go gets a direct
 *     replay (late in-grace joiner),
 *  4. a departed racer doesn't hang the grid (everyone-still-present
 *     rule on close),
 *  5. the hold times out past RACE_START_TIMEOUT_MS,
 *  6. the expected-racer count survives an instance recycle via room
 *     storage (the lobby→race handoff empties the room every time).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import RelayServer from '../../party/relay'

type SentMsg = string | ArrayBuffer | ArrayBufferView

type FakeConn = {
  id: string
  state: unknown
  sent: SentMsg[]
  closed: { code: number | undefined; reason: string | undefined } | null
  send(m: SentMsg): void
  setState(s: unknown): void
  close(code?: number, reason?: string): void
}

function makeConn(id: string): FakeConn {
  const conn: FakeConn = {
    id,
    state: null,
    sent: [],
    closed: null,
    send(m) {
      conn.sent.push(m)
    },
    setState(s) {
      conn.state = s
    },
    close(code, reason) {
      conn.closed = { code, reason }
    },
  }
  return conn
}

type FakeRoom = {
  server: RelayServer
  conns: FakeConn[]
  broadcasts: SentMsg[]
  stored: Map<string, unknown>
  connect(id: string): Promise<FakeConn>
  message(conn: FakeConn, msg: object): Promise<void>
  close(conn: FakeConn): Promise<void>
}

function makeRoom(stored = new Map<string, unknown>()): FakeRoom {
  const conns: FakeConn[] = []
  const broadcasts: SentMsg[] = []
  const fakeRoom = {
    id: 'barrier-test-room',
    getConnections: <T = unknown>() => conns as unknown as Iterable<{ id: string; state: T }>,
    broadcast: (msg: SentMsg, _exclude?: string[]) => {
      broadcasts.push(msg)
    },
    storage: {
      get: async (k: string) => stored.get(k),
      put: async (k: string, v: unknown) => {
        stored.set(k, v)
      },
      delete: async (k: string) => stored.delete(k),
    },
  }
  const server = new RelayServer(
    fakeRoom as unknown as ConstructorParameters<typeof RelayServer>[0],
  )
  return {
    server,
    conns,
    broadcasts,
    stored,
    async connect(id) {
      const c = makeConn(id)
      conns.push(c)
      await server.onConnect(c as never, {} as never)
      return c
    },
    async message(conn, msg) {
      await server.onMessage(JSON.stringify(msg), conn as never)
    },
    async close(conn) {
      const i = conns.indexOf(conn)
      if (i >= 0) conns.splice(i, 1)
      await server.onClose(conn as never)
    },
  }
}

function ofType(msgs: SentMsg[], type: string): unknown[] {
  return msgs
    .filter((m): m is string => typeof m === 'string')
    .map((m) => JSON.parse(m) as { type: string })
    .filter((m) => m.type === type)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('relay synchronized-start barrier', () => {
  it('advertises the barrier capability in hello', async () => {
    const room = makeRoom()
    const a = await room.connect('a')
    const hello = JSON.parse(a.sent[0] as string)
    expect(hello.type).toBe('hello')
    expect(hello.startBarrier).toBe(true)
  })

  it('holds race-go until every expected racer has loaded, then fires once', async () => {
    const room = makeRoom()
    const a = await room.connect('a')
    const b = await room.connect('b')
    await room.message(a, { type: 'start-race', trackId: 'sandbar' }) // cohort = 2

    await room.message(a, { type: 'race-loaded' })
    expect(ofType(room.broadcasts, 'race-go')).toHaveLength(0)

    await room.message(b, { type: 'race-loaded' })
    expect(ofType(room.broadcasts, 'race-go')).toHaveLength(1)

    // Duplicate loaded reports after the go don't re-broadcast — they
    // get a direct replay instead.
    await room.message(a, { type: 'race-loaded' })
    expect(ofType(room.broadcasts, 'race-go')).toHaveLength(1)
    expect(ofType(a.sent, 'race-go')).toHaveLength(1)
  })

  it('replays race-go directly to a racer who loads after the grid launched', async () => {
    const room = makeRoom()
    const a = await room.connect('a')
    await room.message(a, { type: 'start-race', trackId: 'sandbar' }) // cohort = 1
    await room.message(a, { type: 'race-loaded' })
    expect(ofType(room.broadcasts, 'race-go')).toHaveLength(1)

    // Late in-grace joiner: admitted, then released solo on report.
    const c = await room.connect('c')
    expect(c.closed).toBeNull()
    await room.message(c, { type: 'race-loaded' })
    expect(ofType(c.sent, 'race-go')).toHaveLength(1)
    expect(ofType(room.broadcasts, 'race-go')).toHaveLength(1) // no re-broadcast
  })

  it('holds through a departure (socket churn ≠ abandonment); timeout still releases', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-09T12:00:00Z'))
    const room = makeRoom()
    const a = await room.connect('a')
    const b = await room.connect('b')
    await room.message(a, { type: 'start-race', trackId: 'sandbar' }) // cohort = 2
    await room.message(a, { type: 'race-loaded' })

    // B's socket closes mid-load. This must NOT release the grid — a
    // transient drop during a slow load looks identical to leaving,
    // and an early go splits the start when B reconnects (seen live).
    await room.close(b)
    expect(ofType(room.broadcasts, 'race-go')).toHaveLength(0)

    // If B truly never returns, the timeout bounds the wait.
    vi.setSystemTime(new Date('2026-06-09T12:00:26Z'))
    await room.message(a, { type: 'race-loaded' })
    expect(ofType(room.broadcasts, 'race-go')).toHaveLength(1)
  })

  it('releases on the start timeout so a vanished racer cannot hold the grid', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-09T12:00:00Z'))
    const room = makeRoom()
    const a = await room.connect('a')
    await room.connect('b')
    await room.message(a, { type: 'start-race', trackId: 'sandbar' }) // cohort = 2
    await room.message(a, { type: 'race-loaded' })
    expect(ofType(room.broadcasts, 'race-go')).toHaveLength(0)

    // 26 s later (past RACE_START_TIMEOUT_MS = 25 s) any barrier event
    // releases the hold — here A's re-report.
    vi.setSystemTime(new Date('2026-06-09T12:00:26Z'))
    await room.message(a, { type: 'race-loaded' })
    expect(ofType(room.broadcasts, 'race-go')).toHaveLength(1)
  })

  it('keeps the expected-racer count across an instance recycle (storage)', async () => {
    const stored = new Map<string, unknown>()
    // Session 1: the lobby cohort of two starts the race, then both
    // lobby sockets close (the navigation handoff empties the room).
    const room1 = makeRoom(stored)
    const a = await room1.connect('a')
    const b = await room1.connect('b')
    await room1.message(a, { type: 'start-race', trackId: 'sandbar' })
    await room1.close(b)
    await room1.close(a)

    // Session 2: a FRESH server instance (the platform recycled it) on
    // the same storage. Race tabs arrive; the barrier must still wait
    // for BOTH before firing.
    const room2 = makeRoom(stored)
    const a2 = await room2.connect('a2')
    const hello = JSON.parse(a2.sent[0] as string)
    expect(hello.raceStarted).toBe(true) // lock survived the recycle
    await room2.message(a2, { type: 'race-loaded' })
    expect(ofType(room2.broadcasts, 'race-go')).toHaveLength(0) // still holding for #2

    const b2 = await room2.connect('b2')
    await room2.message(b2, { type: 'race-loaded' })
    expect(ofType(room2.broadcasts, 'race-go')).toHaveLength(1)
  })
})
