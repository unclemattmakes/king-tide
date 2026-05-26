#!/usr/bin/env node
/**
 * Steam Deck / Linux build orchestrator.
 *
 * 1. Run `pnpm build` so `dist/` is fresh.
 * 2. Run `electron-builder --linux dir`, producing a self-contained
 *    (Chromium-bundled) game tree at `dist-electron/linux-unpacked/`.
 * 3. Bundle the Steam Linux Runtime survival kit into the tree: the launch
 *    wrapper (hoverbike-launch.sh) + libcups.so.2 (extra-lib/). See
 *    docs/desktop-builds.md "Steam Deck / Linux runtime gotchas".
 *
 * The `dir` target is what the Steam Linux depot ships — Steam copies the
 * tree and launches the wrapper, which strips the crashing Steam overlay and
 * adds the missing libs before exec'ing `hoverbike`. `pnpm steam:upload`
 * stages this tree; for a quick local sanity check run the binary directly
 * (`./dist-electron/linux-unpacked/hoverbike`).
 *
 * Pass-through flags reach electron-builder, e.g. `pnpm build:deck -- --publish never`.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`\n[build:deck] ${message}\n`)
  process.exit(1)
}

function info(message) {
  console.log(`[build:deck] ${message}`)
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

// ---- 2. electron-builder --linux dir --------------------------------------
const args = ['electron-builder', '--linux', 'dir', ...extraArgs]
info(`running: pnpm exec ${args.join(' ')}`)
const build = spawnSync('pnpm', ['exec', ...args], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (build.status !== 0) {
  fail(`electron-builder failed (exit ${build.status}).`)
}

// ---- 3. Bundle the Steam Linux Runtime survival kit -----------------------
const OUT = path.join(REPO_ROOT, 'dist-electron', 'linux-unpacked')
if (existsSync(OUT)) {
  bundleLinuxExtras(OUT)
}

info('done — game tree in dist-electron/linux-unpacked/ (launch: hoverbike-launch.sh).')

/**
 * Drop the launch wrapper + the libraries the Steam Linux Runtime omits into
 * the unpacked tree. Steam should launch `hoverbike-launch.sh`, which adds
 * extra-lib/ to LD_LIBRARY_PATH and strips the crashing Steam overlay.
 */
function bundleLinuxExtras(outDir) {
  const wrapperDst = path.join(outDir, 'hoverbike-launch.sh')
  copyFileSync(path.join(REPO_ROOT, 'electron', 'hoverbike-launch.sh'), wrapperDst)
  chmodSync(wrapperDst, 0o755)
  info('bundled launch wrapper → linux-unpacked/hoverbike-launch.sh')

  const libDir = path.join(outDir, 'extra-lib')
  mkdirSync(libDir, { recursive: true })
  // libcups.so.2: Electron's Chromium dlopen()s it, but the Steam Linux
  // Runtime (sniper) doesn't ship it. Copy the build host's copy in; the
  // wrapper puts extra-lib/ on LD_LIBRARY_PATH so it's found inside sniper.
  const cups = findHostLib('libcups.so.2')
  if (cups) {
    copyFileSync(cups, path.join(libDir, 'libcups.so.2'))
    info(`bundled ${cups} → linux-unpacked/extra-lib/libcups.so.2`)
  } else {
    info(
      'WARNING: libcups.so.2 not found on this host — the Steam Linux Runtime ' +
        'lacks it and Electron needs it, so the Deck build may not start.\n' +
        '          Install it and rerun (Debian/Ubuntu: `sudo apt install libcups2`).',
    )
  }
}

/** Resolve a system library path on the build host (x86-64). */
function findHostLib(name) {
  const ld = spawnSync('ldconfig', ['-p'], { encoding: 'utf8' })
  if (ld.status === 0) {
    for (const line of String(ld.stdout ?? '').split('\n')) {
      if (line.includes(name) && line.includes('x86-64')) {
        const m = line.match(/=>\s*(\/\S+)/)
        if (m) return m[1]
      }
    }
  }
  for (const p of [
    `/usr/lib/x86_64-linux-gnu/${name}`,
    `/lib/x86_64-linux-gnu/${name}`,
    `/usr/lib/${name}`,
  ]) {
    if (existsSync(p)) return p
  }
  return null
}
