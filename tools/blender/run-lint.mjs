#!/usr/bin/env node
/**
 * Cross-platform headless track-lint runner.
 *
 * Usage:
 *   pnpm gen:tracks:validate
 *
 * Walks every ``tracks-src/<id>.blend`` (skipping libraries +
 * ``.blend1`` backups), spawns a background Blender per .blend with
 * ``lint_track.py``, and aggregates exit codes. Returns non-zero if
 * any track failed.
 *
 * Patterned on ``test-addon.mjs`` (same BLENDER_EXE resolver, same
 * stdio-inherit invocation shape). One Blender startup per .blend is
 * fine — CI runs this once per PR, and ~12 tracks × ~2 s startup is
 * sub-half-minute end-to-end.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { platform } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(__filename)
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const TRACKS_SRC = path.join(REPO_ROOT, 'tracks-src')
const LINT_SCRIPT = path.join(SCRIPT_DIR, 'lint_track.py')

// Asset libraries that live under ``tracks-src/`` but aren't tracks.
// Linting them is meaningless (no spline, no start, no checkpoints) and
// would always produce ERRORs. Keep the list explicit so a future
// genuine track named ``calibration-foo`` doesn't get silently skipped.
const LIBRARY_FILES = new Set([
  'props-library.blend',
  'landmarks-library.blend',
  'calibration.blend',
])

function log(msg) {
  console.log(`[run-lint] ${msg}`)
}

function die(msg, code = 1) {
  console.error(`[run-lint] ${msg}`)
  process.exit(code)
}

/** Same shape as test-addon.mjs::resolveBlender. */
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
  return ''
}

/** Track .blends to lint. Skips backups and the asset libraries. */
function listTrackBlends() {
  if (!existsSync(TRACKS_SRC)) {
    die(`tracks-src not found at ${TRACKS_SRC}`, 2)
    return []
  }
  const out = []
  for (const name of readdirSync(TRACKS_SRC)) {
    if (!name.endsWith('.blend')) continue
    if (LIBRARY_FILES.has(name)) continue
    out.push(path.join(TRACKS_SRC, name))
  }
  out.sort()
  return out
}

function main() {
  if (!existsSync(LINT_SCRIPT)) die(`lint script not found: ${LINT_SCRIPT}`, 2)
  const blender = resolveBlender()
  const blends = listTrackBlends()
  if (blends.length === 0) {
    log('no track .blends to lint')
    process.exit(0)
  }
  log(`blender: ${blender}`)
  log(`linting ${blends.length} track(s)`)

  const failed = []
  for (const blend of blends) {
    const id = path.basename(blend, '.blend')
    log(`lint   : ${id}`)
    // ``--background <blend> --python <script>`` is the canonical
    // headless-with-blend invocation. Blender opens the .blend before
    // running our Python, so the lint script sees the same scene the
    // in-editor lint would.
    const child = spawnSync(blender, ['--background', blend, '--python', LINT_SCRIPT], {
      stdio: 'inherit',
    })
    if (child.error) die(`failed to spawn blender for ${id}: ${child.error.message}`, 2)
    if ((child.status ?? 0) !== 0) {
      failed.push(id)
    }
  }
  if (failed.length > 0) {
    console.error(`[run-lint] FAILED — ${failed.length} track(s): ${failed.join(', ')}`)
    process.exit(1)
  }
  log(`OK — all ${blends.length} track(s) passed`)
  process.exit(0)
}

main()
