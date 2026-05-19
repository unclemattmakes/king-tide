/**
 * @vitest-environment jsdom
 *
 * Step 8 — Console-trap unit coverage.
 *
 * The trap is module-level state so each test resets the singleton
 * before installing. Mostly we exercise:
 *
 *  - install is idempotent — `installConsoleTrap()` called twice returns
 *    the same instance and does NOT stack `console.error` proxies (one
 *    user-visible regression would be a runaway recursion on every
 *    error after HMR)
 *  - console.error/warn calls land in the ring with the right source +
 *    message; the original console functions still fire
 *  - error-class records (error / pageerror / unhandledrejection) trip
 *    `hasErrors()`; warnings don't
 *  - ring overflow drops the oldest entry, not the newest
 *  - `recordsSince(prev)` returns the delta even if the ring overflowed
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetConsoleTrapForTest,
  consoleTrap,
  installConsoleTrap,
} from '../../src/engine/qa/console-trap'

afterEach(() => {
  __resetConsoleTrapForTest()
  vi.restoreAllMocks()
})

describe('console-trap', () => {
  it('returns the same instance on repeat installs (idempotent)', () => {
    const a = installConsoleTrap()
    const b = installConsoleTrap()
    expect(a).toBe(b)
    expect(consoleTrap()).toBe(a)
  })

  it('captures console.error / console.warn into the ring without swallowing them', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const trap = installConsoleTrap()

    console.error('boom', 42)
    console.warn('careful')

    const records = trap.records()
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ source: 'error', message: 'boom 42' })
    expect(records[1]).toMatchObject({ source: 'warn', message: 'careful' })

    // The originals fire too — devtools still sees the message.
    expect(errSpy).toHaveBeenCalledWith('boom', 42)
    expect(warnSpy).toHaveBeenCalledWith('careful')
  })

  it('serialises Error objects with stack into the record', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const trap = installConsoleTrap()

    const err = new Error('kapow')
    console.error(err)

    const [rec] = trap.records()
    expect(rec?.source).toBe('error')
    expect(rec?.message).toContain('kapow')
    // Stack capture is best-effort but `new Error()` always produces one
    // under V8 / SpiderMonkey, so jsdom should have it.
    expect(rec?.stack).toBeDefined()
  })

  it('hasErrors discriminates between error- and warn-class records', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const trap = installConsoleTrap()

    console.warn('just a heads up')
    expect(trap.hasErrors()).toBe(false)

    console.error('actual problem')
    expect(trap.hasErrors()).toBe(true)
  })

  it('drops the oldest record when the ring overflows', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const trap = installConsoleTrap(3)

    console.error('a')
    console.error('b')
    console.error('c')
    console.error('d')

    const records = trap.records()
    expect(records.map((r) => r.message)).toEqual(['b', 'c', 'd'])
    expect(trap.totalCount()).toBe(4)
  })

  it('recordsSince returns the delta even when the ring already overflowed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const trap = installConsoleTrap(3)

    console.error('a')
    const prev = trap.totalCount()
    // Push 4 more — ring holds the most recent 3.
    console.error('b')
    console.error('c')
    console.error('d')
    console.error('e')

    const since = trap.recordsSince(prev)
    // We can only return what's still in the ring; expect the last 3.
    expect(since.map((r) => r.message)).toEqual(['c', 'd', 'e'])
  })

  it('clears the ring but keeps totalCount monotonic', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const trap = installConsoleTrap()
    console.error('a')
    console.error('b')
    expect(trap.records()).toHaveLength(2)
    trap.clear()
    expect(trap.records()).toHaveLength(0)
    expect(trap.totalCount()).toBe(2)
  })

  it('captures uncaught errors via window.error listener', () => {
    const trap = installConsoleTrap()
    // Fabricate the event Chromium would dispatch on an uncaught throw.
    const err = new Error('uncaught')
    const ev = new ErrorEvent('error', { error: err, message: 'uncaught' })
    window.dispatchEvent(ev)

    const records = trap.records()
    expect(records).toHaveLength(1)
    expect(records[0]?.source).toBe('pageerror')
    expect(records[0]?.message).toContain('uncaught')
  })

  it('captures unhandled promise rejections', () => {
    const trap = installConsoleTrap()
    // PromiseRejectionEvent isn't constructable in every jsdom version;
    // synthesise an Event with the right shape. The listener reads
    // `ev.reason` only — we don't need a real Promise.
    const ev = new Event('unhandledrejection') as Event & { reason?: unknown }
    ev.reason = new Error('nope')
    window.dispatchEvent(ev)

    const records = trap.records()
    expect(records).toHaveLength(1)
    expect(records[0]?.source).toBe('unhandledrejection')
    expect(records[0]?.message).toContain('nope')
  })
})
