/**
 * Step 8 — QA bug-repro bundle.
 *
 * One call → one downloadable JSON file containing everything a triager
 * needs to reproduce the issue without playing telephone with the
 * reporter. Inspired by Chrome's `chrome://crashes` capture but scoped to
 * this game's surfaces.
 *
 * Surfaced on `__hover.qa.bundle()` (synchronous, returns the bundle
 * object) and `__hover.qa.downloadBundle()` (triggers a download via the
 * standard Blob + anchor pattern). The companion `__hover.qa.copyBundle()`
 * stuffs the JSON onto the clipboard for a quick paste into a GitHub
 * issue.
 *
 * Bundle is gated behind the same dev/test/determinism gate as the rest
 * of `__hover`. Production bundles get nothing — there's no privacy story
 * for the localStorage settings dump otherwise.
 *
 * Intentionally NOT included in the bundle:
 *  - the full replay binary (too large, often >100 KB; the bundle hints
 *    at its presence + size and points at `downloadReplay()`)
 *  - the audio context graph (no useful repro signal, lots of bytes)
 *  - the Three.js scene tree (any v1 track has tens of thousands of
 *    objects post-instancing — would balloon the bundle)
 */

import type { PerfStats } from '@/engine/perf-recorder'
import type { PlayerSettings } from '@/engine/player-settings'
import type { RenderBackend } from '@/engine/render/renderer'
import type { ConsoleRecord, ConsoleTrap } from './console-trap'

/** The bundle schema. Keep this stable: GitHub issues filed against
 *  one version need to remain parseable by future triagers. */
export type QaBundle = {
  /** Bumped when fields are added or renamed. */
  schemaVersion: 1
  /** ISO-8601 wall-clock timestamp at bundle assembly. */
  timestamp: string
  /** Full URL of the page that produced the bundle. */
  url: string
  userAgent: string
  /** Viewport + DPR — distinguishes "broken on Deck 1280×800" from
   *  "broken on a 4K laptop downscaled". */
  viewport: {
    innerWidth: number
    innerHeight: number
    devicePixelRatio: number
  }
  /** Build mode (dev / test / production) + git SHA if Vite injected one
   *  via `import.meta.env.VITE_GIT_SHA`. */
  build: {
    mode: string
    gitSha: string | null
  }
  renderer: {
    backend: RenderBackend | 'unknown'
  }
  perf: PerfStats | null
  /** Snapshot of the gameplay-relevant ECS state. Null before boot
   *  completes or in edit/viewer mode where there's no player bike. */
  player: BundlePlayerSnapshot | null
  race: BundleRaceSnapshot | null
  /** Sanitized player settings — handle string is masked to length only,
   *  everything else is verbatim. */
  settings: SanitizedSettings | null
  /** Console trap dump — last 200 records by default. */
  console: {
    records: ConsoleRecord[]
    /** Total ever captured. If `records.length < totalCount` the trap
     *  ring overflowed and you're looking at the tail. */
    totalCount: number
  }
  /** Hint that a replay exists. Use `__hover.downloadReplay()` to grab
   *  it separately — bundling it here would dominate the file size. */
  replay: {
    hasRecorder: boolean
    eventCount: number | null
    sizeBytes: number | null
  }
  /** Best-effort multiplayer status. Null in single-player. */
  network: BundleNetworkSnapshot | null
}

export type BundlePlayerSnapshot = {
  eid: number | null
  position: { x: number; y: number; z: number }
  velocity: { x: number; y: number; z: number }
  speed: number
  isGrounded: boolean
}

export type BundleRaceSnapshot = {
  lap: number
  lapsToFinish: number
  nextCheckpoint: number
  checkpointsCrossed: number
  totalCheckpoints: number
  finished: boolean
  raceTime: number
}

export type BundleNetworkSnapshot = {
  ready: boolean
  peerId: number
  remotePeers: readonly number[]
  isHost: boolean
  snapshotsReceived: number
}

