/**
 * Live multiplayer status — small read-only view consumed by the
 * Settings → Network tab, the lobby overlay, and the in-race HUD chip.
 *
 * The room's owner (boot/multiplayer.ts for the live race, mp-lobby.ts
 * for the lobby) publishes here whenever its connection state changes.
 * The Settings overlay reads via `getMpStatus()` and subscribes via
 * `onMpStatusChange()` so the live readout refreshes without a
 * settings-overlay re-render.
 *
 * This module is the *only* shared mutable state between the netcode
 * layer and the player-facing UI; everything else flows one-way (UI →
 * settings, settings → engine).
 */

export type MpConnectionState =
  /** Single-player — no `?room=` was set on the URL. The Settings →
   *  Network tab uses this to flip into an "OFFLINE — START FROM MENU"
   *  hint instead of trying to show a live latency readout. */
  | 'idle'
  /** Socket is opening for the first time. */
  | 'connecting'
  /** Socket was open at least once and is currently re-establishing. */
  | 'reconnecting'
  /** Socket is open, server hello received, we have a peer slot. */
  | 'connected'
  /** Socket explicitly closed (room-full, navigated away). No retry
   *  pending. */
  | 'closed'

export type MpStatus = {
  state: MpConnectionState
  /** `?room=<id>` we're connecting to, or null when idle. */
  roomId: string | null
  /** PartyKit host the client is targeting (dev = localhost:1999, prod =
   *  the deployed worker). */
  host: string | null
  /** Our peer slot post-hello, or -1 before/after disconnect. */
  peerId: number
  /** Number of remote peers currently in the room (excludes us). */
  remoteCount: number
  /** Smoothed RTT in ms, or -1 if not yet measured / stale. */
  latencyMs: number
  /** True when this peer is currently the AI host (lowest slot). */
  isHost: boolean
}

const INITIAL: MpStatus = {
  state: 'idle',
  roomId: null,
  host: null,
  peerId: -1,
  remoteCount: 0,
  latencyMs: -1,
  isHost: false,
}

let current: MpStatus = { ...INITIAL }
const listeners = new Set<(s: MpStatus) => void>()

export function getMpStatus(): Readonly<MpStatus> {
  return current
}

/** Patch the live status. Only the fields supplied are updated; the
 *  rest carry over. Notifies subscribers iff something actually changed
 *  so a per-frame caller (the snapshot pump) can call this freely
 *  without thrashing listeners. Explicit `undefined` is treated as
 *  "don't touch this field" — matches how callers build a sparse patch. */
export type MpStatusPatch = { [K in keyof MpStatus]?: MpStatus[K] | undefined }

export function setMpStatus(patch: MpStatusPatch): void {
  let changed = false
  const next: MpStatus = { ...current }
  for (const k of Object.keys(patch) as (keyof MpStatus)[]) {
    const v = patch[k]
    if (v === undefined) continue
    if (next[k] !== v) {
      changed = true
      ;(next as Record<string, unknown>)[k] = v
    }
  }
  if (!changed) return
  current = next
  for (const fn of listeners) fn(current)
}

/** Reset to single-player defaults. Called when the room is torn down
 *  (e.g. pre-race-exit, or test cleanup). */
export function resetMpStatus(): void {
  if (current.state === 'idle' && current.roomId === null) return
  current = { ...INITIAL }
  for (const fn of listeners) fn(current)
}

export function onMpStatusChange(fn: (s: MpStatus) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
