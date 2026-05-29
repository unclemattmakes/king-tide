#!/usr/bin/env node
/**
 * `pnpm qa` — Hoverbike QA orchestrator.
 *
 * Single entry point that runs the full QA stack against the current
 * working tree and emits a single Markdown + JSON report under
 * `qa-report/`. Non-blocking by design: each step runs independently
 * and the report shows pass / fail per gate. The process exit code
 * reflects the worst gate's status, so CI can opt into hard-failing on
 * a flag later without losing the per-step breakdown.
 *
 * Steps:
 *   1. `pnpm typecheck` — tsc against the unit + spec tree
 *   2. `pnpm lint`      — biome
 *   3. `pnpm test`      — vitest unit run
 *   4. (--track-lint) `pnpm gen:tracks:validate` — Blender-side spec
 *      lint. Opt-in because every CI runner lacks Blender by default,
 *      so the step is permanently `skip` in the default flow and
 *      clutters the report. Author-only.
 *   5. `QA_MATRIX=1 pnpm e2e tests/e2e/qa-track-matrix.spec.ts`
 *   6. (--soak) `QA_SOAK=1 pnpm e2e tests/e2e/qa-soak.spec.ts`
 *
 * Flags:
 *   --soak           include the stability soak (omit by default; CI
 *                    nightly job enables it)
 *   --doctor         run only the preflight checks (deps, Playwright
 *                    binary, dev port) and exit. Useful for "I just
 *                    cloned — what do I need to install?". No gates run.
 *   --track-lint     opt into the Blender-side `gen:tracks:validate`
 *                    step. Default off — author-only.
 *   --skip-typecheck dev iteration shortcut (e.g. when you just want
 *                    to re-run the matrix)
 *   --skip-lint
 *   --skip-unit
 *   --skip-matrix
 *   --keep-going     run every step even after one fails (default;
 *                    only flipped off via --no-keep-going)
 *
 * Environment:
 *   E2E_BROWSERS     forwarded as-is to Playwright (chromium by default)
 *   QA_REPORT_DIR    override the output directory (default qa-report/)
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderMarkdown } from './report.mjs'

// Suppress Node's DEP0190 noise about unescaped args under shell:true.
// All args we pass come from package.json scripts — static strings, no
// user input — so the deprecation isn't applicable to this orchestrator.
// See the `SPAWN_SHELL` comment below for the full rationale.
process.noDeprecation = true

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const REPORT_DIR = process.env.QA_REPORT_DIR ?? join(REPO_ROOT, 'qa-report')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)

const runSoak = flag('--soak')
const runDoctor = flag('--doctor')
const runTrackLint = flag('--track-lint')
const skipTypecheck = flag('--skip-typecheck')
const skipLint = flag('--skip-lint')
const skipUnit = flag('--skip-unit')
const skipMatrix = flag('--skip-matrix')
const keepGoing = !flag('--no-keep-going')

mkdirSync(REPORT_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// Preflight — catch missing prerequisites loud and early.
//
// Without this, the orchestrator burns through every gate failing with
// `spawn pnpm ENOENT` or 15× Playwright "browser not installed" retries
// before the user finds out they forgot `pnpm install`. Costs minutes; the
// preflight costs milliseconds.
// ---------------------------------------------------------------------------

/**
 * @typedef {{ name: string, ok: boolean, message: string, fix?: string }} PreflightCheck
 */

