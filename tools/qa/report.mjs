/**
 * Renders the orchestrator's run data as a single Markdown document.
 * Kept separate from runner.mjs so unit tests (and future re-runs that
 * want to consume an older qa-report.json) can build the same view
 * without re-running the gates.
 *
 * The report is opinionated: one summary table, one preflight summary,
 * one perf-numbers table extracted from the matrix log, then per-step
 * sections each with a status pill and a pointer at the log file.
 * Failures get a tail of the log inline so a triager doesn't have to
 * chase the artifact path.
 */

import { existsSync, readFileSync } from 'node:fs'

/** Number of trailing log lines to inline under a failure section. */
const FAILURE_TAIL_LINES = 40

/**
 * @typedef {{
 *   schemaVersion: 1,
 *   runStartedAt: string,
 *   runFinishedAt: string,
 *   runDurationMs: number,
 *   repoRoot: string,
 *   preflight?: PreflightCheck[],
 *   steps: QaStep[],
 * }} QaReport
 * @typedef {{
 *   name: string,
 *   ok: boolean,
 *   message: string,
 *   fix?: string,
 * }} PreflightCheck
 * @typedef {{
 *   id: string,
 *   label: string,
 *   command: string,
 *   status: 'pass' | 'fail' | 'skip',
 *   durationMs: number,
 *   startedAt: string,
 *   finishedAt: string,
 *   exitCode: number | null,
 *   logPath: string,
 *   gate: boolean,
 * }} QaStep
 * @typedef {{
 *   track: string,
 *   bike: string,
 *   fps: number,
 *   p50Ms: number,
 *   p95Ms: number,
 *   p99Ms: number,
 *   hitchCount: number,
 *   count: number,
 * }} MatrixPerfRow
 */

const STATUS_GLYPH = Object.freeze({
  pass: '✅ PASS',
  fail: '❌ FAIL',
  skip: '⏭️ SKIP',
})

