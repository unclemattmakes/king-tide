import { describe, expect, it } from 'vitest'
import { newNonce, signPayload, verifySignature } from '../../src/engine/leaderboard/hmac'

const SECRET = 'unit-test-secret-do-not-ship'

describe('signPayload + verifySignature', () => {
  it('signs and verifies a payload', async () => {
    const payload = 'trackId:lagoon|handle:ABC|bestLap:42|ts:1700000000000|nonce:xyz'
    const sig = await signPayload(payload, SECRET)
    expect(sig.startsWith('sha256:')).toBe(true)
    expect(await verifySignature(payload, sig, SECRET)).toBe(true)
  })

  it('rejects a signature signed with a different secret', async () => {
    const payload = 'hello'
    const sig = await signPayload(payload, SECRET)
    expect(await verifySignature(payload, sig, 'wrong-secret')).toBe(false)
  })

  it('rejects when the payload is tampered with', async () => {
    const payload = 'hello'
    const sig = await signPayload(payload, SECRET)
    expect(await verifySignature('hellp', sig, SECRET)).toBe(false)
  })

  it('rejects a malformed signature string', async () => {
    expect(await verifySignature('hello', 'not-a-sig', SECRET)).toBe(false)
    expect(await verifySignature('hello', 'sha256:zzz', SECRET)).toBe(false)
  })

  it('is deterministic — same input → same signature', async () => {
    const p = 'a:1|b:2'
    const a = await signPayload(p, SECRET)
    const b = await signPayload(p, SECRET)
    expect(a).toBe(b)
  })
})

describe('newNonce', () => {
  it('is 32 hex chars', () => {
    const n = newNonce()
    expect(n).toHaveLength(32)
    expect(/^[0-9a-f]{32}$/.test(n)).toBe(true)
  })

  it('produces different values', () => {
    const a = newNonce()
    const b = newNonce()
    expect(a).not.toBe(b)
  })
})
