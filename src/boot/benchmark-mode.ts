/**
 * In-app performance benchmark mode (`?bench=1`).
 *
 * The centerpiece of the perf-measurement kit. Boots a normal race for a
 * target track with the FULL 8-bike field and AUTOPLAY forced on (AI drives
 * the player bike, hands-off), so the measurement is repeatable and
 * representative of real race load — then runs a fixed warmup + measure
 * window and paints a big, screenshot-friendly results panel.
 *
 * Crucially this is **production-safe**: it must run on any device by just
 * opening a URL (iPhone Safari, Steam Deck via the deployed Vercel build),
 * so nothing here is gated behind `import.meta.env.DEV` or the dev-only
 * `__hover` surface. The boot wiring in `main.ts` only checks for the
 * `?bench=1` query param.
 *
 * ## Why a benchmark-owned recorder
 *
 * The live `PerfRecorder` created inside `startGameLoop` is the canonical
 * per-frame sampler, but it's private to that closure and the only handle to
 * it (`__hover.perf`) is hard-gated to dev/test. Reaching it would mean
 * either editing `game-loop.ts` (out of scope for this change) or relying on
 * a dev-only surface (would make bench mode a no-op in the production build
 * we specifically need it for). So the benchmark director constructs its own
 * `PerfRecorder` and `sample()`s it once per frame from its own
 * `requestAnimationFrame` loop — which fires on the same vsync as the game
 * loop's rAF, so the frame-time deltas it records are the real displayed
 * frame times. This is NOT "a second recorder that isn't being sampled": it
 * is sampled every frame, in lockstep with rendering.
 *
 * The renderer's `info.render.*` counters (draw calls, triangles) ARE read
 * from the live renderer handle — published prod-safely via the renderer
 * service / passed straight from boot — exactly the way `perf-hud.ts` reads
 * them.
 *
 * Single track per page load (NOT a multi-track auto-cycler). The results
 * panel offers three re-run links that reload into `?bench=1&track=<id>` so
 * the user can walk all three dressed tracks by hand.
 */

import { createPerfRecorder, type PerfStats } from '@/engine/perf-recorder'
import type { RenderInfoLite } from '@/engine/render/perf-hud'

/** Tracks offered as one-click re-run links on the results panel. These are
 *  the dressed (art-complete) tracks — the meaningful targets for a perf
 *  pass. The default track when `?bench=1` carries no `&track=` is the
 *  first entry. (South Beach Sunken dropped out when its slot was rebuilt
 *  as the greybox-pending Texcoco Rising — Mexico City.) */
export const BENCH_TRACKS = ['sandbar', 'the-maw'] as const
export type BenchTrackId = (typeof BENCH_TRACKS)[number]

/** Default bench track when `?bench=1` is opened without `&track=`. */
export const DEFAULT_BENCH_TRACK: BenchTrackId = 'sandbar'

/** Default bike variant for a benchmark run. The race itself accepts any
 *  `?bike=` value; this is just the value bench mode resolves to when none
 *  is given, and what the re-run links carry. */
export const DEFAULT_BENCH_BIKE = 'racer'

/** Warmup before measurement starts — lets shader compiles, asset streaming,
 *  the pre-lap intro, and the AI settling onto the racing line wash out. */
const WARMUP_MS = 3000
/** Measurement window. ~10 s ≈ the perf recorder's full 600-sample ring at
 *  60 fps, so the percentiles are computed over a representative window. */
const MEASURE_MS = 10000

/** The minimal renderer surface the benchmark reads. Mirrors how
 *  `perf-hud.ts` consumes `renderer.info` without importing Three. */
interface RendererInfoHolder {
  info: RenderInfoLite
}

