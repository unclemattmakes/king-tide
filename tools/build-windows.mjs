#!/usr/bin/env node
/**
 * Windows desktop build orchestrator.
 *
 * Produces a .exe + NSIS installer (and an .msi if WiX is installed).
 * Typically run on a Windows host or in CI on `windows-latest`.
 *
 * Cross-compiling Windows from Linux is technically possible via
 * mingw-w64 + the `x86_64-pc-windows-gnu` Rust target, but Tauri 2's
 * NSIS bundler invokes Windows-native tools that aren't trivial to
 * wine-emulate. We don't pretend to support that path — the script
 * prints a clear "use Windows or CI" message when run on Linux/macOS
 * and exits 2.
 *
 * 1. Run `pnpm build` so dist/ is fresh.
 * 2. Probe `cargo tauri --version`. Print install instructions and
 *    exit 127 if it's missing.
 * 3. Run `cargo tauri build --target x86_64-pc-windows-msvc` from
 *    src-tauri/.
 *
 * Outputs land in src-tauri/target/x86_64-pc-windows-msvc/release/
 * bundle/{nsis,msi}/. The CI workflow uploads both as artifacts and
 * attaches to GitHub Release on `v*` tag pushes.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TAURI_DIR = path.join(REPO_ROOT, 'src-tauri')

function fail(message, code = 1) {
  console.error(`\n[build:windows] ${message}\n`)
  process.exit(code)
}

function info(message) {
  console.log(`[build:windows] ${message}`)
}

if (!existsSync(TAURI_DIR)) {
  fail(`src-tauri/ not found at ${TAURI_DIR}. Did you check out the full repo?`)
}

// Allow Linux/macOS hosts to run the script if FORCE_CROSS=1 is set —
// for adventurous folks who've wired up mingw-w64 themselves. Default
// is to bail out with a pointer to CI.
if (process.platform !== 'win32' && process.env.FORCE_CROSS !== '1') {
  fail(
    `Windows builds need a Windows host (or CI on \`windows-latest\`).\n` +
      `Detected platform: ${process.platform}.\n\n` +
      `Use the CI workflow (.github/workflows/build-desktop.yml) — manual\n` +
      `dispatch builds both platforms and attaches the installer to a\n` +
      `GitHub Release on \`v*\` tag pushes.\n\n` +
      `To override and try cross-compiling anyway (mingw-w64 required,\n` +
      `NSIS bundling will likely fail): FORCE_CROSS=1 pnpm build:windows`,
    2,
  )
}

const extraArgs = process.argv.slice(2)

// ---- 1. Vite build → dist/ ------------------------------------------------
info('running web build (pnpm build) …')
const webBuild = spawnSync('pnpm', ['build'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (webBuild.status !== 0) {
  fail(`web build failed (exit ${webBuild.status}). Fix the Vite/tsc errors above and rerun.`)
}

// ---- 2. Probe cargo tauri --------------------------------------------------
info('probing cargo tauri toolchain …')
const probe = spawnSync('cargo', ['tauri', '--version'], {
  cwd: TAURI_DIR,
  stdio: 'pipe',
  shell: process.platform === 'win32',
})
if (probe.status !== 0) {
  console.error(`
[build:windows] cargo tauri is not available.

Install requirements (Windows host):
  1. Rust      https://www.rust-lang.org/tools/install (rustup-init.exe)
  2. Tauri CLI cargo install tauri-cli --version "^2.0" --locked
  3. WebView2  pre-installed on Windows 10/11; bootstrapper bundled.
  4. MSVC      Visual Studio Build Tools 2022 (C++ workload + Windows SDK).

See docs/desktop-builds.md and src-tauri/README.md for full setup.
`)
  process.exit(127)
}

const probeOut = String(probe.stdout ?? '').trim()
info(`cargo tauri found: ${probeOut || '(version unknown)'}`)

// ---- 3. cargo tauri build --------------------------------------------------
// MSVC on Windows host; GNU when forced cross-compile from Linux.
const target =
  process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-pc-windows-gnu'
const args = ['tauri', 'build', '--target', target, ...extraArgs]

info(`running: cargo ${args.join(' ')}`)
const tauriBuild = spawnSync('cargo', args, {
  cwd: TAURI_DIR,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (tauriBuild.status !== 0) {
  fail(`cargo tauri build failed (exit ${tauriBuild.status}).`)
}

info(`done — installers in src-tauri/target/${target}/release/bundle/{nsis,msi}/`)
