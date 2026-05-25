#!/usr/bin/env node
/**
 * SteamPipe upload orchestrator — Hoverbike.
 *
 * Renders steam/*.vdf templates from env vars, stages the desktop
 * bundles into steam/content/<platform>/, and invokes
 * `steamcmd +run_app_build` to push to Steam.
 *
 * Designed to be runnable both from CI (release-steam.yml) and from
 * a dev box once the App ID + build credentials are in place.
 *
 * Usage:
 *   pnpm steam:upload                       # upload both platforms
 *   pnpm steam:upload -- --platform=linux   # one platform at a time
 *   pnpm steam:upload -- --dry-run          # stage + render, skip steamcmd
 *   STEAM_PREVIEW=true pnpm steam:upload    # validate via SteamPipe preview
 *
 * Required env vars:
 *   STEAM_APPID            numeric Steam App ID
 *   STEAM_DEPOT_LINUX      Linux depot ID
 *   STEAM_DEPOT_WINDOWS    Windows depot ID
 *   STEAM_USERNAME         build account username
 *   STEAM_PASSWORD         OR  a pre-baked config.vdf at steam/config.vdf
 *                          (the latter is how CI runs without leaking 2FA codes)
 *
 * Optional env vars:
 *   STEAM_CMD              path to steamcmd binary (default: `steamcmd` on PATH
 *                          or steam/steamcmd/steamcmd[.exe|.sh])
 *   STEAM_PREVIEW          "true" for a SteamPipe dry-run (no upload)
 *   STEAM_SET_LIVE         branch to push live (e.g. "beta"); default empty
 *   BUILD_DESCRIPTION      free-form label; default `<short-sha> @ <iso-date>`
 *   LINUX_BUNDLE_DIR       override Linux game-tree dir (default dist-electron/linux-unpacked)
 *   WINDOWS_BUNDLE_DIR     override Windows game-tree dir (default dist-electron/win-unpacked)
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STEAM_DIR = path.join(REPO_ROOT, 'steam')
const CONTENT_DIR = path.join(STEAM_DIR, 'content')
const RENDERED_DIR = path.join(STEAM_DIR, '.rendered')
const OUTPUT_DIR = path.join(STEAM_DIR, 'output')

const ARGS = parseArgs(process.argv.slice(2))

function parseArgs(argv) {
  const out = { platform: 'both', dryRun: false }
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true
    else if (a.startsWith('--platform=')) out.platform = a.slice('--platform='.length)
    else if (a === '-h' || a === '--help') {
      console.log(
        readFileSync(fileURLToPath(import.meta.url), 'utf8')
          .split('\n')
          .slice(1, 35)
          .map((l) => l.replace(/^ \*\s?/, ''))
          .join('\n'),
      )
      process.exit(0)
    } else {
      fail(`unknown arg: ${a}`)
    }
  }
  if (!['linux', 'windows', 'both'].includes(out.platform)) {
    fail(`--platform must be linux | windows | both (got ${out.platform})`)
  }
  return out
}

function fail(msg, code = 1) {
  console.error(`\n[steam:upload] ${msg}\n`)
  process.exit(code)
}
function info(msg) {
  console.log(`[steam:upload] ${msg}`)
}

// ---- 1. Validate env -------------------------------------------------------

const env = process.env
const wantLinux = ARGS.platform === 'both' || ARGS.platform === 'linux'
const wantWindows = ARGS.platform === 'both' || ARGS.platform === 'windows'

// Per-platform env: only require the IDs we're actually going to use.
// Lets you ship Windows-only without ever provisioning a Linux depot.
const requiredCore = ['STEAM_APPID']
if (wantLinux) requiredCore.push('STEAM_DEPOT_LINUX')
if (wantWindows) requiredCore.push('STEAM_DEPOT_WINDOWS')

const missing = requiredCore.filter((k) => !env[k])
if (missing.length) {
  fail(
    `missing required env var(s): ${missing.join(', ')}\n` +
      `Set these from the Steamworks Partner backend, then re-run.\n` +
      `See steam/README.md for the full env-var reference.`,
  )
}

// Steam App / depot IDs are all-digit numbers. Catch placeholder
// strings (e.g. `<your app id>`) up front rather than letting
// steamcmd reject them with a less-obvious error.
for (const k of requiredCore) {
  if (!/^\d+$/.test(env[k])) {
    fail(
      `${k}="${env[k]}" is not a numeric ID.\n` +
        `Steam App + depot IDs are all-digit numbers from the\n` +
        `Steamworks Partner backend. Replace the placeholder string.`,
    )
  }
}

const appId = env.STEAM_APPID
const depotLinux = env.STEAM_DEPOT_LINUX
const depotWindows = env.STEAM_DEPOT_WINDOWS
const setLive = env.STEAM_SET_LIVE ?? ''
const preview = env.STEAM_PREVIEW === 'true' ? '1' : '0'
const buildDesc = env.BUILD_DESCRIPTION ?? `${shortShaOrUnknown()} @ ${new Date().toISOString()}`

function shortShaOrUnknown() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT })
  if (r.status !== 0) return 'unknown'
  return String(r.stdout ?? '').trim() || 'unknown'
}

// ---- 2. Locate bundles ------------------------------------------------------
//
// Both platforms ship an electron-builder unpacked tree (Chromium bundled).
// Steam copies the tree wholesale and launches the binary directly, so
// there's no AppImage / NSIS installer in the loop.

const ELECTRON_LINUX_DIR = path.join(REPO_ROOT, 'dist-electron', 'linux-unpacked')
const ELECTRON_WINDOWS_DIR = path.join(REPO_ROOT, 'dist-electron', 'win-unpacked')

function resolveLinuxTree() {
  const dir = env.LINUX_BUNDLE_DIR || ELECTRON_LINUX_DIR
  if (!existsSync(dir)) {
    fail(
      `Linux game tree not found: ${dir}\n` +
        `Run \`pnpm build:deck\` first, or set LINUX_BUNDLE_DIR to an unpacked tree.`,
    )
  }
  return dir
}

function resolveWindowsTree() {
  const dir = env.WINDOWS_BUNDLE_DIR || ELECTRON_WINDOWS_DIR
  if (!existsSync(dir)) {
    fail(
      `Windows game tree not found: ${dir}\n` +
        `Run \`pnpm build:windows\` first, or set WINDOWS_BUNDLE_DIR to an unpacked tree.`,
    )
  }
  return dir
}

// ---- 3. Stage content ------------------------------------------------------

rmSync(CONTENT_DIR, { recursive: true, force: true })
mkdirSync(CONTENT_DIR, { recursive: true })

if (ARGS.platform === 'linux' || ARGS.platform === 'both') {
  const linuxStage = path.join(CONTENT_DIR, 'linux')
  mkdirSync(linuxStage, { recursive: true })
  const srcDir = resolveLinuxTree()
  info(
    `staging Linux:  ${path.relative(REPO_ROOT, srcDir)} → ${path.relative(REPO_ROOT, linuxStage)}`,
  )
  cpSync(srcDir, linuxStage, { recursive: true })
}

if (ARGS.platform === 'windows' || ARGS.platform === 'both') {
  const windowsStage = path.join(CONTENT_DIR, 'windows')
  mkdirSync(windowsStage, { recursive: true })
  const srcDir = resolveWindowsTree()
  info(
    `staging Windows: ${path.relative(REPO_ROOT, srcDir)} → ${path.relative(REPO_ROOT, windowsStage)}`,
  )
  // electron-builder's win-unpacked is already a clean installed tree
  // (Chromium bundled, no runtime to bootstrap), so copy it wholesale.
  cpSync(srcDir, windowsStage, { recursive: true })
}

// ---- 4. Render VDFs --------------------------------------------------------

rmSync(RENDERED_DIR, { recursive: true, force: true })
mkdirSync(RENDERED_DIR, { recursive: true })

// Substitutions. Unused depot IDs get "0" as a placeholder; the
// matching line gets pruned out of app_build.vdf below so steamcmd
// never sees it.
//
// Paths are forced to forward slashes — steamcmd accepts them on
// Windows too, and avoids the VDF backslash-escaping headache.
const subs = {
  STEAM_APPID: appId,
  STEAM_DEPOT_LINUX: depotLinux ?? '0',
  STEAM_DEPOT_WINDOWS: depotWindows ?? '0',
  BUILD_DESCRIPTION: buildDesc,
  SET_LIVE: setLive,
  STEAM_PREVIEW: preview,
  CONTENT_ROOT: CONTENT_DIR.replace(/\\/g, '/'),
  BUILD_OUTPUT: OUTPUT_DIR.replace(/\\/g, '/'),
}

const templates = ['app_build.vdf']
if (wantLinux) templates.push('depot_linux.vdf')
if (wantWindows) templates.push('depot_windows.vdf')

for (const fname of templates) {
  const tpl = readFileSync(path.join(STEAM_DIR, fname), 'utf8')
  const rendered = tpl.replace(/\$\{([A-Z_]+)\}/g, (_m, k) => {
    if (!(k in subs)) fail(`template ${fname} references unknown placeholder \${${k}}`)
    return subs[k]
  })
  writeFileSync(path.join(RENDERED_DIR, fname), rendered)
}
info(`rendered VDFs → ${path.relative(REPO_ROOT, RENDERED_DIR)}`)

// Prune unused depot entries from app_build.vdf. We match by the
// referenced depot_*.vdf filename rather than the ID, so this still
// works when the ID isn't set at all.
const appVdfPath = path.join(RENDERED_DIR, 'app_build.vdf')
let appVdf = readFileSync(appVdfPath, 'utf8')
let prunedAny = false
if (!wantLinux) {
  appVdf = appVdf.replace(/^\s*"[^"]*"\s+"depot_linux\.vdf"\s*\r?\n/m, '')
  prunedAny = true
}
if (!wantWindows) {
  appVdf = appVdf.replace(/^\s*"[^"]*"\s+"depot_windows\.vdf"\s*\r?\n/m, '')
  prunedAny = true
}
if (prunedAny) {
  writeFileSync(appVdfPath, appVdf)
  info(`pruned unused depot(s) from app_build.vdf (--platform=${ARGS.platform})`)
}

mkdirSync(OUTPUT_DIR, { recursive: true })

if (ARGS.dryRun) {
  info('dry-run: stage + render complete, skipping steamcmd.')
  process.exit(0)
}

// ---- 5. Locate steamcmd ----------------------------------------------------

function resolveSteamCmd() {
  if (env.STEAM_CMD) {
    if (!existsSync(env.STEAM_CMD)) fail(`STEAM_CMD not found: ${env.STEAM_CMD}`)
    return env.STEAM_CMD
  }
  const local =
    process.platform === 'win32'
      ? path.join(STEAM_DIR, 'steamcmd', 'steamcmd.exe')
      : path.join(STEAM_DIR, 'steamcmd', 'steamcmd.sh')
  if (existsSync(local)) return local
  // Last resort: trust PATH.
  return 'steamcmd'
}

const steamCmd = resolveSteamCmd()
info(`using steamcmd: ${steamCmd}`)

// ---- 6. Login + upload -----------------------------------------------------

const username = env.STEAM_USERNAME
if (!username) fail(`STEAM_USERNAME is required for upload (set it or use --dry-run)`)

// Login args: append STEAM_PASSWORD if set (CI path), otherwise just
// pass the username and trust steamcmd's own credential resolution.
// steamcmd caches Steam Guard tokens in its install dir after the
// first interactive login, so subsequent runs reuse them. CI also
// pre-stages a config.vdf + ssfn into steamcmd's cache location —
// see steam/README.md for the baking recipe.
//
// If steamcmd has no cache and no password, it'll prompt
// interactively (stdio is inherited from this process, so a Steam
// Guard prompt works fine in a local shell — it just hangs CI).
const loginArgs = env.STEAM_PASSWORD
  ? ['+login', username, env.STEAM_PASSWORD]
  : ['+login', username]
if (!env.STEAM_PASSWORD) {
  info(
    `no STEAM_PASSWORD set — trusting steamcmd's own credential cache (run \`steamcmd +login ${username}\` once interactively if you haven't)`,
  )
}

const renderedAppVdf = path.join(RENDERED_DIR, 'app_build.vdf')
const steamCmdArgs = [...loginArgs, '+run_app_build', renderedAppVdf, '+quit']

info(
  `running: ${steamCmd} ${loginArgs.join(' ').replace(env.STEAM_PASSWORD ?? '', '***')} +run_app_build ${path.relative(REPO_ROOT, renderedAppVdf)} +quit`,
)
const upload = spawnSync(steamCmd, steamCmdArgs, {
  cwd: STEAM_DIR,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (upload.status !== 0) {
  fail(
    `steamcmd exited ${upload.status}. Check ${path.relative(REPO_ROOT, OUTPUT_DIR)} for the build log.`,
  )
}

info('done — Steamworks Partner backend should now show the new build under "Builds".')
info(
  setLive
    ? `branch "${setLive}" was set live as part of this upload.`
    : 'no branch was set live; push the build live from the Steamworks web UI.',
)
