#!/usr/bin/env node
/**
 * Generate bike-select thumbnails for every BIKE_VARIANTS entry.
 *
 * Delegates to the gated Playwright spec at
 * `tests/e2e/gen-bike-thumbnails.spec.ts` — wraps the env-var dance
 * + project selection so authors get a one-liner instead of "remember
 * to export BIKE_THUMBS=1 and pin to the chromium project so headed
 * Firefox doesn't try to open four windows".
 *
 * Phase F of `docs/v1-asset-pipeline-plan.md`. Runs headed Chromium so
 * the WebGPU/WebGL2 render path is real GPU, not SwiftShader — the
 * livery + glow read very differently under software rasterisation.
 *
 * Output: `public/assets/bikes/<id>-thumb.jpg` for each variant
 * (cruiser / racer / stunt / scout / sparrow), 480×270 JPG q85.
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const env = { ...process.env, BIKE_THUMBS: '1' }
const cli = process.platform === 'win32' ? 'playwright.cmd' : 'playwright'
const result = spawnSync(
  cli,
  [
    'test',
    'tests/e2e/gen-bike-thumbnails.spec.ts',
    '--project=chromium',
    '--workers=1',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit', env, shell: process.platform === 'win32' },
)
process.exit(result.status ?? 1)
