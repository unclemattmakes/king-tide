/**
 * Jitter telemetry.
 *
 * "The bike looks jittery but the camera is smooth" is the classic
 * signature of a fixed-timestep simulation being *sampled* by a
 * variable-rate render loop without interpolation. The sim advances in
 * discrete 1/60 s steps; the render frame can fire 0, 1, or 2+ steps
 * worth of time apart from the last commit, so the rendered body holds
 * still for a frame and then lurches a double-step. The chase camera
 * hides this because it runs every rendered frame through an exponential
 * low-pass (`camera.position.lerp`, see render/camera.ts) — so the
 * camera glides over the same quantised signal the bike snaps to.
 *
 * This module turns that hypothesis into numbers. It records two streams:
 *
 *  - per **sim tick** (inside the fixed-step accumulator loop): the player
 *    body's position, from which we derive the *sim* motion smoothness
 *    (second-difference "jerk") and a vertical-reversal rate (hover-spring
 *    ringing detector). This is the ground-truth motion the physics
 *    actually produced.
 *  - per **render frame** (after the accumulator loop drains): how many
 *    sim steps ran that frame, the leftover accumulator fraction
 *    (`physAccum / fixedDt` — the interpolation alpha we currently throw
 *    away), and the player body's *rendered* position, from which we
 *    derive the on-screen smoothness.
 *
 * Comparing the two answers the diagnostic question:
 *  - render cadence ragged (many 0-step / ≥2-step frames) + render jerk
 *    ≫ sim jerk  ⇒  pure render-sampling stutter; fix with render
 *    interpolation (lerp/slerp by the discarded alpha).
 *  - sim jerk / vertical-reversal rate high even at a steady 1-step
 *    cadence  ⇒  the body genuinely oscillates each tick (hover PD
 *    ringing); interpolation only masks it — tune the spring.
 *
 * Three-free + DOM-free on purpose, so it's trivially unit-testable with
 * synthetic position streams. Driven from `src/boot/game-loop.ts` only
 * when `?jitter=1` is set, so it costs nothing in normal play.
 */

/** Slots in the steps-per-frame histogram. Index = step count; the last
 *  slot is a `>= STEPS_HISTOGRAM_MAX` overflow bucket. */
export const STEPS_HISTOGRAM_MAX = 6

/** Vertical position delta (metres) below which a tick is treated as
 *  "not moving vertically" — keeps float noise from inflating the
 *  hover-ringing reversal count. 0.1 mm. */
const VERT_DEADBAND_M = 1e-4

/** Vertical reversals/sec above which we call the body's own motion
 *  oscillatory (hover-spring ringing) rather than smooth. A bike settling
 *  onto a wave crosses zero vertical velocity a couple of times; sustained
 *  ringing flips many times a second. */
const VERT_REVERSAL_WARN_PER_SEC = 8

/** Fraction of frames running other-than-one sim step above which the
 *  render/sim cadence counts as ragged. Note this is INHERENT to a fixed
 *  step sampled by a variable render loop — it stays true even after render
 *  interpolation hides it, so on its own it isn't a defect (see
 *  RENDER_VS_SIM_WARN). */
const OFF_CADENCE_WARN_FRAC = 0.1

/** How many times rougher the rendered path may be than the underlying sim
 *  path before we call it a render-sampling artifact. With interpolation the
 *  rendered path tracks the sim (ratio ≈ 1); snapping to the latest tick
 *  makes it stair-step, spiking the rendered second-difference well above
 *  the sim's. This ratio — not the raw cadence — is what distinguishes
 *  "jittery on screen" from "ragged cadence that interpolation absorbs". */
const RENDER_VS_SIM_WARN = 2

/** Minimum frames before `summary()` will venture a verdict. */
const MIN_FRAMES_FOR_VERDICT = 30

export interface JitterSummary {
  /** Render frames recorded in this window. */
  frames: number
  /** Sim ticks recorded in this window. */
  ticks: number
  /** Wall-clock span of the recorded frames (ms), summed from frame deltas. */
  durationMs: number
  /** Mean render rate over the window (Hz). */
  renderHz: number
  /** Fixed sim rate (Hz) — 1000 / fixedDtMs. */
  simHz: number
  /** Mean render frame time (ms). */
  meanFrameMs: number
  /** Steps-per-frame histogram. Index = step count, value = frame count;
   *  the final slot aggregates `>= STEPS_HISTOGRAM_MAX`. */
  stepsHistogram: number[]
  /** Mean sim steps advanced per render frame. ≈ simHz / renderHz. */
  meanStepsPerFrame: number
  /** Fraction of frames that advanced **zero** sim steps — the bike was
   *  frozen in place that frame. */
  zeroStepFrac: number
  /** Fraction of frames that advanced **two or more** sim steps — the
   *  bike teleported a multi-step jump that frame. */
  multiStepFrac: number
  /** Mean leftover accumulator fraction at render time (`physAccum /
   *  fixedDt`). This is exactly the interpolation alpha a fix would use —
   *  today it's discarded, so the bike renders on average this far behind
   *  the next sim state. */
  meanAlpha: number
  /** Mean magnitude of the second difference of the *rendered* player
   *  position, per frame (metres). On-screen smoothness proxy — high =
   *  visible jitter. */
  renderJerkMean: number
  /** Worst-case rendered second-difference magnitude in the window (m). */
  renderJerkMax: number
  /** Mean magnitude of the second difference of the *sim* (per-tick)
   *  player position (metres). Ground-truth motion smoothness. */
  simJerkMean: number
  /** Worst-case sim second-difference magnitude in the window (m). */
  simJerkMax: number
  /** Vertical-velocity sign reversals per second across sim ticks — a
   *  hover-spring ringing detector. */
  vertReversalsPerSec: number
  /** Human-readable interpretation of the above. */
  verdict: string
}

