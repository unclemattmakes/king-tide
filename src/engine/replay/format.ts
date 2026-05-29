/**
 * Replay file format. JSON-serialised, downloadable as `.replay`.
 *
 * Stores per-bike state sampled at a fixed rate during a race, plus
 * lifecycle tracks for combat entities (missiles, explosions). Playback
 * re-spawns bikes on the same track and drives their transforms +
 * synthesised input state from the snapshots; combat entities are
 * re-spawned along their recorded tracks. Physics + AI are bypassed
 * entirely, so a replay is decoupled from rapier non-determinism and
 * from any future tuning changes to the bike feel.
 *
 * Frame layout (v2): a flat number[] of `bikeCount * 12` floats per
 * frame:
 *   0..6   px, py, pz, qx, qy, qz, qw  — pose (same as v1)
 *   7      pitch         — intent.pitch (-1..1)
 *   8      throttle      — intent.throttle (-1..1)
 *   9      boost         — intent.boost (0 or 1)
 *   10     driftDir      — DriftState.driftDir (-1, 0, 1)
 *   11     driftTier     — DriftState.highestTier (0..3)
 *
 * v1 (legacy) layout used 7 floats per bike (pose only). The parser
 * tolerates v1 by classifying everything past pose 7 as "unknown
 * input"; the live race recorder always writes v2.
 *
 * Why state in the file at all: the render-side FX system reads input
 * state (boost, drift tier, pitch) to gate drift sparks, tuck
 * slipstream, and the boost-blossom exhaust. Without recording it the
 * playback path has nothing to drive those effects from.
 */

export const REPLAY_VERSION = 2
export const REPLAY_SAMPLE_RATE_HZ = 30
/** v2: pose (7) + pitch + throttle + boost + driftDir + driftTier. */
export const REPLAY_FLOATS_PER_BIKE = 12
/** v1 floats-per-bike — kept so the parser can still read old files. */
export const REPLAY_FLOATS_PER_BIKE_V1 = 7

export type ReplayBike = {
  /** Slot index — matches the position of this bike's float window in
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
  /** Flat array, length === bikes.length * REPLAY_FLOATS_PER_BIKE
   *  (or `_V1` for legacy files). */
  bikes: number[]
}

export type ReplayEvent =
  | { t: number; kind: 'lap'; slot: number; lap: number; lapTime: number }
  | { t: number; kind: 'finish'; slot: number; finishTime: number }
  | { t: number; kind: 'checkpoint'; slot: number; cpIndex: number }

/**
 * Per-missile lifecycle track. Captures the missile's path from spawn
 * to either detonation or expiry, sampled at the same fixed cadence as
 * bike frames so the replay-side combat driver can interpolate
 * position + velocity for the FX trail.
 *
 * `samples` is a flat array of 7-float windows: (t, px, py, pz, vx, vy, vz)
 * per sample, with `t` measured the same way as `ReplayFrame.t`.
 */
export type ReplayMissileTrack = {
  /** Track id — unique within this replay, not tied to any sim eid. */
  id: number
  spawnT: number
  /** Track-time of the last sample (detonation or expiry). */
  endT: number
  /** True if the missile detonated (vs. timed out). Drives the matching
   *  `ReplayExplosion` lookup at endT — see combat-replay-driver. */
  detonated: boolean
  /** Detonation point (if detonated), else null. */
  detonatedAt: [number, number, number] | null
  /** Sample windows: 7 floats per window — t, px, py, pz, vx, vy, vz. */
  samples: number[]
}

/**
 * One-shot explosion burst. Drives both the render-side explosion mesh
 * (combat-render.ts) and the FX particle burst (fx/index.ts) — replay
 * re-spawns an `ExplosionTag` ECS entity at the recorded time/position
 * and the existing systems take it from there.
 */
export type ReplayExplosion = {
  t: number
  x: number
  y: number
  z: number
  /** Colour tint passed through to `createExplosion(...)`. Distinguishes
   *  mine vs missile vs shield-block bursts. */
  color: number
  lifetime: number
}

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
  /** v2+ — missile lifecycle tracks. Empty for v1 files (combat VFX
   *  won't replay) and for races where no missile was fired. */
  missiles: ReplayMissileTrack[]
  /** v2+ — explosion bursts (missile / mine / shield-block detonations). */
  explosions: ReplayExplosion[]
  /** True when the file was loaded from a v1 recording. Lets the
   *  replay state reconstructor fall back to heuristics for the
   *  per-bike inputs that v1 never captured. */
  isLegacyV1: boolean
}

export function serializeReplay(r: ReplayFile): string {
  // `isLegacyV1` is a runtime hint — never written to disk. Always
  // serialise as the current version with whatever state we have.
  const { isLegacyV1: _legacy, ...rest } = r
  return JSON.stringify({ ...rest, version: REPLAY_VERSION })
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
  // Accept v1 (pose-only) and v2 (state + combat). Other versions are
  // unsupported.
  if (r.version !== REPLAY_VERSION && r.version !== 1) {
    throw new ReplayParseError(
      `replay: unsupported version ${r.version} (expected 1 or ${REPLAY_VERSION})`,
    )
  }
  const isLegacyV1 = r.version === 1
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
  const expectedLen =
    r.bikes.length * (isLegacyV1 ? REPLAY_FLOATS_PER_BIKE_V1 : REPLAY_FLOATS_PER_BIKE)
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
  if (!Array.isArray(r.missiles)) r.missiles = []
  if (!Array.isArray(r.explosions)) r.explosions = []
  r.isLegacyV1 = isLegacyV1
  return r as ReplayFile
}

/** Round a number to 4 decimals (~0.1mm precision) for compact JSON output. */
export function quantize(n: number): number {
  return Math.round(n * 10000) / 10000
}
