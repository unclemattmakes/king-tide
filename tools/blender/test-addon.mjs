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
const TEST_SCRIPTS = [
  // Registration smoke — every HOVERBIKE_OT/PT class declared in source
  // is registered with Blender. Catches the "class skipped in register()"
  // foot-gun.
  path.join(SCRIPT_DIR, 'test_addon_registration.py'),
  // Lazy-import resolution — every `from .X import Y` inside the addon
  // resolves to an attribute that actually exists. Catches the "carve-out
  // moved a helper and forgot to re-export it" failure mode that bit the
  // 2026-05 Seattle map authoring session (5 phantom helpers across 5
  // modules; registration test passed, every operator blew up on first
  // click).
  path.join(SCRIPT_DIR, 'test_addon_imports.py'),
  // PropLine cross-language drift — the Python expansion port must reproduce
  // the JS golden so the Blender authoring preview spawns exactly what the
  // game does. (bpy-free; also runs under plain CPython via
  // `python tools/blender/test_propline_expand.py`.)
  path.join(SCRIPT_DIR, 'test_propline_expand.py'),
]

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
  for (const script of TEST_SCRIPTS) {
    if (!existsSync(script)) die(`test script not found: ${script}`, 2)
  }
  const blender = resolveBlender()
  log(`blender: ${blender}`)

  // No --factory-startup: that would skip user addons, including
  // ours. Each test relies on Blender loading the installed hoverbike
  // addon (see `pnpm install:blender-addon`) and exercising it.
  for (const script of TEST_SCRIPTS) {
    log(`test   : ${script}`)
    const child = spawnSync(blender, ['--background', '--python', script], {
      stdio: 'inherit',
    })
    if (child.error) die(`failed to spawn blender: ${child.error.message}`, 2)
    if ((child.status ?? 0) !== 0) {
      // Surface a clear summary even when stdio: 'inherit' already
      // streamed Blender's output; useful when CI logs are huge.
      die(`${path.basename(script)} exited ${child.status}`, child.status ?? 1)
    }
  }
  process.exit(0)
}

main()
