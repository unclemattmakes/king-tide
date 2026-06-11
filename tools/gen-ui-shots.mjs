#!/usr/bin/env node
/**
 * Capture the UI contact sheet — a screenshot of every player-facing UI
 * surface (title, menus, settings, race intro/countdown/HUD, pause).
 *
 * Wraps the gated Playwright spec `tests/e2e/gen-ui-shots.spec.ts` so a
 * skin pass gets a one-liner before/after workflow:
 *
 *   pnpm gen:ui-shots before          # → artifacts/ui-shots/before/
 *   ...edit the chrome...
 *   pnpm gen:ui-shots after           # → artifacts/ui-shots/after/
 *
 * First positional arg is the output label (default "current"). Always
 * runs --workers=1 — two parallel WebGPU boots can poison the water
 * render pipeline and black out the canvas. Headed Chromium, real GPU.
 * Pin a private dev-server port with E2E_PORT to avoid attaching to a
 * sibling session's server.
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const args = process.argv.slice(2)
const env = { ...process.env, UI_SHOTS: '1' }

let passthrough = args
if (args[0] && !args[0].startsWith('-')) {
  env.UI_SHOTS_LABEL = args[0]
  passthrough = args.slice(1)
}

const cli = process.platform === 'win32' ? 'playwright.cmd' : 'playwright'
const result = spawnSync(
  cli,
  ['test', 'tests/e2e/gen-ui-shots.spec.ts', '--project=chromium', '--workers=1', ...passthrough],
  { stdio: 'inherit', env, shell: process.platform === 'win32' },
)
process.exit(result.status ?? 1)
