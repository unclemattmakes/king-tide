import { expect, test } from '@playwright/test'

/**
 * Epic 2 / PR6 — in-app prop-line authoring. Place a parametric "asset along a
 * curve", confirm it shows in the outliner with a live instance preview, and
 * that editing its params re-flows it. The deterministic expansion + Blender
 * round-trip are covered by the unit + drift tests.
 */
test.describe('editor prop-line authoring', () => {
  test('place a prop line and edit its spacing', async ({ page }) => {
    test.setTimeout(45_000)
    await page.goto('/?track=calibration&edit=1')
    const panel = page.locator('#editor-panel')
    await expect(panel).toBeVisible({ timeout: 30_000 })

    // The + Prop Line tool (needs the manifest's asset dropdown).
    const btn = panel.locator('button[data-place="propLine"]')
    await expect(btn).toBeVisible()
    await btn.click()

    const canvas = page.locator('#app canvas').first()
    await canvas.waitFor()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('no canvas bounding box')
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)

    // New line in the outliner + its params panel (with a live instance count).
    await expect(panel.locator('#ed-outliner')).toContainText('Prop Lines (1)')
    await expect(panel.locator('#ed-props')).toContainText('instance(s)')

    // Switch to exact-count spacing and set the count → the value round-trips
    // through the re-render (proving the param edit + re-expand path).
    await panel.locator('#ed-props select[data-proplineflag="spacingMode"]').selectOption('count')
    const count = panel.locator('#ed-props input[data-numedit="count"]')
    await count.fill('8')
    await count.blur()
    await expect(panel.locator('#ed-props input[data-numedit="count"]')).toHaveValue('8')
    await expect(panel.locator('#ed-props')).toContainText('8 instance(s)')

    // Visual: the amber curve + draggable anchors + teal instance preview.
    await page.screenshot({ path: 'test-results/editor-propline.png' })
  })
})
