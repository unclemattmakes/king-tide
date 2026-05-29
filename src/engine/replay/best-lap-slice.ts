/**
 * Best-lap extraction for Time Trial ghosts.
 *
 * Given a full-race ReplayFile, find the player's (slot 0) fastest lap
 * from the recorded `lap` events and emit a new single-bike, single-lap
 * ReplayFile with frame timestamps rebased to start at 0. The result is
 * what the live-race ghost runner replays each lap.
 *
 * Looping a single best lap (vs. the full race) is the Wave Race /
 * F-Zero convention — players race their fastest lap on every lap, so
 * any lap improvement is immediately visible. Storing one lap also
 * keeps localStorage payloads small (~30 KB vs ~150 KB for a 3-lap
 * recording).
 */

import { REPLAY_FLOATS_PER_BIKE, REPLAY_VERSION, type ReplayFile, type ReplayFrame } from './format'

export type BestLapSlice = {
  /** Single-bike, single-lap replay file. Frames rebased to t=0. */
  replay: ReplayFile
  /** The best lap's duration in seconds (= `replay.meta.bestLap`). */
  bestLap: number
  /** Which lap number (1-indexed) was fastest in the source race. */
  sourceLap: number
}

export function sliceBestLap(source: ReplayFile, playerSlot = 0): BestLapSlice | null {
  if (source.frames.length < 2) return null
  if (playerSlot < 0 || playerSlot >= source.bikes.length) return null

  // Find the fastest 'lap' event for the player. The recorder records
  // each cp-0 crossing after the first as a 'lap' event with `t` at the
  // recorder-relative time of the crossing and `lapTime` = duration.
  let best: { lap: number; tEnd: number; tStart: number; lapTime: number } | null = null
  for (const ev of source.events) {
    if (ev.kind !== 'lap') continue
    if (ev.slot !== playerSlot) continue
    if (!Number.isFinite(ev.lapTime) || ev.lapTime <= 0) continue
    const tStart = ev.t - ev.lapTime
    if (tStart < 0) continue
    if (best === null || ev.lapTime < best.lapTime) {
      best = { lap: ev.lap, tEnd: ev.t, tStart, lapTime: ev.lapTime }
    }
  }
  if (best === null) return null

  // Slice frames in [tStart, tEnd] for the player slot only. Always
  // include one frame on each side of the window so SLERP doesn't run
  // off the end during boundary samples.
  const window: ReplayFrame[] = []
  for (let i = 0; i < source.frames.length; i++) {
    const f = source.frames[i] as ReplayFrame
    if (f.t < best.tStart) continue
    if (f.t > best.tEnd) break
    const offset = playerSlot * REPLAY_FLOATS_PER_BIKE
    const slotFloats = f.bikes.slice(offset, offset + REPLAY_FLOATS_PER_BIKE)
    if (slotFloats.length !== REPLAY_FLOATS_PER_BIKE) continue
    window.push({ t: f.t - best.tStart, bikes: slotFloats })
  }
  if (window.length < 2) return null

  const sourceBike = source.bikes[playerSlot]
  if (!sourceBike) return null

  const replay: ReplayFile = {
    version: REPLAY_VERSION,
    meta: {
      trackId: source.meta.trackId,
      trackName: source.meta.trackName,
      recordedAt: source.meta.recordedAt,
      durationSeconds: window[window.length - 1]!.t,
      finishPosition: null,
      finishTime: null,
      bestLap: best.lapTime,
    },
    bikes: [{ ...sourceBike, slot: 0, isPlayer: true }],
    sampleRateHz: source.sampleRateHz,
    frames: window,
    events: [],
    // Best-lap slice is for the ghost runner, which only reads
    // transforms — combat tracks would just bloat the file. Always
    // emit empty arrays so the slice round-trips cleanly through the
    // v2 parser regardless of source version.
    missiles: [],
    explosions: [],
    isLegacyV1: source.isLegacyV1,
  }
  return { replay, bestLap: best.lapTime, sourceLap: best.lap }
}
