#!/usr/bin/env node
/**
 * Windows desktop build orchestrator.
 *
 * 1. Run `pnpm build` so `dist/` is fresh.
 * 2. Run electron-builder for Windows.
 *
 * On a Windows host (or CI on `windows-latest`) this builds the configured
 * `nsis` target — a standalone installer for GitHub releases — and emits the
 * `dist-electron/win-unpacked/` tree alongside it (what the Steam Windows
 * depot ships).
 *
 * On Linux/macOS (e.g. WSL) it builds the `dir` target only: enough to
 * produce the Steam Windows tree, and it skips the NSIS installer, which
 * needs Windows-native tooling. electron-builder shells out to `wine` to
 * stamp the .exe icon even for `dir`, so a `wine` install is required on
 * non-Windows hosts; the script warns if it's missing but still defers to
 * electron-builder's own error for the authoritative failure.
 *
 * Pass-through flags reach electron-builder, e.g. `pnpm build:windows -- --publish never`.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fail(message, code = 1) {
  console.error(`\n[build:windows] ${message}\n`)
  process.exit(code)
}

function info(message) {
  console.log(`[build:windows] ${message}`)
}

const onWindows = process.platform === 'win32'
const extraArgs = process.argv.slice(2)

if (!onWindows) {
  const wine = spawnSync('wine', ['--version'], { stdio: 'pipe' })
  if (wine.status !== 0) {
    info(
      'WARNING: `wine` not found. electron-builder needs it to stamp the Windows .exe ' +
        'on non-Windows hosts. Install wine, or build on a Windows host / CI for the ' +
        'full NSIS installer. Continuing — electron-builder will error if wine is required.',
    )
  }
}

// ---- 1. Vite build → dist/ ------------------------------------------------
info('running web build (pnpm build) …')
const webBuild = spawnSync('pnpm', ['build'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  shell: onWindows,
})
if (webBuild.status !== 0) {
  fail(`web build failed (exit ${webBuild.status}). Fix the Vite/tsc errors above and rerun.`)
}

// ---- 2. electron-builder --win --------------------------------------------
// Windows host: build the configured installer (nsis). Elsewhere: just the
// unpacked tree for the Steam depot — NSIS needs a Windows host / CI.
const target = onWindows ? ['--win'] : ['--win', 'dir']
const args = ['electron-builder', ...target, ...extraArgs]
info(`running: pnpm exec ${args.join(' ')}`)
const build = spawnSync('pnpm', ['exec', ...args], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  shell: onWindows,
})
if (build.status !== 0) {
  fail(`electron-builder failed (exit ${build.status}).`)
}

info(
  onWindows
    ? 'done — installer in dist-electron/ (*-setup.exe); game tree in dist-electron/win-unpacked/.'
    : 'done — game tree in dist-electron/win-unpacked/ (no NSIS installer on non-Windows hosts).',
)