export interface JitterTelemetry {
  /** Record the player body's position at a single fixed sim step. Call
   *  once per `phys.step()` inside the accumulator loop. */
  recordTick(x: number, y: number, z: number): void
  /** Record one render frame: its delta (ms), how many sim steps ran this
   *  frame, the leftover alpha (`physAccum / fixedDt`), and the player
   *  body's rendered position. Call once per rAF frame, after the
   *  accumulator loop. */
  recordFrame(frameMs: number, steps: number, alpha: number, x: number, y: number, z: number): void
  /** Derive a summary over everything recorded since construction / reset. */
  summary(): JitterSummary
  /** Wipe all accumulators back to empty. */
  reset(): void
}

export function createJitterTelemetry(fixedDtMs: number = (1 / 60) * 1000): JitterTelemetry {
  const simHz = fixedDtMs > 0 ? 1000 / fixedDtMs : 0

  // --- per-frame accumulators ---
  let frames = 0
  let frameMsSum = 0
  let stepsSum = 0
  let zeroStepFrames = 0
  let multiStepFrames = 0
  let alphaSum = 0
  const stepsHistogram = new Array<number>(STEPS_HISTOGRAM_MAX + 1).fill(0)
  // Last two rendered positions, for the second-difference jerk.
  let rPrevX = 0
  let rPrevY = 0
  let rPrevZ = 0
  let rPrev2X = 0
  let rPrev2Y = 0
  let rPrev2Z = 0
  let renderSamples = 0 // rendered positions seen (jerk needs >= 3)
  let renderJerkSum = 0
  let renderJerkMax = 0
  let renderJerkCount = 0

  // --- per-tick accumulators ---
  let ticks = 0
  let tPrevX = 0
  let tPrevY = 0
  let tPrevZ = 0
  let tPrev2X = 0
  let tPrev2Y = 0
  let tPrev2Z = 0
  let tickSamples = 0
  let simJerkSum = 0
  let simJerkMax = 0
  let simJerkCount = 0
  // Vertical-reversal tracking: sign of the last non-deadband Δy.
  let lastVertSign = 0
  let vertReversals = 0

  function recordTick(x: number, y: number, z: number): void {
    ticks += 1
    if (tickSamples >= 1) {
      // Vertical reversal: compare the sign of this Δy against the last.
      const dy = y - tPrevY
      if (Math.abs(dy) >= VERT_DEADBAND_M) {
        const sign = dy > 0 ? 1 : -1
        if (lastVertSign !== 0 && sign !== lastVertSign) vertReversals += 1
        lastVertSign = sign
      }
    }
    if (tickSamples >= 2) {
      // Second difference: p(k) - 2 p(k-1) + p(k-2).
      const jx = x - 2 * tPrevX + tPrev2X
      const jy = y - 2 * tPrevY + tPrev2Y
      const jz = z - 2 * tPrevZ + tPrev2Z
      const j = Math.sqrt(jx * jx + jy * jy + jz * jz)
      simJerkSum += j
      simJerkCount += 1
      if (j > simJerkMax) simJerkMax = j
    }
    tPrev2X = tPrevX
    tPrev2Y = tPrevY
    tPrev2Z = tPrevZ
    tPrevX = x
    tPrevY = y
    tPrevZ = z
    tickSamples += 1
  }

  function recordFrame(
    frameMs: number,
    steps: number,
    alpha: number,
    x: number,
    y: number,
    z: number,
  ): void {
    frames += 1
    frameMsSum += frameMs
    stepsSum += steps
    alphaSum += alpha
    const bucket = steps < 0 ? 0 : steps > STEPS_HISTOGRAM_MAX ? STEPS_HISTOGRAM_MAX : steps
    stepsHistogram[bucket] = (stepsHistogram[bucket] ?? 0) + 1
    if (steps === 0) zeroStepFrames += 1
    else if (steps >= 2) multiStepFrames += 1

    if (renderSamples >= 2) {
      const jx = x - 2 * rPrevX + rPrev2X
      const jy = y - 2 * rPrevY + rPrev2Y
      const jz = z - 2 * rPrevZ + rPrev2Z
      const j = Math.sqrt(jx * jx + jy * jy + jz * jz)
      renderJerkSum += j
      renderJerkCount += 1
      if (j > renderJerkMax) renderJerkMax = j
    }
    rPrev2X = rPrevX
    rPrev2Y = rPrevY
    rPrev2Z = rPrevZ
    rPrevX = x
    rPrevY = y
    rPrevZ = z
    renderSamples += 1
  }

  function buildVerdict(s: Omit<JitterSummary, 'verdict'>): string {
    if (s.frames < MIN_FRAMES_FOR_VERDICT) {
      return `Collecting… (${s.frames}/${MIN_FRAMES_FOR_VERDICT} frames). Keep racing for a verdict.`
    }
    const offCadence = s.zeroStepFrac + s.multiStepFrac
    const ragged = offCadence > OFF_CADENCE_WARN_FRAC
    // How much rougher is the rendered path than the underlying sim path?
    // ≈1 means the render tracks the sim (interpolated or rate-matched);
    // ≫1 means the render stair-steps a smooth sim (a sampling artifact).
    const samplingRatio =
      s.simJerkMean > 1e-9
        ? s.renderJerkMean / s.simJerkMean
        : s.renderJerkMean > 1e-9
          ? Number.POSITIVE_INFINITY
          : 1
    const parts: string[] = []
    if (ragged && samplingRatio > RENDER_VS_SIM_WARN) {
      const ratioStr = Number.isFinite(samplingRatio) ? `${samplingRatio.toFixed(1)}×` : 'far'
      parts.push(
        `Render-sampling stutter: ${(offCadence * 100).toFixed(0)}% of frames ran other than one sim ` +
          `step (${(s.zeroStepFrac * 100).toFixed(0)}% froze, ${(s.multiStepFrac * 100).toFixed(0)}% ` +
          `double-stepped) and the rendered path is ${ratioStr} rougher than the sim, with ` +
          `${(s.meanAlpha * 100).toFixed(0)}% of a step discarded each frame instead of interpolated. ` +
          `This is the dominant jitter source — apply render interpolation (lerp/slerp by alpha).`,
      )
    } else if (ragged) {
      parts.push(
        `Render/sim cadence is ragged (${(offCadence * 100).toFixed(0)}% off-cadence frames) — inherent ` +
          `to the fixed ${s.simHz.toFixed(0)} Hz step — but the rendered path tracks the sim ` +
          `(${samplingRatio.toFixed(1)}× jerk), so render interpolation is absorbing it and motion ` +
          `reads smooth.`,
      )
    }
    if (s.vertReversalsPerSec > VERT_REVERSAL_WARN_PER_SEC) {
      parts.push(
        `The body also oscillates vertically (${s.vertReversalsPerSec.toFixed(1)} reversals/s) — likely ` +
          `hover-spring ringing in the sim itself; interpolation will smooth the look but won't remove ` +
          `the underlying bounce.`,
      )
    }
    if (parts.length === 0) {
      return `No significant jitter signature this window (cadence clean, body motion smooth).`
    }
    return parts.join(' ')
  }

  function summary(): JitterSummary {
    const meanFrameMs = frames > 0 ? frameMsSum / frames : 0
    const base: Omit<JitterSummary, 'verdict'> = {
      frames,
      ticks,
      durationMs: frameMsSum,
      renderHz: meanFrameMs > 0 ? 1000 / meanFrameMs : 0,
      simHz,
      meanFrameMs,
      stepsHistogram: stepsHistogram.slice(),
      meanStepsPerFrame: frames > 0 ? stepsSum / frames : 0,
      zeroStepFrac: frames > 0 ? zeroStepFrames / frames : 0,
      multiStepFrac: frames > 0 ? multiStepFrames / frames : 0,
      meanAlpha: frames > 0 ? alphaSum / frames : 0,
      renderJerkMean: renderJerkCount > 0 ? renderJerkSum / renderJerkCount : 0,
      renderJerkMax,
      simJerkMean: simJerkCount > 0 ? simJerkSum / simJerkCount : 0,
      simJerkMax,
      vertReversalsPerSec: frameMsSum > 0 ? vertReversals / (frameMsSum / 1000) : 0,
    }
    return { ...base, verdict: buildVerdict(base) }
  }

  function reset(): void {
    frames = 0
    frameMsSum = 0
    stepsSum = 0
    zeroStepFrames = 0
    multiStepFrames = 0
    alphaSum = 0
    stepsHistogram.fill(0)
    rPrevX = rPrevY = rPrevZ = 0
    rPrev2X = rPrev2Y = rPrev2Z = 0
    renderSamples = 0
    renderJerkSum = 0
    renderJerkMax = 0
    renderJerkCount = 0
    ticks = 0
    tPrevX = tPrevY = tPrevZ = 0
    tPrev2X = tPrev2Y = tPrev2Z = 0
    tickSamples = 0
    simJerkSum = 0
    simJerkMax = 0
    simJerkCount = 0
    lastVertSign = 0
    vertReversals = 0
  }

  return { recordTick, recordFrame, summary, reset }
}
