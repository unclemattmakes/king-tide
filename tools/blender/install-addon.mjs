#!/usr/bin/env node
/**
 * Symlink (or copy) the in-repo Hoverbike addon into Blender's user
 * scripts dir so Blender always loads the working-tree version.
 *
 * Usage:
 *   pnpm install:blender-addon            # default: symlink, fall back to copy
 *   pnpm install:blender-addon --copy     # force copy
 *   pnpm install:blender-addon --dry-run  # print what would happen
 *
 * Without this, Blender loads whatever was last manually copied into
 * %APPDATA%/Blender/<version>/scripts/addons/ — which drifts silently
 * from the repo. The exact failure mode that motivated this script:
 * sub-panels disappeared from the N-panel because the installed addon
 * was a few days behind a commit that added them.
 *
 * The symlink path is the recommended one (edits in the repo are
 * picked up on Blender's next "Reload Scripts" — F3 → search → Reload
 * Scripts — or addon disable/enable, no re-install required). It needs
 * Developer Mode on Windows for non-admin symlinks (Settings → For
 * developers → Developer Mode); the script falls back to a copy and
 * prints what to do if symlink fails.
 *
 * Existing addon files at the target are backed up to `.bak` (only on
 * first run — subsequent runs leave the .bak alone).
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { homedir, platform } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(__filename)
// The addon is a package directory now (was a single .py file before
// the package refactor). Symlink/copy the whole tree.
const SOURCE = path.join(SCRIPT_DIR, 'hoverbike_addon')
const ADDON_NAME = 'hoverbike_addon'

const args = new Set(process.argv.slice(2))
const FORCE_COPY = args.has('--copy')
const DRY_RUN = args.has('--dry-run')

function log(msg) {
  console.log(`[install-addon] ${msg}`)
}

function die(msg, code = 1) {
  console.error(`[install-addon] ${msg}`)
  process.exit(code)
}

// ────────────────────────────────────────────────────────────────────
// Blender executable + version
// ────────────────────────────────────────────────────────────────────

/** Mirror of run.mjs's resolveBlender so this script stays standalone. */
function resolveBlender() {
  const explicit = process.env.BLENDER_EXE
  if (explicit) {
    if (!existsSync(explicit)) die(`BLENDER_EXE=${explicit} does not exist`, 2)
    return explicit
  }
  const probe = spawnSync(platform() === 'win32' ? 'where' : 'which', ['blender'], {
    encoding: 'utf8',
  })
  if (probe.status === 0 && probe.stdout.trim()) {
    return probe.stdout.trim().split(/\r?\n/)[0]
  }
  const candidates = []
  if (platform() === 'win32') {
    for (const v of ['5.3', '5.2', '5.1', '5.0', '4.5', '4.4']) {
      candidates.push(`C:\\Program Files\\Blender Foundation\\Blender ${v}\\blender.exe`)
    }
  } else if (platform() === 'darwin') {
    candidates.push('/Applications/Blender.app/Contents/MacOS/Blender')
  } else {
    candidates.push('/usr/bin/blender', '/usr/local/bin/blender', '/opt/blender/blender')
  }
  for (const c of candidates) if (existsSync(c)) return c
  die('could not locate Blender — set BLENDER_EXE or install per docs/asset-pipeline-guide.md', 2)
}

/** Parse "Blender X.Y.Z" from `blender --version` and return "X.Y". */
function detectBlenderVersion(blenderExe) {
  const out = spawnSync(blenderExe, ['--version'], { encoding: 'utf8' })
  if (out.status !== 0) die(`failed to run ${blenderExe} --version`, 2)
  const m = out.stdout.match(/Blender\s+(\d+)\.(\d+)/)
  if (!m) die(`could not parse version from: ${out.stdout.split('\n')[0]}`, 2)
  return `${m[1]}.${m[2]}`
}

// ────────────────────────────────────────────────────────────────────
// User addons dir
// ────────────────────────────────────────────────────────────────────

function userAddonsDir(version) {
  const home = homedir()
  if (platform() === 'win32') {
    const appdata = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    return path.join(appdata, 'Blender Foundation', 'Blender', version, 'scripts', 'addons')
  }
  if (platform() === 'darwin') {
    return path.join(
      home,
      'Library',
      'Application Support',
      'Blender',
      version,
      'scripts',
      'addons',
    )
  }
  // linux / *bsd
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config')
  return path.join(xdg, 'blender', version, 'scripts', 'addons')
}

// ────────────────────────────────────────────────────────────────────
// Install logic
// ────────────────────────────────────────────────────────────────────

function isSymlinkTo(linkPath, expectedTarget) {
  try {
    if (!existsSync(linkPath)) return false
    const ls = lstatSync(linkPath)
    if (!ls.isSymbolicLink()) return false
    const actualTarget = readlinkSync(linkPath)
    return path.resolve(path.dirname(linkPath), actualTarget) === path.resolve(expectedTarget)
  } catch {
    return false
  }
}