/** Player settings minus anything that could leak personal info. The
 *  leaderboard handle gets masked to length so we can debug "the racer
 *  on the 12-char track row" without surfacing the actual string. */
export type SanitizedSettings = Omit<PlayerSettings, 'leaderboardHandle'> & {
  leaderboardHandleLength: number
}

/** Sources the bundle needs to read from. All optional so a partially-
 *  initialized boot can still assemble whatever's available — a crash
 *  during loading still produces a useful bundle. */
export interface BundleSources {
  consoleTrap: ConsoleTrap | null
  perfStats?: () => PerfStats | null
  player?: () => BundlePlayerSnapshot | null
  race?: () => BundleRaceSnapshot | null
  renderer?: () => RenderBackend | 'unknown'
  settings?: () => PlayerSettings | null
  replay?: () => { eventCount: number; sizeBytes: number } | null
  network?: () => BundleNetworkSnapshot | null
}

export function buildBugBundle(sources: BundleSources): QaBundle {
  const gitSha = readEnv('VITE_GIT_SHA')
  const mode = readEnv('MODE') ?? 'unknown'
  const consoleRecords = sources.consoleTrap?.records() ?? []
  const consoleTotal = sources.consoleTrap?.totalCount() ?? 0
  const settingsRaw = sources.settings?.() ?? null
  return {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    url: typeof location !== 'undefined' ? location.href : '',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    viewport: {
      innerWidth: typeof window !== 'undefined' ? window.innerWidth : 0,
      innerHeight: typeof window !== 'undefined' ? window.innerHeight : 0,
      devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
    },
    build: { mode, gitSha },
    renderer: { backend: sources.renderer?.() ?? 'unknown' },
    perf: sources.perfStats?.() ?? null,
    player: sources.player?.() ?? null,
    race: sources.race?.() ?? null,
    settings: settingsRaw ? sanitizeSettings(settingsRaw) : null,
    console: { records: consoleRecords, totalCount: consoleTotal },
    replay: {
      hasRecorder: sources.replay != null,
      eventCount: sources.replay?.()?.eventCount ?? null,
      sizeBytes: sources.replay?.()?.sizeBytes ?? null,
    },
    network: sources.network?.() ?? null,
  }
}

/** Render the bundle as a pretty-printed JSON string ready for a GitHub
 *  issue paste. The whitespace matters — collapsed JSON in a markdown
 *  code fence is unreadable. */
export function bundleToString(bundle: QaBundle): string {
  return JSON.stringify(bundle, null, 2)
}

/** Trigger a browser download for the bundle JSON. Uses the same Blob +
 *  anchor pattern as `downloadReplay` / `downloadCsv`. */
export function downloadBundle(bundle: QaBundle, filename?: string): void {
  if (typeof document === 'undefined') return
  const text = bundleToString(bundle)
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const stamp = bundle.timestamp.replace(/[:.]/g, '-')
  const name = filename ?? `hoverbike-bug-${stamp}.json`
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Best-effort clipboard write. Resolves to true on success, false on
 *  any browser refusal (permission, missing clipboard API). The caller
 *  surfaces the result so QA can fall back to the download path. */
export async function copyBundle(bundle: QaBundle): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false
  try {
    await navigator.clipboard.writeText(bundleToString(bundle))
    return true
  } catch {
    return false
  }
}

function sanitizeSettings(s: PlayerSettings): SanitizedSettings {
  const { leaderboardHandle, ...rest } = s
  return {
    ...(rest as Omit<PlayerSettings, 'leaderboardHandle'>),
    leaderboardHandleLength: leaderboardHandle.length,
  }
}

/** Tiny env-var reader that doesn't blow up in jsdom / node when
 *  `import.meta.env` is unavailable. */
function readEnv(key: string): string | null {
  try {
    const env = (
      import.meta as unknown as {
        env?: Record<string, string | undefined>
      }
    ).env
    return env?.[key] ?? null
  } catch {
    return null
  }
}
