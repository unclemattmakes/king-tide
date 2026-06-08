/**
 * Lightweight boot-phase timing. Always-on — a handful of `performance.now()`
 * reads with negligible cost — so the load-time breakdown ships in every build
 * (prod included). Turns "loading feels slow" into a measured split across
 * renderer init / asset fetch / shader pre-warm.
 *
 * `bootMark()` stamps a phase boundary from `main.ts`'s `boot()`; `bootReport()`
 * computes per-phase deltas, logs one readable line, and hangs the trace off
 * `window.__bootTrace` so the dev console (and the `boot-timing` Playwright
 * spec) can read where the time actually went. `bootStat()` records one-off
 * scalars (material counts, asset sizes) alongside the timeline.
 */

type Mark = { label: string; at: number }

const marks: Mark[] = []
const stats: Record<string, number> = {}
let started = 0

/** Stamp a phase boundary. The first mark anchors the timeline at t=0. */
export function bootMark(label: string): void {
  const at = performance.now()
  if (marks.length === 0) started = at
  marks.push({ label, at })
}

/** Record a one-off scalar (counts, byte sizes) shown alongside the phases. */
export function bootStat(key: string, value: number): void {
  stats[key] = value
}

export type BootTrace = {
  /** Wall-clock from the first mark to the last, ms. */
  totalMs: number
  phases: { label: string; sinceStartMs: number; deltaMs: number }[]
  stats: Record<string, number>
}

/**
 * Compute the trace, log a one-line summary (sorted so the dominant phase is
 * obvious), and publish it on `window.__bootTrace`. Safe to call more than once
 * — e.g. again after the deferred background warm finishes.
 */
export function bootReport(): BootTrace {
  const last = marks[marks.length - 1]?.at ?? started
  const phases = marks.map((m, i) => ({
    label: m.label,
    sinceStartMs: round1(m.at - started),
    deltaMs: round1(m.at - (marks[i - 1]?.at ?? m.at)),
  }))
  const trace: BootTrace = { totalMs: Math.round(last - started), phases, stats: { ...stats } }
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __bootTrace?: BootTrace }).__bootTrace = trace
  }
  const slowest = [...phases].sort((a, b) => b.deltaMs - a.deltaMs).slice(0, 4)
  const statStr = Object.keys(stats).length ? ` · ${JSON.stringify(trace.stats)}` : ''
  // eslint-disable-next-line no-console
  console.info(
    `[boot-trace] total ${trace.totalMs}ms · slowest: ${slowest
      .map((p) => `${p.label} ${p.deltaMs}ms`)
      .join(', ')}${statStr}`,
  )
  return trace
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
