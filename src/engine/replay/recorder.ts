import {
  quantize,
  REPLAY_FLOATS_PER_BIKE,
  REPLAY_SAMPLE_RATE_HZ,
  REPLAY_VERSION,
  type ReplayBike,
  type ReplayEvent,
  type ReplayFile,
  type ReplayFrame,
} from './format'

/**
 * Records a race for later playback. The caller drives sampling each frame
 * by calling `sample(elapsedSeconds)` — the recorder decides whether to
 * push a frame based on the configured sample rate.
 *
 * The bike slots are fixed at construction time; subsequent samples must
 * supply the same number of bikes in the same order.
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
   * length must equal bikes.length * 7. The recorder rate-limits to
   * `sampleRateHz` — calls in between are discarded.
   */
  sample(elapsedSeconds: number, flatTransforms: ArrayLike<number>): void
  /** Record a one-off event (lap / finish / checkpoint). */
  recordEvent(ev: ReplayEvent): void
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

export type CreateReplayRecorderOpts = {
  trackId: string
  trackName: string
  bikes: ReplayBike[]
  /** Defaults to REPLAY_SAMPLE_RATE_HZ. Lower for longer races, higher for
   *  smoother playback at the cost of file size. */
  sampleRateHz?: number
}

export function createReplayRecorder(opts: CreateReplayRecorderOpts): ReplayRecorder {
  const sampleRateHz = opts.sampleRateHz ?? REPLAY_SAMPLE_RATE_HZ
  const sampleInterval = 1 / sampleRateHz
  const expectedFloats = opts.bikes.length * REPLAY_FLOATS_PER_BIKE

  const frames: ReplayFrame[] = []
  const events: ReplayEvent[] = []
  let nextSampleAt = 0
  let lastSampleT = 0

  return {
    bikes: opts.bikes,
    enabled: true,
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
    recordEvent(ev) {
      events.push(ev)
    },
    finalize(meta) {
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
