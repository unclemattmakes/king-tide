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
 *   4. `pnpm gen:tracks:validate` — Blender-side spec lint (best-effort:
 *      skipped if BLENDER_EXE isn't set, since CI Linux runners don't
 *      have Blender on PATH)
 *   5. `QA_MATRIX=1 pnpm e2e tests/e2e/qa-track-matrix.spec.ts`
 *   6. (--soak) `QA_SOAK=1 pnpm e2e tests/e2e/qa-soak.spec.ts`
 *
 * Flags:
 *   --soak           include the stability soak (omit by default; CI
 *                    nightly job enables it)
 *   --skip-typecheck dev iteration shortcut (e.g. when you just want
 *                    to re-run the matrix)
 *   --skip-lint
 *   --skip-unit
 *   --skip-track-lint
 *   --skip-matrix
 *   --keep-going     run every step even after one fails (default;
 *                    only flipped off via --no-keep-going)
 *
 * Environment:
 *   E2E_BROWSERS     forwarded as-is to Playwright (chromium by default)
 *   QA_REPORT_DIR    override the output directory (default qa-report/)
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderMarkdown } from './report.mjs'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const REPORT_DIR = process.env.QA_REPORT_DIR ?? join(REPO_ROOT, 'qa-report')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)

const runSoak = flag('--soak')
const skipTypecheck = flag('--skip-typecheck')
const skipLint = flag('--skip-lint')
const skipUnit = flag('--skip-unit')
const skipTrackLint = flag('--skip-track-lint')
const skipMatrix = flag('--skip-matrix')
const keepGoing = !flag('--no-keep-going')

mkdirSync(REPORT_DIR, { recursive: true })

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

function runCommand(command, args, env, logPath) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
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

const runStarted = new Date().toISOString()
const tRunStart = Date.now()

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

if (!skipTrackLint) {
  // The Blender-side lint requires BLENDER_EXE or a Blender on PATH. CI
  // Linux runners don't ship Blender by default; flag this step as
  // optional so a missing toolchain reports `skip` rather than `fail`.
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
