import { expect, test } from '@playwright/test'

/**
 * M9.18 — in-app track editor smoke test. The editor should:
 *   1. Mount when `?track=calibration&edit=1`.
 *   2. Show the side panel with tool buttons.
 *   3. Render the existing track's gates / pickups / spline as helper meshes.
 *   4. Place a new pickup when the user clicks while the +Pickup tool is active.
 *
 * We don't drive a Save here — the Vite middleware writes to disk and we
 * don't want a test polluting the repo. Save is exercised manually.
 */
test.describe('M9.18 in-app editor', () => {
  test('mounts editor panel and places pickups via click', async ({ page }) => {
    test.setTimeout(30_000)
    await page.goto('/?track=calibration&edit=1')

    // Panel mounts.
    const panel = page.locator('#editor-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('EDITOR · calibration')

    // Tool buttons present.
    await expect(panel.locator('button[data-tool="select"]')).toBeVisible()
    await expect(panel.locator('button[data-tool="pickup"]')).toBeVisible()
    await expect(panel.locator('button[data-tool="gate"]')).toBeVisible()

    // Initial counts reflect the calibration JSON: 4 gates, 1 pickup, 0 pads.
    await expect(panel).toContainText('gates 4')
    await expect(panel).toContainText('pickups 1')
    await expect(panel).toContainText('pads 0')

    // Switch to the +Pickup tool and click on the canvas to place one.
    await panel.locator('button[data-tool="pickup"]').click()
    const canvas = page.locator('#app canvas').first()
    await canvas.waitFor()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('no canvas bounding box')
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)

    // Panel updates.
    await expect(panel).toContainText('pickups 2')
  })
})
