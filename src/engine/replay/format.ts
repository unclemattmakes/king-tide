/**
 * Replay file format. JSON-serialised, downloadable as `.replay`.
 *
 * Stores per-bike transforms (position + rotation quaternion) sampled at a
 * fixed rate during a race. Playback re-spawns bikes on the same track and
 * drives their transforms from the snapshots — physics + intent + AI are
 * bypassed entirely, so a replay is decoupled from rapier non-determinism
 * and from any future tuning changes to the bike feel.
 *
 * Frame layout: a flat number[] of `bikeCount * 7` floats per frame
 * (px, py, pz, qx, qy, qz, qw, repeated per slot). Flat to keep the JSON
 * compact — a 90s race × 30Hz × 5 bikes × 7 floats × 8 bytes ≈ 750 KB raw,
 * down to ~250 KB JSON-stringified after numeric rounding.
 */

export const REPLAY_VERSION = 1
export const REPLAY_SAMPLE_RATE_HZ = 30
export const REPLAY_FLOATS_PER_BIKE = 7

export type ReplayBike = {
  /** Slot index — matches the position of this bike's 7-float window in
   *  every frame's `bikes` array. Slot 0 is by convention the recorded
   *  player. */
  slot: number
  isPlayer: boolean
  /** Bike variant id (matches `BIKE_VARIANTS`). */
  variantId: string
  displayName: string
  bodyColor: number
}

export type ReplayFrame = {
  /** Seconds since recording start. */
  t: number
  /** Flat array, length === bikes.length * REPLAY_FLOATS_PER_BIKE. */
  bikes: number[]
}

export type ReplayEvent =
  | { t: number; kind: 'lap'; slot: number; lap: number; lapTime: number }
  | { t: number; kind: 'finish'; slot: number; finishTime: number }
  | { t: number; kind: 'checkpoint'; slot: number; cpIndex: number }

export type ReplayFile = {
  version: number
  meta: {
    trackId: string
    trackName: string
    /** ISO-8601 timestamp from the recording session. */
    recordedAt: string
    /** Total recorded duration, seconds. */
    durationSeconds: number
    /** Player's finish position (1 = first), or null if the player did not finish. */
    finishPosition: number | null
    /** Player's finish time in seconds, or null. */
    finishTime: number | null
    /** Player's best lap time during this race, in seconds (or null if no lap completed). */
    bestLap: number | null
  }
  bikes: ReplayBike[]
  sampleRateHz: number
  frames: ReplayFrame[]
  events: ReplayEvent[]
}

export function serializeReplay(r: ReplayFile): string {
  return JSON.stringify(r)
}

export class ReplayParseError extends Error {}

export function parseReplay(text: string): ReplayFile {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch (err) {
    throw new ReplayParseError(`replay: invalid JSON — ${(err as Error).message}`)
  }
  if (typeof obj !== 'object' || obj === null) {
    throw new ReplayParseError('replay: not a JSON object')
  }
  const r = obj as Partial<ReplayFile>
  if (r.version !== REPLAY_VERSION) {
    throw new ReplayParseError(
      `replay: unsupported version ${r.version} (expected ${REPLAY_VERSION})`,
    )
  }
  if (!r.meta || typeof r.meta.trackId !== 'string') {
    throw new ReplayParseError('replay: missing meta.trackId')
  }
  if (!Array.isArray(r.bikes) || r.bikes.length === 0) {
    throw new ReplayParseError('replay: missing or empty bikes')
  }
  if (!Array.isArray(r.frames)) {
    throw new ReplayParseError('replay: missing frames')
  }
  if (typeof r.sampleRateHz !== 'number' || r.sampleRateHz <= 0) {
    throw new ReplayParseError('replay: invalid sampleRateHz')
  }
  const expectedLen = r.bikes.length * REPLAY_FLOATS_PER_BIKE
  for (let i = 0; i < r.frames.length; i++) {
    const f = r.frames[i]!
    if (typeof f.t !== 'number' || !Array.isArray(f.bikes) || f.bikes.length !== expectedLen) {
      throw new ReplayParseError(
        `replay: frame ${i} has ${f.bikes?.length ?? '?'} floats, expected ${expectedLen}`,
      )
    }
  }
  if (!Array.isArray(r.events)) {
    // Tolerate missing events list — older recordings might omit it.
    r.events = []
  }
  return r as ReplayFile
}

/** Round a number to 4 decimals (~0.1mm precision) for compact JSON output. */
export function quantize(n: number): number {
  return Math.round(n * 10000) / 10000
}
