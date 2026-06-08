import { waitFullyBooted } from './helpers/boot'
import { expect, test } from './helpers/console-errors'
import { skipWebKitLinux } from './helpers/platform-skips'

/**
 * Regression: the Time Trial ghost went invisible against the water.
 *
 * Root cause — the ghost is the only bike rendered transparent with
 * `depthWrite=false` (a hologram), so it never lands in the depth buffer.
 * The center water surface is ALSO transparent but writes depth and is
 * near-opaque (alpha ~0.98), and it's camera-locked so its origin sits
 * right under the camera. In the back-to-front transparent sort, the
 * nearest object draws LAST — so the water reliably drew AFTER the ghost
 * and repainted every pixel where water was the backdrop, erasing the
 * ghost there. (Opaque bikes are immune: they're in the depth buffer, so
 * the water depth-tests against them.) The fix gives the ghost meshes a
 * `renderOrder` above the water so they composite on top, with depth-test
 * still culling the genuinely-submerged parts.
 *
 * This spec parks a synthetic ghost far out over open ocean (no terrain →
 * deep-water branch), freezes the waves, and frames the camera obliquely
 * above/behind it looking down — the geometry that triggers the bug,
 * because the camera-locked water's centroid then sorts nearer than the
 * ghost. It measures the fraction of central pixels carrying the ghost's
 * bright-cyan signature: ~3.5% once the ghost composites on top, vs ~0 when
 * the water repaints it (only a ~2% bleed-through survives, too dim to
 * register). An empty-water reference frame guards the metric's floor.
 */

// Far from any track terrain so the water shader takes its open-ocean
// branch (the same trick replay-vfx.spec.ts uses).
const GHOST_X = 5000
const GHOST_Y = 1.4
const GHOST_Z = 5000

/** A single-bike "best lap" replay whose every frame holds one fixed
 *  open-ocean pose, so the ghost-runner (which seeks the replay off the
 *  player's lap time) keeps the ghost parked while we frame it. */
function synthGhostReplay(): string {
  const sampleRateHz = 30
  const durationSeconds = 6
  const n = sampleRateHz * durationSeconds
  const frames: { t: number; bikes: number[] }[] = []
  for (let i = 0; i < n; i++) {
    frames.push({
      t: i / sampleRateHz,
      // pose (x,y,z, qx,qy,qz,qw) + v2 input state
      // (pitch, throttle, boost, driftDir, driftTier) = 12 floats.
      bikes: [GHOST_X, GHOST_Y, GHOST_Z, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    })
  }
  return JSON.stringify({
    version: 2,
    meta: {
      trackId: 'lagoon',
      trackName: 'Lagoon',
      recordedAt: '2020-01-01T00:00:00.000Z',
      durationSeconds,
      finishPosition: null,
      finishTime: null,
      bestLap: 30,
    },
    bikes: [
      {
        slot: 0,
        isPlayer: true,
        variantId: 'racer',
        displayName: 'You (last run)',
        bodyColor: 0xff7733,
      },
    ],
    sampleRateHz,
    frames,
    events: [],
    missiles: [],
    explosions: [],
  })
}

/**
 * Single-frame ghost detector — runs in the browser against a base64 PNG.
 *
 * The cyan hologram ghost, composited at full opacity, reads as BRIGHT +
 * distinctly CYAN (green and blue both well above red). That separates it
 * from everything else in a centred region of an over-water frame: open
 * water is darker teal (fails the brightness gate), foam / countdown text
 * is bright but NEUTRAL (R≈G≈B, fails the cyan gate), and HUD chrome is
 * warm or lives at the screen edges (outside the ROI). Crucially the bright
 * gate (sum > 430) also rejects the BUGGY state: when the water repaints
 * the ghost only ~2% bleeds through (water alpha ≈ 0.98), far too dim to
 * clear the gate — calibrated at 3.5% (fixed) vs 0.0015% (buggy) vs 0%
 * (empty water). Passed as the page.evaluate callback, so it must stay
 * self-contained.
 */
const GHOST_SIGNATURE_FRACTION = (b64: string): Promise<number> =>
  new Promise<number>((resolve) => {
    const img = new Image()
    img.onload = () => {
      const W = img.naturalWidth
      const H = img.naturalHeight
      const cv = document.createElement('canvas')
      cv.width = W
      cv.height = H
      const ctx = cv.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, W, H).data
      // Central ROI — excludes the top countdown banner and the bottom /
      // corner HUD + minimap.
      const x0 = Math.floor(W * 0.3)
      const x1 = Math.floor(W * 0.7)
      const y0 = Math.floor(H * 0.32)
      const y1 = Math.floor(H * 0.68)
      let hit = 0
      let total = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4
          const r = d[i]!
          const g = d[i + 1]!
          const b = d[i + 2]!
          const bright = r + g + b > 430
          const cyan = g - r > 28 && b - r > 20
          if (bright && cyan) hit++
          total++
        }
      }
      resolve(total > 0 ? hit / total : 0)
    }
    img.src = `data:image/png;base64,${b64}`
  })