export interface BenchmarkHandles {
  /** Live renderer (the WebGPURenderer behind the WebGLRenderer cast). Read
   *  for `.info.render.calls` / `.info.render.triangles`. */
  renderer: RendererInfoHolder
  /** Backend Three actually initialised — 'webgpu' | 'webgl2'. */
  backend: string
  /** Controls handle from `installControls` — used to force auto-play on so
   *  the AI drives the player bike hands-off for a repeatable load. */
  controls: { setAutoPlay(on: boolean): void; isAutoPlay(): boolean }
  /** Resolved track id under measurement. */
  trackId: string
  /** Resolved bike variant id under measurement. */
  bikeId: string
}

/** Everything the results panel + exports report. */
export interface BenchmarkResult {
  trackId: string
  bikeId: string
  backend: string
  fps: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  hitchCount: number
  drawCalls: number
  triangles: number
  /** Sample count actually captured in the measure window. */
  frames: number
  /** Short device/UA hint. */
  device: string
  /** Build mode (production / development / test). */
  buildMode: string
  /** ISO-8601 timestamp at measurement end. */
  timestamp: string
}

/**
 * Install the benchmark director. Call once, after the race game loop has
 * started, from the `?bench=1` boot path. Returns a small handle mostly for
 * symmetry / testing — the director is self-driving via rAF + timers.
 */
export function installBenchmark(handles: BenchmarkHandles): { dispose(): void } {
  const recorder = createPerfRecorder()

  let phase: 'warmup' | 'measure' | 'done' = 'warmup'
  let rafId = 0
  let disposed = false
  // performance.now() origin for the active phase, set on each transition.
  let phaseStart = performance.now()

  // Force the AI to drive the player bike for the whole run. We set it now
  // and re-assert it on the warmup→measure transition so a stray toggle (or
  // the out-of-bounds autopilot handing control back) can't desync the load.
  handles.controls.setAutoPlay(true)

  // A lightweight status chip while the run is in flight, so an on-device
  // session knows the page is busy measuring rather than hung. Replaced by
  // the full results panel when the window closes.
  const status = createStatusChip(handles.trackId)

  function loop(now: number): void {
    if (disposed) return
    rafId = requestAnimationFrame(loop)

    // Sample every frame — this is the recorder's hot path and is what makes
    // the measurement representative. The first call seeds the baseline.
    recorder.sample(now)

    const elapsed = now - phaseStart
    if (phase === 'warmup') {
      status.setText(`BENCH · warmup ${secsLeft(WARMUP_MS - elapsed)}`)
      if (elapsed >= WARMUP_MS) {
        // Re-assert auto-play, then zero the ring so the measure window holds
        // only post-warmup frames.
        handles.controls.setAutoPlay(true)
        recorder.reset()
        phase = 'measure'
        phaseStart = now
      }
      return
    }

    if (phase === 'measure') {
      status.setText(`BENCH · measuring ${secsLeft(MEASURE_MS - elapsed)}`)
      if (elapsed >= MEASURE_MS) {
        phase = 'done'
        finish()
      }
    }
  }

  function finish(): void {
    cancelAnimationFrame(rafId)
    const stats = recorder.stats()
    const result = assembleResult(stats, handles)
    status.dispose()
    if (typeof document !== 'undefined') {
      mountResultsPanel(result)
    }
  }

  rafId = requestAnimationFrame(loop)

  return {
    dispose() {
      disposed = true
      cancelAnimationFrame(rafId)
      status.dispose()
    },
  }
}

/** Snapshot the renderer + stats into the reportable result. Reads
 *  `renderer.info.render.*` exactly like perf-hud (live, post-render,
 *  mutating object). */
function assembleResult(stats: PerfStats, handles: BenchmarkHandles): BenchmarkResult {
  const info = handles.renderer.info
  return {
    trackId: handles.trackId,
    bikeId: handles.bikeId,
    backend: handles.backend,
    fps: stats.fps,
    p50Ms: stats.p50Ms,
    p95Ms: stats.p95Ms,
    p99Ms: stats.p99Ms,
    hitchCount: stats.hitchCount,
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    frames: stats.count,
    device: deviceHint(),
    buildMode: readBuildMode(),
    timestamp: new Date().toISOString(),
  }
}

