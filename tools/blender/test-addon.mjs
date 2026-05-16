#!/usr/bin/env node
/**
 * Cross-platform invoker for the addon registration smoke test.
 *
 * Usage:
 *   pnpm test:blender
 *
 * Runs ``test_addon_registration.py`` inside a background Blender and
 * propagates its exit code. CI calls this on the asset-pipeline
 * workflow (which already installs Blender), so any addon change that
 * silently breaks registration fails the PR.
 *
 * Re-implements the BLENDER_EXE resolver locally so this script stays
 * standalone. Worth extracting into `tools/blender/_blender-exe.mjs`
 * the next time someone adds a third caller.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(__filename)
const TEST_SCRIPT = path.join(SCRIPT_DIR, 'test_addon_registration.py')

function log(msg) {
  console.log(`[test-addon] ${msg}`)
}

function die(msg, code = 1) {
  console.error(`[test-addon] ${msg}`)
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
  if (!existsSync(TEST_SCRIPT)) die(`test script not found: ${TEST_SCRIPT}`, 2)
  const blender = resolveBlender()
  log(`blender: ${blender}`)
  log(`test   : ${TEST_SCRIPT}`)

  // No --factory-startup: that would skip user addons, including
  // ours. The test relies on Blender loading the installed hoverbike
  // addon (see `pnpm install:blender-addon`) and exercising its
  // register() path.
  const child = spawnSync(blender, ['--background', '--python', TEST_SCRIPT], {
    stdio: 'inherit',
  })
  if (child.error) die(`failed to spawn blender: ${child.error.message}`, 2)
  // Blender swallows the Python exit code by default; the test script
  // exits the Python process with sys.exit(N) which propagates via
  // Blender's exit code.
  process.exit(child.status ?? 0)
}

main()
