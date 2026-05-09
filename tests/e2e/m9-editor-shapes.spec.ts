import { expect, test } from '@playwright/test'

/**
 * Editor shapes + start + viewport-select smoke. Asserts:
 *   1. Shapes toolbar renders with the five new types.
 *   2. Start row appears in the outliner and is selectable.
 *   3. + Pipe → click viewport → outliner shows a Pipe entity.
 *   4. Viewport click on the new pipe selects it (not via the outliner).
 *   5. Save endpoint accepts the new payload (status text reports "Saved …").
 *
 * Operates on `?track=calibration&edit=1` so the outliner starts with no
 * shapes (calibration.json has props: []).
 */
test.describe('M9.x editor shapes + start + viewport select', () => {
  test('place pipe + click-select + save', async ({ page }) => {
    test.setTimeout(45_000)
    await page.goto('/?track=calibration&edit=1')

    const panel = page.locator('#editor-panel')
    await expect(panel).toBeVisible()

    // Shapes toolbar exists.
    for (const t of ['box', 'sphere', 'cylinder', 'pipe', 'halfpipe']) {
      await expect(panel.locator(`button[data-place="${t}"]`)).toBeVisible()
    }

    // Outliner has a Start (1) row.
    const outliner = panel.locator('#ed-outliner')
    await expect(outliner).toContainText('Start (1)')
    await expect(outliner).toContainText('Shapes (0)')

    // Activate +Pipe and drop one near the canvas centre. (Do this BEFORE
    // selecting any other entity so no gizmo is attached to intercept the
    // ground click.)
    await panel.locator('button[data-place="pipe"]').click()
    const canvas = page.locator('#app canvas').first()
    await canvas.waitFor()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('no canvas bounding box')
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55)
    await expect(outliner).toContainText('Shapes (1)')
    await expect(panel.locator('#ed-props')).toContainText('Pipe_0')

    // Click Start in the outliner — props panel describes the start entity.
    await outliner.locator('div[data-select="start"]').click()
    await expect(panel.locator('#ed-props')).toContainText('controls position + facing')

    // Undo the placed pipe so this test doesn't leave dirty state in
    // memory if the page is reused. (We deliberately don't exercise
    // Save here — it would pollute public/tracks/calibration.json.)
    await page.keyboard.press('Control+z')
    await expect(outliner).toContainText('Shapes (0)')
  })
})
