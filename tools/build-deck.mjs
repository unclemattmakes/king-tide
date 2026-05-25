#!/usr/bin/env node
/**
 * Steam Deck build orchestrator.
 *
 * 1. Run the existing `pnpm build` so `dist/` is fresh.
 * 2. Probe for a working `cargo tauri` toolchain. If it's not installed,
 *    print a friendly install message + a link to the Tauri docs and
 *    exit non-zero. We deliberately don't try to install Rust on the
 *    user's behalf — that's their decision.
 * 3. If Tauri is available, run `cargo tauri build` against the
 *    Linux x86_64 target. Pass through any flags the caller supplied,
 *    so a future CI workflow can do `pnpm build:deck -- --features steam`.
 *
 * Outputs land in `src-tauri/target/release/bundle/appimage/`. The
 * Steam Partner upload step is intentionally not part of this script
 * (a separate workflow handles it once we have the SDK + an App ID).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TAURI_DIR = path.join(REPO_ROOT, 'src-tauri')

function fail(message) {
  console.error(`\n[build:deck] ${message}\n`)
  process.exit(1)
}

function info(message) {
  console.log(`[build:deck] ${message}`)
}

if (!existsSync(TAURI_DIR)) {
  fail(`src-tauri/ not found at ${TAURI_DIR}. Did you check out the full repo?`)
}

// Pass-through args (drop the first two — node + script).
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
[build:deck] cargo tauri is not available.

Install requirements:
  1. Rust       curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  2. Tauri CLI  cargo install tauri-cli --version "^2.0" --locked
  3. Linux libs (Ubuntu / SteamOS Desktop):
       sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \\
                        libayatana-appindicator3-dev librsvg2-dev

See docs/steam-deck.md and src-tauri/README.md for full setup.
`)
  process.exit(127)
}

const probeOut = String(probe.stdout ?? '').trim()
info(`cargo tauri found: ${probeOut || '(version unknown)'}`)

// ---- 3. cargo tauri build --------------------------------------------------
const target = process.platform === 'linux' ? 'x86_64-unknown-linux-gnu' : null
const args = ['tauri', 'build']
if (target) {
  args.push('--target', target)
}
args.push(...extraArgs)

info(`running: cargo ${args.join(' ')}`)
const tauriBuild = spawnSync('cargo', args, {
  cwd: TAURI_DIR,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (tauriBuild.status !== 0) {
  fail(`cargo tauri build failed (exit ${tauriBuild.status}).`)
}

// ---- 4. Strip bundled libwayland-* (Wayland EGL fix) ----------------------
// Tauri over-bundles libwayland-client.so.0; on Wayland hosts (the Steam Deck)
// it shadows the host's copy and the webview aborts with EGL_BAD_PARAMETER
// before the window opens. See tools/fix-appimage-wayland.sh.
if (target) {
  const appimageDir = path.join(TAURI_DIR, 'target', target, 'release', 'bundle', 'appimage')
  const images = existsSync(appimageDir)
    ? readdirSync(appimageDir).filter((f) => f.endsWith('.AppImage'))
    : []
  if (images.length === 0) {
    fail(`no .AppImage found in ${appimageDir} — did the bundle step run?`)
  }
  const script = path.join(REPO_ROOT, 'tools', 'fix-appimage-wayland.sh')
  for (const img of images) {
    info(`stripping bundled libwayland-* from ${img} …`)
    const strip = spawnSync('bash', [script, path.join(appimageDir, img)], { stdio: 'inherit' })
    if (strip.status !== 0) {
      fail(`libwayland strip failed for ${img} (exit ${strip.status}).`)
    }
  }
}

info('done — AppImage in src-tauri/target/<triple>/release/bundle/appimage/')
