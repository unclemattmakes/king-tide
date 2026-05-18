/**
 * mp-status pub/sub — the live read-only view consumed by the Settings
 * → Network tab, the lobby overlay, and the in-race room HUD chip.
 *
 * Verifies the only two contracts the consumers depend on:
 *  1. Subscribers run iff at least one field actually changed (so the
 *     per-frame snapshot pump doesn't thrash UI re-renders).
 *  2. `reset()` returns to the initial-idle state and fires subscribers
 *     exactly when state was non-idle (no spurious fire when already
 *     idle).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getMpStatus,
  onMpStatusChange,
  resetMpStatus,
  setMpStatus,
} from '../../src/engine/net/mp-status'

afterEach(() => {
  // Singleton module — reset between tests so each starts from
  // {state:'idle', roomId:null, ...} again.
  resetMpStatus()
})

describe('mp-status', () => {
  it('starts in the idle state with no room and no signal', () => {
    const s = getMpStatus()
    expect(s.state).toBe('idle')
    expect(s.roomId).toBeNull()
    expect(s.host).toBeNull()
    expect(s.peerId).toBe(-1)
    expect(s.remoteCount).toBe(0)
    expect(s.latencyMs).toBe(-1)
    expect(s.isHost).toBe(false)
  })

  it('publishes a patch and fires subscribers', () => {
    const fn = vi.fn()
    onMpStatusChange(fn)
    setMpStatus({ state: 'connecting', roomId: 'ABC123', host: 'localhost:1999' })
    expect(fn).toHaveBeenCalledTimes(1)
    const s = getMpStatus()
    expect(s.state).toBe('connecting')
    expect(s.roomId).toBe('ABC123')
    expect(s.host).toBe('localhost:1999')
    // Fields not in the patch carry over from the prior value.
    expect(s.peerId).toBe(-1)
  })

  it('does not fire subscribers when nothing actually changed', () => {
    setMpStatus({ state: 'connected', roomId: 'ROOM1', peerId: 0 })
    const fn = vi.fn()
    onMpStatusChange(fn)
    // Same values — no notification.
    setMpStatus({ state: 'connected', roomId: 'ROOM1', peerId: 0 })
    expect(fn).not.toHaveBeenCalled()
    // One real change — exactly one notification.
    setMpStatus({ latencyMs: 42 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('ignores undefined fields in the patch (lets callers be sparse)', () => {
    setMpStatus({ state: 'connected', roomId: 'R1' })
    const before = getMpStatus()
    setMpStatus({ state: undefined, roomId: undefined })
    const after = getMpStatus()
    expect(after).toEqual(before)
  })

  it('unsubscribe() removes the listener', () => {
    const fn = vi.fn()
    const off = onMpStatusChange(fn)
    setMpStatus({ state: 'connecting' })
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    setMpStatus({ state: 'connected' })
    expect(fn).toHaveBeenCalledTimes(1) // no further calls
  })

  it('reset() returns to idle and fires subscribers when prior state was non-idle', () => {
    setMpStatus({ state: 'connected', roomId: 'R1', latencyMs: 32 })
    const fn = vi.fn()
    onMpStatusChange(fn)
    resetMpStatus()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(getMpStatus().state).toBe('idle')
    expect(getMpStatus().roomId).toBeNull()
    expect(getMpStatus().latencyMs).toBe(-1)
  })

  it('reset() is a no-op when already idle (does not spam subscribers)', () => {
    const fn = vi.fn()
    onMpStatusChange(fn)
    resetMpStatus()
    expect(fn).not.toHaveBeenCalled()
  })
})