/** Remove a path that's either a file, a directory, or a symlink.
 * Handles both leaves of the install target (the modern package dir
 * AND the legacy single-file install). */
function removeAny(p) {
  rmSync(p, { recursive: true, force: true })
}

function backupExisting(target) {
  if (!existsSync(target)) return null
  const ls = lstatSync(target)
  if (ls.isSymbolicLink()) {
    // existing symlink — just remove it; no backup needed
    if (DRY_RUN) {
      log(`would remove existing symlink at ${target}`)
    } else {
      removeAny(target)
    }
    return null
  }
  const backup = `${target}.bak`
  if (existsSync(backup)) {
    log(`backup already exists at ${backup} — leaving it alone, removing current install`)
    if (!DRY_RUN) removeAny(target)
    return backup
  }
  if (DRY_RUN) {
    log(`would back up ${target} → ${backup}`)
  } else {
    renameSync(target, backup)
    log(`backed up existing install → ${backup}`)
  }
  return backup
}

/** Remove the pre-package single-file install if it's still hanging
 * around from before the package refactor. Backs it up first. */
function cleanupLegacyFileInstall(dir) {
  const legacyTarget = path.join(dir, `${ADDON_NAME}.py`)
  // lstatSync (not existsSync) so we also detect a dangling symlink
  // — common after the package refactor, since the old install
  // pointed at hoverbike_addon.py which is now hoverbike_addon/_legacy.py.
  let ls
  try {
    ls = lstatSync(legacyTarget)
  } catch {
    return
  }
  log(`detected legacy single-file install at ${legacyTarget}`)
  if (ls.isSymbolicLink()) {
    if (DRY_RUN) {
      log('would remove the legacy symlink')
    } else {
      removeAny(legacyTarget)
      log('removed legacy symlink')
    }
    return
  }
  const backup = `${legacyTarget}.bak`
  if (existsSync(backup)) {
    log(`legacy backup already at ${backup} — removing the orphaned file`)
    if (!DRY_RUN) removeAny(legacyTarget)
    return
  }
  if (DRY_RUN) {
    log(`would back up legacy file → ${backup}`)
  } else {
    renameSync(legacyTarget, backup)
    log(`backed up legacy file → ${backup}`)
  }
}

function main() {
  if (!existsSync(SOURCE)) die(`source addon not found at ${SOURCE}`, 2)

  const blender = resolveBlender()
  const version = detectBlenderVersion(blender)
  const dir = userAddonsDir(version)
  const target = path.join(dir, ADDON_NAME)

  log(`source : ${SOURCE}`)
  log(`blender: ${blender} (${version})`)
  log(`target : ${target}`)

  if (isSymlinkTo(target, SOURCE)) {
    cleanupLegacyFileInstall(dir)
    log('already symlinked to this source — nothing to do')
    return
  }

  if (DRY_RUN) {
    cleanupLegacyFileInstall(dir)
    backupExisting(target)
    log(`would ${FORCE_COPY ? 'copy' : 'symlink'} source → target`)
    return
  }

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    log(`created addons dir: ${dir}`)
  }

  cleanupLegacyFileInstall(dir)
  backupExisting(target)

  if (FORCE_COPY) {
    cpSync(SOURCE, target, { recursive: true })
    log('copied (--copy requested)')
    printPostInstall(target)
    return
  }

  // Try symlink first; fall back to copy on EPERM (Windows w/o Developer Mode).
  try {
    // 'dir' type matters on Windows — directory symlinks use a different
    // ReparsePoint kind than file symlinks. Harmless elsewhere.
    symlinkSync(SOURCE, target, 'dir')
    log('symlinked ✓ — edits in the repo are picked up by Blender on next reload')
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      log(`symlink failed (${err.code}) — falling back to copy`)
      cpSync(SOURCE, target, { recursive: true })
      log('copied ✓')
      if (platform() === 'win32') {
        log('')
        log('Tip: enable Windows "Developer Mode" to allow non-admin symlinks:')
        log('  Settings → For developers → Developer Mode → On')
        log('Then re-run `pnpm install:blender-addon` to convert the copy to a symlink.')
      }
    } else {
      throw err
    }
  }

  printPostInstall(target)
}

function printPostInstall(target) {
  log('')
  log(`installed at: ${target}`)
  log('')
  log('Next steps in Blender (one-time, if not already enabled):')
  log('  Edit → Preferences → Add-ons → enable "Hoverbike: Export to Game"')
  log('')
  log('After an addon code change, reload it without restarting Blender:')
  log('  F3 → "Reload Scripts"   (or disable+enable in Preferences)')
}

main()
