/**
 * RTT tracker — exponentially-weighted moving average over the most
 * recent ping/pong round-trips. The relay echoes a `ping` back as a
 * `pong`; the client computes `now - t` and feeds it here.
 *
 * Smoothing matters because the raw RTT bounces ±20 ms tick to tick on
 * a healthy connection — a stable readout is what the player actually
 * cares about (am I lagging?). The EWMA settles on the typical RTT in
 * a few samples while still moving with sustained shifts (e.g. a Wi-Fi
 * roam that bumps you from 30 ms → 90 ms).
 *
 * A pong that arrives more than `STALE_MS` after we'd have expected it
 * (~2× the typical ping cadence + a generous slop) marks the channel
 * stale: `current()` returns -1 until the next pong lands. Stale-out
 * is what surfaces "no signal" in the HUD chip / settings readout.
 */

/** How much weight the newest sample carries vs. the running average.
 *  0.25 settles within ~10 samples while keeping the readout smooth. */
const EWMA_ALPHA = 0.25

/** Pongs are considered stale after this many milliseconds — we'd
 *  expect a pong every PING_PERIOD_MS, so 4× that is a generous slop
 *  for one or two dropped exchanges before we admit the channel went
 *  quiet. */
export const LATENCY_STALE_MS = 6000

export type LatencyTracker = {
  /** Feed a fresh RTT sample (ms). Negative samples are clamped to 0. */
  record(rttMs: number, atMs: number): void
  /** Current smoothed RTT (ms), or -1 if no samples yet or the most
   *  recent sample is stale. */
  current(nowMs: number): number
  /** Drop all state — call on socket disconnect so a reconnect starts
   *  with a clean average instead of carrying old WAN-era samples. */
  reset(): void
  /** Raw sample count since last reset. Exposed for tests + the dev
   *  probe. */
  readonly sampleCount: number
}

export function createLatencyTracker(): LatencyTracker {
  let ewma = -1
  let lastSampleAt = -1
  let count = 0
  return {
    record(rttMs, atMs) {
      const rtt = Math.max(0, rttMs)
      ewma = ewma < 0 ? rtt : ewma + EWMA_ALPHA * (rtt - ewma)
      lastSampleAt = atMs
      count++
    },
    current(nowMs) {
      if (ewma < 0) return -1
      if (lastSampleAt >= 0 && nowMs - lastSampleAt > LATENCY_STALE_MS) return -1
      return ewma
    },
    reset() {
      ewma = -1
      lastSampleAt = -1
      count = 0
    },
    get sampleCount() {
      return count
    },
  }
}