/** @returns {Promise<PreflightCheck[]>} */
async function preflight() {
  const checks = []

  // 1. node_modules present.
  const hasNodeModules = existsSync(join(REPO_ROOT, 'node_modules'))
  checks.push({
    name: 'dependencies installed',
    ok: hasNodeModules,
    message: hasNodeModules ? 'node_modules/ present' : 'node_modules/ missing — gates will fail',
    fix: 'pnpm install --frozen-lockfile',
  })

  // 2. Playwright browser binary present. The dry-run output lists only
  // what *would* be installed — so a line starting with "Chromium "
  // (the full browser, distinct from "Chrome Headless Shell") means
  // chromium isn't installed yet. Absence of that line means we're
  // good. Headless-shell missing is fine — our config runs headed.
  if (hasNodeModules) {
    const dryRun = await runCommandCapture('pnpm', [
      'exec',
      'playwright',
      'install',
      '--dry-run',
      'chromium',
    ])
    const text = dryRun.stdout + dryRun.stderr
    const missing = /^Chromium\s+\d/m.test(text)
    checks.push({
      name: 'Playwright Chromium installed',
      ok: !missing,
      message: missing
        ? 'Playwright Chromium browser binary missing — matrix will fail per cell'
        : 'chromium binary present',
      fix: 'pnpm e2e:install',
    })
  } else {
    checks.push({
      name: 'Playwright Chromium installed',
      ok: false,
      message: 'skipped — node_modules missing',
      fix: 'pnpm install && pnpm e2e:install',
    })
  }

  // 3. Dev server port is free (or the existing dev server is reusable —
  // Playwright's webServer block handles that case explicitly).
  const port = Number(process.env.E2E_PORT ?? 5391)
  const portFree = await isPortFree(port)
  checks.push({
    name: `dev server port ${port} available`,
    ok: portFree,
    message: portFree
      ? `port ${port} is free`
      : `port ${port} is occupied — Playwright will reuse the existing server, but if it isn't the Hoverbike dev server, specs may fail in strange ways`,
    fix: `kill the process holding port ${port}, or set E2E_PORT to a free port`,
  })

  return checks
}

/** @param {PreflightCheck[]} checks */
function logPreflight(checks) {
  console.log('▶ Preflight')
  for (const c of checks) {
    const glyph = c.ok ? '✅' : '⚠️ '
    console.log(`  ${glyph} ${c.name} — ${c.message}`)
    if (!c.ok && c.fix) {
      console.log(`     fix: ${c.fix}`)
    }
  }
  console.log('')
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => {
      srv.close(() => resolve(true))
    })
    srv.listen(port, '127.0.0.1')
  })
}

const steps = []
let firstFailureExitCode = 0

async function runStep({ id, label, command, args, env = {}, gate = true, optional = false }) {
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  console.log(`\n▶ ${label}`)
  const stdoutLog = join(REPORT_DIR, `${id}.log`)
  const result = await runCommand(command, args, { ...process.env, ...env }, stdoutLog)
  const durationMs = Date.now() - t0
  const status = result.code === 0 ? 'pass' : optional ? 'skip' : 'fail'
  if (status === 'fail' && firstFailureExitCode === 0) {
    firstFailureExitCode = result.code || 1
  }
  steps.push({
    id,
    label,
    command: `${command} ${args.join(' ')}`,
    status,
    durationMs,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.code,
    logPath: stdoutLog,
    /** Whether failure of this step gates shippability. Optional steps
     *  (e.g. blender lint when BLENDER_EXE is missing) are surfaced in
     *  the report but don't fail the run. */
    gate,
  })
  return status
}

// On Windows, `pnpm` (and most node-toolchain bins) is a `.cmd` shim.
// `child_process.spawn` without `shell: true` won't find it; Node 24+
// goes further and outright refuses `.bat`/`.cmd` without `shell: true`
// (CVE-2024-27980 mitigation). So shell mode is mandatory on Windows.
//
// Node 22+ also surfaces DEP0190 about "args under shell:true not
// escaped" — that's a real caveat for callers with untrusted args,
// but every arg this orchestrator passes is a static string defined
// in package.json scripts. We accept the warning rather than ship a
// fragile manual quoter.
const SPAWN_SHELL = process.platform === 'win32'

function runCommand(command, args, env, logPath) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: SPAWN_SHELL,
    })
    const chunks = []
    child.stdout.on('data', (d) => {
      process.stdout.write(d)
      chunks.push(d)
    })
    child.stderr.on('data', (d) => {
      process.stderr.write(d)
      chunks.push(d)
    })
    child.on('close', (code) => {
      try {
        writeFileSync(logPath, Buffer.concat(chunks))
      } catch {
        // ignore — the report still has exit code + duration
      }
      resolve({ code: code ?? 1 })
    })
    child.on('error', (err) => {
      try {
        writeFileSync(logPath, Buffer.from(`spawn error: ${err.message}\n`))
      } catch {}
      resolve({ code: 127 })
    })
  })
}

