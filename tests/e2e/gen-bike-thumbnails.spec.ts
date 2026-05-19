/**
 * Bike-select thumbnail capture — Phase F of `docs/v1-asset-pipeline-plan.md`.
 *
 * Gated on `BIKE_THUMBS=1` so day-to-day `pnpm e2e` stays fast. Author
 * invokes via `pnpm gen:bike-thumbs`, which sets the env + targets only
 * this spec. The captured JPGs land in `public/assets/bikes/<id>-thumb.jpg`
 * and ship into the bike-select carousel via the asset manifest.
 *
 * One screenshot per bike, locked turntable angle (the bike viewer's
 * default camera at (2.5, 1.4, 2.5) looking at (0, 0.3, 0) — same
 * three-quarter view authors check the chassis at in
 * `?viewer=<id>`). 480 × 270 (16:9, half-tile size) — matches the
 * track-thumb tile aspect so the bike-select UI can mix the two
 * without reshuffling layout.
 *
 * Why a Playwright spec rather than a Blender headless render: the
 * runtime materials read GLB livery + apply the variant tint at clone
 * time. Rendering the chassis through the same three.js path the game
 * uses guarantees the thumb matches what the player sees mid-race.
 * Blender wouldn't reproduce the runtime tint pipeline.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { BIKE_VARIANTS } from '../../src/game/bikes/variants'

const TILE_WIDTH = 480
const TILE_HEIGHT = 270
const OUT_DIR = path.resolve(process.cwd(), 'public', 'assets', 'bikes')

test.describe('bike thumbnail capture', () => {
  test.skip(
    process.env.BIKE_THUMBS !== '1',
    'gated on BIKE_THUMBS=1 — invoke via pnpm gen:bike-thumbs',
  )

  test.beforeAll(() => {
    mkdirSync(OUT_DIR, { recursive: true })
  })

  for (const variant of Object.values(BIKE_VARIANTS)) {
    test(`${variant.id} thumb`, async ({ page }) => {
      await page.setViewportSize({ width: TILE_WIDTH, height: TILE_HEIGHT })
      // `?thumb=1` strips the reference grid + HUD chrome and tightens
      // the viewer camera so the chassis fills the tile. See the
      // `thumbMode` branch in `src/viewer/bike-viewer.ts`.
      await page.goto(`/?viewer=${variant.id}&thumb=1`)
      // Wait for the second-frame ready marker (see bike-viewer.ts) —
      // ensures materials + lighting have settled before capture.
      await page.waitForFunction(() => document.body.dataset.bikeViewerReady === '1', null, {
        timeout: 20_000,
      })

      // The viewer leaves index.html's `#hud` chips and the
      // `#loading-screen` overlay in place — `runEarlyModeDispatch`
      // calls `hideLoadingScreen()` but the fade-out transition can
      // still be mid-flight when bikeViewerReady fires. Force them
      // off-screen synchronously so the screenshot is just the bike.
      await page.evaluate(() => {
        for (const id of ['hud', 'loading-screen', 'menu', 'race-hud']) {
          const el = document.getElementById(id)
          if (el) el.style.display = 'none'
        }
      })

      const outPath = path.join(OUT_DIR, `${variant.id}-thumb.jpg`)
      await page.screenshot({
        path: outPath,
        type: 'jpeg',
        quality: 85,
        clip: { x: 0, y: 0, width: TILE_WIDTH, height: TILE_HEIGHT },
      })
      expect(outPath).toMatch(new RegExp(`${variant.id}-thumb\\.jpg$`))
    })
  }
})
