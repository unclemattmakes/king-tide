#!/usr/bin/env node
/**
 * Generate visual contact sheets for every prop GLB under
 * `public/assets/props/`, so a later reader (human or a Claude session) can
 * eyeball "which asset is this?" from one image instead of loading + analysing
 * each GLB.
 *
 * Delegates to the gated Playwright spec `tests/e2e/gen-prop-sheets.spec.ts` —
 * wraps the env-var + project-pin dance so authors get a one-liner. Runs headed
 * Chromium so each prop renders on the real GPU through the same
 * `?propviewer=<id>&thumb=1` painterly-vinyl path the game ships, then composites
 * the tiles into per-folder sheets.
 *
 * A dedicated dev-server port (override with E2E_PORT) keeps this off whatever
 * is squatting the default 5391, so the captures use this clone's current code
 * (the `?thumb=1` mode added to the prop viewer).
 *
 * Output: `public/assets/props/_sheets/<group>[-<page>].jpg` + `README.md`.
 * Push to R2 afterwards with `pnpm assets:push`.
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const env = { ...process.env, PROP_SHEETS: '1', E2E_PORT: process.env.E2E_PORT ?? '5394' }
const cli = process.platform === 'win32' ? 'playwright.cmd' : 'playwright'
const result = spawnSync(
  cli,
  [
    'test',
    'tests/e2e/gen-prop-sheets.spec.ts',
    '--project=chromium',
    '--workers=1',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit', env, shell: process.platform === 'win32' },
)
process.exit(result.status ?? 1)
