/**
 * Relay ping→pong echo + control-message parsing.
 *
 * The relay is a thin wrapper around Party.Room — we don't spin up
 * partykit here; we instantiate the server class against a fake Room
 * that captures `send` calls. The shape is small enough that a
 * hand-rolled fake is more honest than a mock framework.
 */
import { describe, expect, it } from 'vitest'
import RelayServer from '../../party/relay'

type SentMsg = string | ArrayBuffer | ArrayBufferView
type FakeConn = {
  id: string
  state: { slot: number } | null
  sent: SentMsg[]
  send(m: SentMsg): void
  setState(s: { slot: number } | null): void
  close(_code?: number, _reason?: string): void
}

function makeConn(id: string): FakeConn {
  const sent: SentMsg[] = []
  let state: { slot: number } | null = null
  return {
    id,
    get state() {
      return state
    },
    sent,
    send(m) {
      sent.push(m)
    },
    setState(s) {
      state = s
    },
    close() {
      /* no-op for tests */
    },
  }
}

function makeRoom(): { server: RelayServer; conns: FakeConn[]; broadcasts: SentMsg[] } {
  const conns: FakeConn[] = []
  const broadcasts: SentMsg[] = []
  const stored = new Map<string, unknown>()
  const fakeRoom = {
    id: 'test-room',
    getConnections: <T = unknown>() => conns as unknown as Iterable<{ id: string; state: T }>,
    broadcast: (msg: SentMsg, _exclude?: string[]) => {
      broadcasts.push(msg)
    },
    // In-memory stand-in for Durable Object storage — the relay
    // persists the race lock through it (see RACE_STORAGE_KEY).
    storage: {
      get: async (k: string) => stored.get(k),
      put: async (k: string, v: unknown) => {
        stored.set(k, v)
      },
      delete: async (k: string) => stored.delete(k),
    },
  }
  // The relay only uses room.id + getConnections + broadcast + storage,
  // so the narrow fake above is enough. Cast carries us over the
  // Party.Room type that the constructor expects.
  const server = new RelayServer(
    fakeRoom as unknown as ConstructorParameters<typeof RelayServer>[0],
  )
  return { server, conns, broadcasts }
}

describe('relay ping/pong', () => {
  it('echoes a pong with the same timestamp back to the sender only', async () => {
    const { server, conns, broadcasts } = makeRoom()
    const a = makeConn('a')
    conns.push(a)
    await server.onConnect(a as never, {} as never)
    // Drain hello + peer-joined broadcasts from the connect path.
    a.sent.length = 0
    broadcasts.length = 0

    await server.onMessage(JSON.stringify({ type: 'ping', t: 1234.5 }), a as never)
    // Sender got a direct pong — no broadcast (other peers don't care).
    expect(broadcasts).toEqual([])
    expect(a.sent).toHaveLength(1)
    const reply = JSON.parse(a.sent[0] as string)
    expect(reply).toEqual({ type: 'pong', t: 1234.5 })
  })

  it('does not affect the sticky race-started bit', async () => {
    const { server, conns } = makeRoom()
    const a = makeConn('a')
    conns.push(a)
    await server.onConnect(a as never, {} as never)
    a.sent.length = 0

    // Ping a few times.
    for (let i = 0; i < 3; i++) {
      await server.onMessage(JSON.stringify({ type: 'ping', t: i }), a as never)
    }
    a.sent.length = 0

    // A late joiner should still see raceStarted=false (no `start-race`
    // was ever sent through).
    const b = makeConn('b')
    conns.push(b)
    await server.onConnect(b as never, {} as never)
    const hello = JSON.parse(b.sent[0] as string)
    expect(hello.type).toBe('hello')
    expect(hello.raceStarted).toBe(false)
  })

  it('drops malformed pings (non-numeric t) without crashing or replying', async () => {
    const { server, conns, broadcasts } = makeRoom()
    const a = makeConn('a')
    conns.push(a)
    await server.onConnect(a as never, {} as never)
    a.sent.length = 0
    broadcasts.length = 0

    await server.onMessage(JSON.stringify({ type: 'ping', t: 'not-a-number' }), a as never)
    // Parser rejected the payload — no reply, no broadcast, no throw.
    expect(a.sent).toEqual([])
    expect(broadcasts).toEqual([])
  })

  it('does not reply to a ping from an unassigned connection', async () => {
    // A connection that never went through onConnect (state is null) —
    // the relay should ignore its ctl messages entirely so a peer
    // racing the slot-assign handshake can't smuggle in echoes.
    const { server } = makeRoom()
    const a = makeConn('a')
    // No setState — `a.state` stays null.
    await server.onMessage(JSON.stringify({ type: 'ping', t: 5 }), a as never)
    expect(a.sent).toEqual([])
  })
})
