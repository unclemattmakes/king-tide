import { expect, test } from '@playwright/test'

/**
 * M9.18 — in-app track editor smoke test. Asserts:
 *   1. The editor panel mounts on `?track=<id>&edit=1`.
 *   2. `?edit=1` alone defaults to the lagoon-edit JSON snapshot.
 *   3. The outliner lists all entities, grouped by kind.
 *   4. Place + Mode toolbars are present.
 *   5. Place-pickup → click canvas adds a row to the outliner.
 *   6. Outliner click selects an entity and surfaces its props.
 *
 * Save is exercised manually (the dev middleware writes to disk; we don't
 * want a test polluting the repo).
 */
test.describe('M9.18 in-app editor', () => {
  test('defaults ?edit=1 to lagoon-edit and mounts outliner with all entity kinds', async ({
    page,
  }) => {
    test.setTimeout(30_000)
    await page.goto('/?edit=1')

    const panel = page.locator('#editor-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('EDITOR · lagoon-edit')

    // Place + Mode toolbars present.
    await expect(panel.locator('button[data-place="gate"]')).toBeVisible()
    await expect(panel.locator('button[data-place="pickup"]')).toBeVisible()
    await expect(panel.locator('button[data-place="pad"]')).toBeVisible()
    await expect(panel.locator('button[data-place="spline"]')).toBeVisible()
    await expect(panel.locator('button[data-mode="translate"]')).toBeVisible()
    await expect(panel.locator('button[data-mode="rotate"]')).toBeVisible()
    await expect(panel.locator('button[data-mode="scale"]')).toBeVisible()

    // Outliner lists all four entity kinds with non-zero counts where
    // expected (lagoon-edit has 9 gates, 7 pickups, 0 pads, 9 spline anchors).
    const outliner = panel.locator('#ed-outliner')
    await expect(outliner).toContainText('Checkpoints (9)')
    await expect(outliner).toContainText('Pickups (7)')
    await expect(outliner).toContainText('Boost Pads (0)')
    await expect(outliner).toContainText('Spline anchors (9)')

    // Click a checkpoint row → selection updates the props panel.
    await outliner.locator('div[data-select="gate:0"]').click()
    await expect(panel.locator('#ed-props')).toContainText('cp_00')
    await expect(panel.locator('#ed-props')).toContainText('halfWidth')
    // Lagoon-edit's gates are spline-bound, so the props panel should
    // show the binding marker.
    await expect(panel.locator('#ed-props')).toContainText('bound to spline')
  })

  test('Ctrl+Z undoes a placement', async ({ page }) => {
    test.setTimeout(30_000)
    await page.goto('/?track=calibration&edit=1')

    const panel = page.locator('#editor-panel')
    await expect(panel).toBeVisible()
    const outliner = panel.locator('#ed-outliner')
    await expect(outliner).toContainText('Pickups (1)')

    // Place a new pickup.
    await panel.locator('button[data-place="pickup"]').click()
    const canvas = page.locator('#app canvas').first()
    await canvas.waitFor()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('no canvas bounding box')
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)
    await expect(outliner).toContainText('Pickups (2)')

    // Undo via Ctrl+Z — count should drop back.
    await page.keyboard.press('Control+z')
    await expect(outliner).toContainText('Pickups (1)')
  })

  test('place-pickup tool adds a pickup on canvas click', async ({ page }) => {
    test.setTimeout(30_000)
    await page.goto('/?track=calibration&edit=1')

    const panel = page.locator('#editor-panel')
    await expect(panel).toBeVisible()
    await expect(panel.locator('#ed-outliner')).toContainText('Pickups (1)')

    // Activate +Pickup, click the canvas centre.
    await panel.locator('button[data-place="pickup"]').click()
    const canvas = page.locator('#app canvas').first()
    await canvas.waitFor()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('no canvas bounding box')
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)

    // Outliner now shows 2 pickups; the new one is auto-selected and
    // surfaces in the props panel.
    await expect(panel.locator('#ed-outliner')).toContainText('Pickups (2)')
    await expect(panel.locator('#ed-props')).toContainText('pickup_1')
  })
})
