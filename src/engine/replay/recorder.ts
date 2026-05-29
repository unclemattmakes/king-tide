import {
  quantize,
  REPLAY_FLOATS_PER_BIKE,
  REPLAY_SAMPLE_RATE_HZ,
  REPLAY_VERSION,
  type ReplayBike,
  type ReplayEvent,
  type ReplayExplosion,
  type ReplayFile,
  type ReplayFrame,
  type ReplayMissileTrack,
} from './format'

/**
 * Records a race for later playback. The caller drives sampling each frame
 * by calling `sample(elapsedSeconds)` — the recorder decides whether to
 * push a frame based on the configured sample rate.
 *
 * The bike slots are fixed at construction time; subsequent samples must
 * supply the same number of bikes in the same order.
 *
 * v2 also records combat: caller pushes a `MissileSnapshot[]` each frame
 * (callbacks `sampleMissiles` + `markMissileDetonated`) and a one-shot
 * `recordExplosion(...)` at the moment a mine / missile / shield-block
 * detonates. The replay-side combat driver re-spawns ECS entities from
 * those tracks so the render + FX systems light up automatically.
 */
export type ReplayRecorder = {
  /** Slot order this recorder is bound to. Order matters — every sample
   *  is expected in the same slot order. */
  bikes: readonly ReplayBike[]
  /** Whether to capture frames. Pause recording (e.g. for the pre-race
   *  countdown) by toggling this off. */
  enabled: boolean
  /**
   * Push a sample at `elapsedSeconds` since recording start. `flatTransforms`
   * length must equal bikes.length * REPLAY_FLOATS_PER_BIKE. The recorder rate-limits to
   * `sampleRateHz` — calls in between are discarded.
   */
  sample(elapsedSeconds: number, flatTransforms: ArrayLike<number>): void
  /**
   * True if `sample(elapsedSeconds, ...)` would actually capture a frame.
   * Lets the caller short-circuit any per-frame work needed to assemble the
   * transform buffer (e.g. WASM-bound rigid-body reads) on frames the
   * recorder will discard. Pure read — does not advance the rate-limit
   * cursor.
   */
  shouldSample(elapsedSeconds: number): boolean
  /** Record a one-off event (lap / finish / checkpoint). */
  recordEvent(ev: ReplayEvent): void
  /**
   * Push live missile snapshots at the same cadence as bike frames. Each
   * snapshot has a stable `simEid` identifying which missile it belongs
   * to; the recorder aggregates per-id streams into `ReplayMissileTrack`
   * entries at `finalize()` time.
   *
   * Skipped (no-op) on frames where `shouldSample` is false, so the
   * sample cadence stays consistent with bikes.
   */
  sampleMissiles(elapsedSeconds: number, snapshots: readonly MissileSnapshot[]): void
  /** Mark a missile track as detonated at the given world position. The
   *  matching explosion is expected to be pushed via `recordExplosion`
   *  in the same frame. */
  markMissileDetonated(
    simEid: number,
    t: number,
    position: { x: number; y: number; z: number },
  ): void
  /** Record an explosion burst. Drives the replay-side ECS entity that
   *  re-fires the FX particle burst + the render-side mesh. */
  recordExplosion(burst: ReplayExplosion): void
  /** Build a ReplayFile from the captured data. */
  finalize(meta: {
    finishPosition: number | null
    finishTime: number | null
    bestLap: number | null
  }): ReplayFile
  /** Seconds elapsed at the most recent captured frame, or 0. */
  durationSeconds(): number
  /** Number of frames captured so far. */
  frameCount(): number
}

/**
 * Per-frame state for a live missile, pushed via `sampleMissiles`. The
 * recorder uses `simEid` only as a track-identity key — the on-disk
 * `ReplayMissileTrack.id` is reassigned to a dense range at finalize so
 * playback can iterate tracks without dealing with sparse ECS ids.
 */
export type MissileSnapshot = {
  simEid: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
}

export type CreateReplayRecorderOpts = {
  trackId: string
  trackName: string
  bikes: ReplayBike[]
  /** Defaults to REPLAY_SAMPLE_RATE_HZ. Lower for longer races, higher for
   *  smoother playback at the cost of file size. */
  sampleRateHz?: number
}

type MissileWip = {
  spawnT: number
  endT: number
  detonated: boolean
  detonatedAt: [number, number, number] | null
  samples: number[]
}

