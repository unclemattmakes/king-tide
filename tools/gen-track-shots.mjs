#!/usr/bin/env node
/**
 * Capture in-engine screenshots of one or more tracks under autopilot.
 *
 * Wraps the gated Playwright spec `tests/e2e/gen-track-shots.spec.ts` so
 * authors (and Claude) get a one-liner instead of remembering the env
 * dance. Runs headed Chromium so the WebGPU render path is the real GPU,
 * not SwiftShader — the water/sky/grade read very differently under
 * software rasterisation.
 *
 * Usage:
 *   pnpm gen:track-shots                 # sandbar, defaults
 *   pnpm gen:track-shots the-maw         # one track
 *   pnpm gen:track-shots sandbar,the-maw # several
 *   pnpm gen:track-shots sandbar -- --headed=false   # pass extra flags
 *
 * Tune frame count / cadence via TRACK_SHOTS_COUNT / TRACK_SHOTS_INTERVAL
 * / TRACK_SHOTS_WARMUP. Output: test-results/track-shots/<id>/NN.jpg.
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const args = process.argv.slice(2)
const env = { ...process.env, TRACK_SHOTS: '1' }

// First positional (not a flag) is the comma-separated track id list.
let passthrough = args
if (args[0] && !args[0].startsWith('-')) {
  env.TRACK_SHOTS_IDS = args[0]
  passthrough = args.slice(1)
}

const cli = process.platform === 'win32' ? 'playwright.cmd' : 'playwright'
const result = spawnSync(
  cli,
  [
    'test',
    'tests/e2e/gen-track-shots.spec.ts',
    '--project=chromium',
    '--workers=1',
    ...passthrough,
  ],
  { stdio: 'inherit', env, shell: process.platform === 'win32' },
)
process.exit(result.status ?? 1)
