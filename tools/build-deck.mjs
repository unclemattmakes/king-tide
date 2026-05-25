#!/usr/bin/env node
/**
 * Steam Deck / Linux build orchestrator.
 *
 * 1. Run `pnpm build` so `dist/` is fresh.
 * 2. Run `electron-builder --linux dir`, producing a self-contained
 *    (Chromium-bundled) game tree at `dist-electron/linux-unpacked/`.
 *
 * The `dir` target is what the Steam Linux depot ships — Steam copies the
 * tree and launches the `hoverbike` binary directly, so there's no AppImage
 * to self-mount inside the Steam Linux Runtime container. `pnpm steam:upload`
 * stages this tree; for a quick local sanity check run the binary directly
 * (`./dist-electron/linux-unpacked/hoverbike`).
 *
 * Pass-through flags reach electron-builder, e.g. `pnpm build:deck -- --publish never`.
 */
import { spawnSync } from 'node:child_process'
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

info('done — game tree in dist-electron/linux-unpacked/ (binary: hoverbike).')