export function createReplayRecorder(opts: CreateReplayRecorderOpts): ReplayRecorder {
  const sampleRateHz = opts.sampleRateHz ?? REPLAY_SAMPLE_RATE_HZ
  const sampleInterval = 1 / sampleRateHz
  const expectedFloats = opts.bikes.length * REPLAY_FLOATS_PER_BIKE

  const frames: ReplayFrame[] = []
  const events: ReplayEvent[] = []
  // Keyed by the live sim eid so successive snapshots for the same
  // missile append to the same track. Cleared into the dense `missiles`
  // list at finalize.
  const missileWips = new Map<number, MissileWip>()
  const explosions: ReplayExplosion[] = []
  let nextSampleAt = 0
  let lastSampleT = 0

  return {
    bikes: opts.bikes,
    enabled: true,
    shouldSample(elapsedSeconds) {
      if (!this.enabled) return false
      return elapsedSeconds >= nextSampleAt
    },
    sample(elapsedSeconds, flatTransforms) {
      if (!this.enabled) return
      if (elapsedSeconds < nextSampleAt) return
      if (flatTransforms.length !== expectedFloats) {
        throw new Error(
          `replay-recorder: expected ${expectedFloats} floats, got ${flatTransforms.length}`,
        )
      }
      const bikes: number[] = new Array(expectedFloats)
      for (let i = 0; i < expectedFloats; i++) {
        bikes[i] = quantize(flatTransforms[i] ?? 0)
      }
      frames.push({ t: quantize(elapsedSeconds), bikes })
      lastSampleT = elapsedSeconds
      // Anchor next sample to the grid so the spacing stays close to the
      // requested rate even if a frame ran long.
      nextSampleAt = Math.max(elapsedSeconds + sampleInterval * 0.5, nextSampleAt + sampleInterval)
    },
    sampleMissiles(elapsedSeconds, snapshots) {
      if (!this.enabled) return
      // Piggy-back on the just-pushed bike frame's gridded timestamp so
      // missile samples line up with bike samples one-for-one.
      const t = quantize(elapsedSeconds)
      for (const s of snapshots) {
        let wip = missileWips.get(s.simEid)
        if (!wip) {
          wip = {
            spawnT: t,
            endT: t,
            detonated: false,
            detonatedAt: null,
            samples: [],
          }
          missileWips.set(s.simEid, wip)
        }
        wip.endT = t
        wip.samples.push(
          t,
          quantize(s.x),
          quantize(s.y),
          quantize(s.z),
          quantize(s.vx),
          quantize(s.vy),
          quantize(s.vz),
        )
      }
    },
    markMissileDetonated(simEid, t, position) {
      const wip = missileWips.get(simEid)
      if (!wip) return
      wip.detonated = true
      wip.detonatedAt = [quantize(position.x), quantize(position.y), quantize(position.z)]
      wip.endT = quantize(t)
    },
    recordExplosion(burst) {
      explosions.push({
        t: quantize(burst.t),
        x: quantize(burst.x),
        y: quantize(burst.y),
        z: quantize(burst.z),
        color: burst.color,
        lifetime: burst.lifetime,
      })
    },
    recordEvent(ev) {
      events.push(ev)
    },
    finalize(meta) {
      // Reassign missile ids to a dense 0..n range so playback can
      // iterate without caring about the original sparse ECS eids.
      const missiles: ReplayMissileTrack[] = []
      let nextId = 0
      for (const wip of missileWips.values()) {
        missiles.push({
          id: nextId++,
          spawnT: wip.spawnT,
          endT: wip.endT,
          detonated: wip.detonated,
          detonatedAt: wip.detonatedAt,
          samples: wip.samples,
        })
      }
      missiles.sort((a, b) => a.spawnT - b.spawnT)
      return {
        version: REPLAY_VERSION,
        meta: {
          trackId: opts.trackId,
          trackName: opts.trackName,
          recordedAt: new Date().toISOString(),
          durationSeconds: lastSampleT,
          finishPosition: meta.finishPosition,
          finishTime: meta.finishTime,
          bestLap: meta.bestLap,
        },
        bikes: opts.bikes,
        sampleRateHz,
        frames,
        events,
        missiles,
        explosions,
        isLegacyV1: false,
      }
    },
    durationSeconds() {
      return lastSampleT
    },
    frameCount() {
      return frames.length
    },
  }
}