test.describe('ghost over water', () => {
  skipWebKitLinux(test)

  test('Time Trial ghost stays visible against open water', async ({ page, consoleErrors }) => {
    test.setTimeout(120_000)

    // Seed the (lagoon, racer) ghost the TT boot path reads from
    // localStorage. The store is a Record<key, serializedReplayString>.
    const ghostJson = synthGhostReplay()
    await page.addInitScript((json) => {
      try {
        localStorage.setItem('hoverbike.ghosts.v1', JSON.stringify({ 'lagoon::racer': json }))
      } catch {
        /* localStorage unavailable — test will fail loudly downstream */
      }
    }, ghostJson)

    await page.goto('/?tt=1&autostart=1')
    await waitFullyBooted(page, { timeout: 60_000 })

    // Freeze the wave animation so each capture below is a stable, still
    // frame, and release any intent.
    await page.evaluate(() => {
      window.__hover!.waterDebug()?.setTimeScale(0)
      window.__hover!.setIntentOverride(null)
    })

    const canvas = page.locator('canvas').first()

    // Oblique pose: camera above + behind the point, looking down. This is
    // the geometry that triggers the bug — the camera-locked water's
    // centroid sits directly under the camera, NEARER than the chase-
    // distance subject, so in the back-to-front transparent sort the water
    // draws after (over) the ghost. A top-down pose would put the subject
    // nearer than the water and mask the bug.
    const poseAt = async (camX: number): Promise<void> => {
      await page.evaluate(
        ({ x, y, z }) => {
          window.__hover!.setCameraPose({
            pos: { x, y: y + 3.5, z: z + 9 },
            target: { x, y: y + 0.3, z },
          })
        },
        { x: camX, y: GHOST_Y, z: GHOST_Z },
      )
      await page.waitForTimeout(500)
    }

    // Ghost in frame over open water.
    await poseAt(GHOST_X)
    const ghostShot = await canvas.screenshot({ path: 'test-results/ghost-over-water.png' })
    const ghostFrac = await page.evaluate(GHOST_SIGNATURE_FRACTION, ghostShot.toString('base64'))

    // Reference — the SAME central ROI over empty open water 60 m to the
    // side. Open water never carries the bright-cyan signature, so this
    // stays ~0 and guards against the gates accidentally matching water.
    await poseAt(GHOST_X + 60)
    const refShot = await canvas.screenshot({ path: 'test-results/ghost-over-water-ref.png' })
    const refFrac = await page.evaluate(GHOST_SIGNATURE_FRACTION, refShot.toString('base64'))

    // biome-ignore lint/suspicious/noConsole: diagnostic
    console.log(
      `[ghost-over-water] ghostFrac=${(ghostFrac * 100).toFixed(2)}% refFrac=${(refFrac * 100).toFixed(2)}%`,
    )

    // With the fix the ghost composites over the water and paints a real
    // patch of bright-cyan pixels in the centre (~3.5%). Before the fix the
    // water repainted the ghost down to a ~2% bleed-through that's too dim
    // to clear the brightness gate, collapsing this to ~0 — like the empty-
    // water reference. (See GHOST_SIGNATURE_FRACTION for the calibration.)
    expect(ghostFrac).toBeGreaterThan(0.012)
    expect(ghostFrac).toBeGreaterThan(refFrac + 0.01)

    consoleErrors.assertNone()
  })
})