/** @param {QaReport} report */
export function renderMarkdown(report) {
  const lines = []
  const totals = summariseTotals(report.steps)
  const shippable = report.steps.every((s) => s.status !== 'fail' || !s.gate)

  lines.push('# Hoverbike QA Report')
  lines.push('')
  lines.push(`> Run started **${report.runStartedAt}** — ${formatDuration(report.runDurationMs)}.`)
  lines.push('')
  lines.push(
    shippable
      ? '**Shippability:** ✅ no gated failures.'
      : '**Shippability:** ❌ one or more gated steps failed — see per-step sections below.',
  )
  lines.push('')

  // Preflight summary — only render when the orchestrator captured it
  // (older qa-report.json blobs won't carry the field).
  if (report.preflight?.length) {
    lines.push('## Preflight')
    lines.push('')
    lines.push('| Check | Status | Notes |')
    lines.push('|---|---|---|')
    for (const c of report.preflight) {
      const glyph = c.ok ? '✅' : '⚠️'
      const notes = c.ok ? c.message : `${c.message}${c.fix ? ` — fix: \`${c.fix}\`` : ''}`
      lines.push(`| ${c.name} | ${glyph} | ${notes} |`)
    }
    lines.push('')
  }

  // Summary table — one line per step.
  lines.push('## Summary')
  lines.push('')
  lines.push('| Step | Status | Duration | Gate | Log |')
  lines.push('|---|---|---|---|---|')
  for (const s of report.steps) {
    lines.push(
      `| ${s.label} | ${STATUS_GLYPH[s.status]} | ${formatDuration(s.durationMs)} | ${s.gate ? 'yes' : 'no'} | \`${relPath(s.logPath, report.repoRoot)}\` |`,
    )
  }
  lines.push('')
  lines.push(
    `**Totals:** ${totals.pass} pass · ${totals.fail} fail · ${totals.skip} skip · ${report.steps.length} total.`,
  )
  lines.push('')

  // Matrix perf table — extract the structured `qa-matrix:*:perf` lines
  // from the matrix step's log so the richest signal the QA pass produces
  // (actual fps / p95 / hitch counts per cell) lives in the report and
  // not buried in a log artifact.
  const matrixStep = report.steps.find((s) => s.id === 'matrix')
  if (matrixStep) {
    const perfRows = parseMatrixPerfRows(matrixStep.logPath)
    if (perfRows.length > 0) {
      lines.push('## Matrix perf')
      lines.push('')
      lines.push('| Track | Bike | FPS | p50 ms | p95 ms | p99 ms | Hitches | Samples |')
      lines.push('|---|---|---:|---:|---:|---:|---:|---:|')
      for (const r of perfRows) {
        lines.push(
          `| ${r.track} | ${r.bike} | ${r.fps.toFixed(1)} | ${r.p50Ms.toFixed(1)} | ${r.p95Ms.toFixed(1)} | ${r.p99Ms.toFixed(1)} | ${r.hitchCount} | ${r.count} |`,
        )
      }
      lines.push('')
      const sortedByFps = [...perfRows].sort((a, b) => a.fps - b.fps)
      const worst = sortedByFps[0]
      const best = sortedByFps[sortedByFps.length - 1]
      if (worst && best) {
        lines.push(
          `**Range:** worst ${worst.track} × ${worst.bike} (${worst.fps.toFixed(1)} fps, p95 ${worst.p95Ms.toFixed(1)} ms) → best ${best.track} × ${best.bike} (${best.fps.toFixed(1)} fps, p95 ${best.p95Ms.toFixed(1)} ms).`,
        )
        lines.push('')
      }
    }
  }

  // Per-step section, with a log tail for failures.
  lines.push('## Per-step detail')
  lines.push('')
  for (const s of report.steps) {
    lines.push(`### ${STATUS_GLYPH[s.status]} ${s.label}`)
    lines.push('')
    lines.push(`- **id:** \`${s.id}\``)
    lines.push(`- **command:** \`${s.command}\``)
    lines.push(`- **exit code:** \`${s.exitCode}\``)
    lines.push(`- **duration:** ${formatDuration(s.durationMs)}`)
    lines.push(`- **gate:** ${s.gate ? 'yes — failure blocks shippability' : 'no — advisory only'}`)
    lines.push(`- **log:** \`${relPath(s.logPath, report.repoRoot)}\``)
    if (s.status === 'fail') {
      const tail = readLogTail(s.logPath, FAILURE_TAIL_LINES)
      if (tail) {
        lines.push('')
        lines.push('<details>')
        lines.push(`<summary>Last ${FAILURE_TAIL_LINES} log lines</summary>`)
        lines.push('')
        lines.push('```')
        lines.push(tail)
        lines.push('```')
        lines.push('')
        lines.push('</details>')
      }
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(
    `Generated by \`tools/qa/runner.mjs\` at ${report.runFinishedAt}. See [docs/qa-playbook.md](../docs/qa-playbook.md) for the convention.`,
  )
  lines.push('')
  return lines.join('\n')
}

/** Count statuses across steps. Pure; used by both the renderer and the
 *  orchestrator's stdout one-liner. */
export function summariseTotals(steps) {
  const t = { pass: 0, fail: 0, skip: 0 }
  for (const s of steps) {
    t[s.status] = (t[s.status] ?? 0) + 1
  }
  return t
}

/**
 * Render an absolute path as a repo-relative path. Handles both POSIX
 * forward slashes and Windows backslashes — the orchestrator emits
 * native paths from `path.join`, so on Windows the log paths come back
 * with backslashes and the previous implementation's slash-only prefix
 * match left them as absolute paths in the report. Normalises both
 * sides before comparing.
 */
export function relPath(absPath, root) {
  if (!absPath) return ''
  const norm = (p) => p.replace(/\\/g, '/')
  const a = norm(absPath)
  const r = norm(root)
  const rWithSlash = r.endsWith('/') ? r : `${r}/`
  if (a.startsWith(rWithSlash)) return a.slice(rWithSlash.length)
  return a
}

/**
 * Extract structured perf rows the matrix spec emits as
 *   `qa-matrix:<track>:<bike>:perf {"fps":..., "p95Ms":..., ...}`
 *
 * Returns `[]` if the log is missing or the lines aren't present (an
 * unrelated failure happened before any cell could log its perf blob).
 *
 * @param {string} logPath
 * @returns {MatrixPerfRow[]}
 */
export function parseMatrixPerfRows(logPath) {
  if (!existsSync(logPath)) return []
  let raw
  try {
    raw = readFileSync(logPath, 'utf8')
  } catch {
    return []
  }
  /** @type {MatrixPerfRow[]} */
  const rows = []
  // `qa-matrix:<track>:<bike>:perf {"fps":...,"p50Ms":...,...}`. The JSON
  // can technically wrap a newline if the recorder ever grew to multiline
  // output, but today it's always single-line so this is fine.
  const re = /qa-matrix:([\w-]+):([\w-]+):perf\s+(\{.*\})/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const [, track, bike, jsonText] = m
    try {
      const parsed = JSON.parse(jsonText)
      rows.push({
        track,
        bike,
        fps: numberOr(parsed.fps, 0),
        p50Ms: numberOr(parsed.p50Ms, 0),
        p95Ms: numberOr(parsed.p95Ms, 0),
        p99Ms: numberOr(parsed.p99Ms, 0),
        hitchCount: numberOr(parsed.hitchCount, 0),
        count: numberOr(parsed.count, 0),
      })
    } catch {
      // Skip malformed lines silently — a partial parse is still worth
      // surfacing rows we did get.
    }
  }
  return rows
}

function numberOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

function readLogTail(path, n) {
  if (!existsSync(path)) return ''
  try {
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n')
    return lines.slice(Math.max(0, lines.length - n)).join('\n')
  } catch {
    return ''
  }
}
