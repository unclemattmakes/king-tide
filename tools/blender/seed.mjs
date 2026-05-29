#!/usr/bin/env node
/**
 * Cross-platform invoker for one-shot Blender seed scripts.
 *
 * Usage:
 *   node tools/blender/seed.mjs <script-name>.py
 *   pnpm seed:landmarks-library
 *
 * Runs the given Python file inside a background Blender process and
 * propagates its exit code. Same Blender-resolution logic as
 * test-addon.mjs (env var first, PATH probe second, well-known
 * Windows / macOS / Linux paths third).
 *
 * Seed scripts ARE nuke-and-pave on the target .blend they own — they
 * overwrite hand-tuned tweaks. The npm-script entry point exists for
 * discoverability + CI convenience, not as a thing to run regularly.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(__filename)

function log(msg) {
  console.log(`[seed] ${msg}`)
}

function die(msg, code = 1) {
  console.error(`[seed] ${msg}`)
  process.exit(code)
}

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

function main() {
  const scriptArg = process.argv[2]
  if (!scriptArg) die('usage: seed.mjs <script-name>.py', 2)
  // Resolve relative to tools/blender/ so the npm-script can be
  // terse (just the basename).
  const seedScript = path.isAbsolute(scriptArg) ? scriptArg : path.join(SCRIPT_DIR, scriptArg)
  if (!existsSync(seedScript)) die(`seed script not found: ${seedScript}`, 2)
  const blender = resolveBlender()
  log(`blender: ${blender}`)
  log(`seed   : ${seedScript}`)

  const child = spawnSync(blender, ['--background', '--python', seedScript], {
    stdio: 'inherit',
  })
  if (child.error) die(`failed to spawn blender: ${child.error.message}`, 2)
  process.exit(child.status ?? 0)
}

main()