/** Like `runCommand` but captures stdout/stderr for in-process inspection
 *  (preflight uses this for `playwright install --dry-run`). No file
 *  artifact — the caller decides what to do with the strings. */
function runCommandCapture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: SPAWN_SHELL,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.on('error', () => resolve({ code: 127, stdout, stderr }))
  })
}

const runStarted = new Date().toISOString()
const tRunStart = Date.now()

const preflightChecks = await preflight()
logPreflight(preflightChecks)

if (runDoctor) {
  // Doctor mode: report preflight + exit. No gates run.
  const allOk = preflightChecks.every((c) => c.ok)
  console.log(allOk ? '✅ preflight clean' : '⚠️  preflight found issues — see fixes above')
  process.exit(allOk ? 0 : 1)
}

if (!skipTypecheck) {
  const s = await runStep({
    id: 'typecheck',
    label: 'tsc --noEmit',
    command: 'pnpm',
    args: ['typecheck'],
  })
  if (s === 'fail' && !keepGoing) await finish()
}

if (!skipLint) {
  const s = await runStep({
    id: 'lint',
    label: 'biome check',
    command: 'pnpm',
    args: ['lint'],
  })
  if (s === 'fail' && !keepGoing) await finish()
}

if (!skipUnit) {
  const s = await runStep({
    id: 'unit',
    label: 'vitest run',
    command: 'pnpm',
    args: ['test'],
  })
  if (s === 'fail' && !keepGoing) await finish()
}

if (runTrackLint) {
  // Opt-in only — `gen:tracks:validate` needs BLENDER_EXE or Blender on
  // PATH, which CI runners don't ship. Default behaviour leaves it out
  // so the report isn't permanently cluttered with a skip row.
  const hasBlender = !!process.env.BLENDER_EXE
  const s = await runStep({
    id: 'track-lint',
    label: 'pnpm gen:tracks:validate',
    command: 'pnpm',
    args: ['gen:tracks:validate'],
    optional: !hasBlender,
    gate: false, // never block shippability on track lint — author-only
  })
  if (s === 'fail' && !keepGoing) await finish()
}

if (!skipMatrix) {
  const s = await runStep({
    id: 'matrix',
    label: 'QA track × bike matrix',
    command: 'pnpm',
    args: ['exec', 'playwright', 'test', 'tests/e2e/qa-track-matrix.spec.ts', '--reporter=line'],
    env: { QA_MATRIX: '1' },
  })
  if (s === 'fail' && !keepGoing) await finish()
}

if (runSoak) {
  await runStep({
    id: 'soak',
    label: 'QA stability soak',
    command: 'pnpm',
    args: ['exec', 'playwright', 'test', 'tests/e2e/qa-soak.spec.ts', '--reporter=line'],
    env: { QA_SOAK: '1' },
  })
}

await finish()

async function finish() {
  const report = {
    schemaVersion: 1,
    runStartedAt: runStarted,
    runFinishedAt: new Date().toISOString(),
    runDurationMs: Date.now() - tRunStart,
    repoRoot: REPO_ROOT,
    preflight: preflightChecks,
    steps,
  }
  const jsonPath = join(REPORT_DIR, 'qa-report.json')
  const mdPath = join(REPORT_DIR, 'qa-report.md')
  writeFileSync(jsonPath, JSON.stringify(report, null, 2))
  writeFileSync(mdPath, renderMarkdown(report))
  console.log(`\n📄 QA report → ${mdPath}`)
  console.log(`📄 QA report (JSON) → ${jsonPath}`)
  // Emit a one-line summary so a CI grep can extract status at a glance.
  const totals = summariseTotals(steps)
  console.log(`QA SUMMARY pass=${totals.pass} fail=${totals.fail} skip=${totals.skip}`)
  process.exit(firstFailureExitCode)
}

function summariseTotals(stepList) {
  const t = { pass: 0, fail: 0, skip: 0 }
  for (const s of stepList) {
    t[s.status] = (t[s.status] ?? 0) + 1
  }
  return t
}