/**
 * Build the Markdown table row for the "Copy row" button. Column order is
 * load-bearing — it must match the results doc and the `pnpm profile`
 * output exactly:
 *
 *   `| <track> | <backend> | <fps> | <p50ms> | <p95ms> | <p99ms> | <hitches> | <drawCalls> | <triangles> |`
 *
 * fps is rounded to 1 decimal, frame-ms to 1 decimal, counts are integers.
 */
export function benchMarkdownRow(r: BenchmarkResult): string {
  const cells = [
    r.trackId,
    r.backend,
    r.fps.toFixed(1),
    r.p50Ms.toFixed(1),
    r.p95Ms.toFixed(1),
    r.p99Ms.toFixed(1),
    String(r.hitchCount),
    String(r.drawCalls),
    String(r.triangles),
  ]
  return `| ${cells.join(' | ')} |`
}

/** Pretty-printed JSON for the "Download JSON" button. */
export function benchJson(r: BenchmarkResult): string {
  return JSON.stringify(r, null, 2)
}

// ---------------------------------------------------------------------------
// Environment hints
// ---------------------------------------------------------------------------

/** Short device/UA hint — enough to tell a phone from a Deck from a desktop
 *  in a glance, without dumping the whole UA string into the panel. */
function deviceHint(): string {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1
  const w = typeof window !== 'undefined' ? window.innerWidth : 0
  const h = typeof window !== 'undefined' ? window.innerHeight : 0
  let kind = 'desktop'
  if (/iPhone|iPad|iPod/i.test(ua)) kind = 'iOS'
  else if (/Android/i.test(ua)) kind = 'Android'
  else if (/SteamDeck|Valve|Steam\//i.test(ua)) kind = 'Deck'
  else if (/Macintosh/i.test(ua)) kind = 'macOS'
  else if (/Windows/i.test(ua)) kind = 'Windows'
  else if (/Linux/i.test(ua)) kind = 'Linux'
  return `${kind} ${w}x${h}@${dpr}`
}

/** Build mode for the report. `import.meta.env.MODE` is 'production' on the
 *  Vercel build, 'development' under `pnpm dev`, 'test' under Vitest. Wrapped
 *  so it can't throw in a context without `import.meta.env`. */
function readBuildMode(): string {
  try {
    const env = (import.meta as unknown as { env?: { MODE?: string } }).env
    return env?.MODE ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// DOM — status chip + results panel
// ---------------------------------------------------------------------------

function secsLeft(remainingMs: number): string {
  return `${Math.max(0, Math.ceil(remainingMs / 1000))}s`
}

interface StatusChip {
  setText(text: string): void
  dispose(): void
}

/** Small fixed chip shown while warmup/measure is running. Plain DOM +
 *  inline styles, matching how `perf-hud.ts` builds its overlay. */
function createStatusChip(trackId: string): StatusChip {
  if (typeof document === 'undefined') {
    return { setText: () => {}, dispose: () => {} }
  }
  const el = document.createElement('div')
  el.id = 'bench-status'
  el.style.cssText = [
    'position: fixed',
    'top: 12px',
    'left: 50%',
    'transform: translateX(-50%)',
    'z-index: 100000',
    'padding: 8px 16px',
    'background: rgba(8, 14, 24, 0.88)',
    'color: #7df9ff',
    'font: 600 16px ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    'border: 1px solid rgba(125, 249, 255, 0.4)',
    'border-radius: 6px',
    'pointer-events: none',
    'white-space: nowrap',
  ].join(';')
  el.textContent = `BENCH · ${trackId} · warmup`
  document.body.appendChild(el)
  return {
    setText(text: string) {
      el.textContent = text
    },
    dispose() {
      el.remove()
    },
  }
}

/**
 * Build + mount the big, screenshot-friendly results panel. Fixed overlay,
 * very high z-index (above the race HUD, perf-hud, touch overlay, and the
 * finish card), large monospace numbers, works at phone width.
 */
function mountResultsPanel(r: BenchmarkResult): void {
  // Tear down any prior panel (defensive — a single run only mounts once).
  document.getElementById('bench-results')?.remove()

  const root = document.createElement('div')
  root.id = 'bench-results'
  root.style.cssText = [
    'position: fixed',
    'inset: 0',
    'z-index: 100001',
    'display: flex',
    'align-items: center',
    'justify-content: center',
    'padding: 16px',
    'background: rgba(4, 8, 14, 0.82)',
    '-webkit-backdrop-filter: blur(2px)',
    'backdrop-filter: blur(2px)',
    'box-sizing: border-box',
    'overflow: auto',
  ].join(';')

  const card = document.createElement('div')
  card.style.cssText = [
    'width: min(560px, 100%)',
    'max-height: 100%',
    'box-sizing: border-box',
    'padding: 20px 22px',
    'background: rgba(10, 16, 26, 0.96)',
    'color: rgba(235, 245, 255, 0.96)',
    'border: 1px solid rgba(125, 249, 255, 0.35)',
    'border-radius: 12px',
    'font: 13px ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    'line-height: 1.5',
    'box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6)',
    'overflow: auto',
  ].join(';')

  const title = document.createElement('div')
  title.textContent = 'PERFORMANCE BENCHMARK'
  title.style.cssText = [
    'font-size: 18px',
    'font-weight: 700',
    'letter-spacing: 0.08em',
    'color: #7df9ff',
    'margin-bottom: 2px',
  ].join(';')

  const subtitle = document.createElement('div')
  subtitle.textContent = `${r.trackId} · ${r.bikeId} · ${r.backend}`
  subtitle.style.cssText = 'opacity: 0.8; margin-bottom: 14px; word-break: break-word'

  // Headline FPS — the number a phone screenshot should make obvious.
  const fpsBig = document.createElement('div')
  fpsBig.textContent = `${r.fps.toFixed(1)} fps`
  fpsBig.style.cssText = [
    'font-size: 44px',
    'font-weight: 800',
    'line-height: 1.1',
    'margin-bottom: 12px',
    colorForFps(r.fps),
  ].join(';')

  // Metric grid — large, readable rows.
  const grid = document.createElement('div')
  grid.style.cssText = [
    'display: grid',
    'grid-template-columns: auto 1fr',
    'gap: 4px 16px',
    'font-size: 15px',
    'margin-bottom: 16px',
  ].join(';')
  const rows: Array<[string, string]> = [
    ['p50 frame', `${r.p50Ms.toFixed(1)} ms`],
    ['p95 frame', `${r.p95Ms.toFixed(1)} ms`],
    ['p99 frame', `${r.p99Ms.toFixed(1)} ms`],
    ['hitches', String(r.hitchCount)],
    ['draw calls', String(r.drawCalls)],
    ['triangles', formatInt(r.triangles)],
    ['frames', String(r.frames)],
    ['device', r.device],
    ['build', r.buildMode],
  ]
  for (const [label, value] of rows) {
    const l = document.createElement('div')
    l.textContent = label
    l.style.cssText = 'opacity: 0.7'
    const v = document.createElement('div')
    v.textContent = value
    v.style.cssText = 'font-weight: 600; text-align: right; word-break: break-word'
    grid.appendChild(l)
    grid.appendChild(v)
  }

  // Markdown row preview (also what the Copy button writes).
  const mdRow = benchMarkdownRow(r)
  const mdBox = document.createElement('div')
  mdBox.textContent = mdRow
  mdBox.style.cssText = [
    'font-size: 11px',
    'opacity: 0.75',
    'padding: 8px 10px',
    'margin-bottom: 14px',
    'background: rgba(0, 0, 0, 0.35)',
    'border-radius: 6px',
    'white-space: pre-wrap',
    'word-break: break-all',
  ].join(';')

  // Action buttons — Copy row (Markdown) + Download JSON.
  const actions = document.createElement('div')
  actions.style.cssText = 'display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px'
  const copyBtn = makeButton('Copy row (Markdown)')
  copyBtn.addEventListener('click', () => {
    void copyText(mdRow).then((ok) => {
      copyBtn.textContent = ok ? 'Copied!' : 'Copy failed — select below'
      if (!ok) selectText(mdBox)
      window.setTimeout(() => {
        copyBtn.textContent = 'Copy row (Markdown)'
      }, 1800)
    })
  })
  const dlBtn = makeButton('Download JSON')
  dlBtn.addEventListener('click', () => {
    downloadText(
      benchJson(r),
      `hoverbike-bench-${r.trackId}-${r.timestamp.replace(/[:.]/g, '-')}.json`,
      'application/json',
    )
  })
  actions.appendChild(copyBtn)
  actions.appendChild(dlBtn)

  // Re-run links — reload into `?bench=1&track=<id>` for each dressed track.
  const rerunLabel = document.createElement('div')
  rerunLabel.textContent = 'Re-run on:'
  rerunLabel.style.cssText = 'opacity: 0.7; margin-bottom: 6px; font-size: 12px'
  const rerun = document.createElement('div')
  rerun.style.cssText = 'display: flex; gap: 10px; flex-wrap: wrap'
  for (const id of BENCH_TRACKS) {
    const link = makeButton(id, id === r.trackId)
    link.addEventListener('click', () => {
      window.location.assign(benchUrlFor(id, r.bikeId))
    })
    rerun.appendChild(link)
  }

  card.appendChild(title)
  card.appendChild(subtitle)
  card.appendChild(fpsBig)
  card.appendChild(grid)
  card.appendChild(mdBox)
  card.appendChild(actions)
  card.appendChild(rerunLabel)
  card.appendChild(rerun)
  root.appendChild(card)
  document.body.appendChild(root)
}

/** Build a `?bench=1&track=<id>&bike=<id>` URL off the current location,
 *  dropping every other query param so a re-run is a clean bench boot. */
function benchUrlFor(trackId: string, bikeId: string): string {
  const url = new URL(window.location.href)
  url.search = ''
  url.searchParams.set('bench', '1')
  url.searchParams.set('track', trackId)
  url.searchParams.set('bike', bikeId)
  return url.toString()
}

function makeButton(label: string, current = false): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.style.cssText = [
    'appearance: none',
    'cursor: pointer',
    'padding: 10px 14px',
    'font: 600 14px ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    'color: #04101a',
    current ? 'background: #7df9ff' : 'background: rgba(125, 249, 255, 0.82)',
    'border: 1px solid rgba(125, 249, 255, 0.6)',
    'border-radius: 8px',
    'min-height: 44px',
    'touch-action: manipulation',
  ].join(';')
  return b
}

/** FPS → headline colour. Green ≥ 58, amber ≥ 45, else red. The 60 fps
 *  target is the bar; this is a coarse at-a-glance read. */
function colorForFps(fps: number): string {
  if (fps >= 58) return 'color: #7dffa0'
  if (fps >= 45) return 'color: #ffd166'
  return 'color: #ff6b6b'
}

function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

// ---------------------------------------------------------------------------
// Clipboard + download — same Blob+anchor / navigator.clipboard pattern as
// `src/engine/qa/bug-bundle.ts` (downloadBundle / copyBundle), inlined here
// because those helpers are typed to the QaBundle shape. NOT dev-gated.
// ---------------------------------------------------------------------------

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function downloadText(text: string, filename: string, mime: string): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Fallback when the clipboard API is unavailable (older Safari, insecure
 *  origin): select the Markdown text so the user can copy it manually. */
function selectText(el: HTMLElement): void {
  const sel = window.getSelection?.()
  if (!sel) return
  const range = document.createRange()
  range.selectNodeContents(el)
  sel.removeAllRanges()
  sel.addRange(range)
}
