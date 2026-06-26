import { expect, test } from '@playwright/test'

/**
 * Epic 2 / PR6 — in-app prop-line authoring. Place a parametric "asset along a
 * curve", confirm it shows in the outliner with a live instance preview, and
 * that editing its params re-flows it. The follow-ups add a "Seat to terrain"
 * toggle (instances follow the loaded terrain heightmap) and a "Bind to spline"
 * toggle (the source is a t0..t1 slice of the racing line). The deterministic
 * expansion + Blender round-trip are covered by the unit + drift tests.
 *
 * Edit mode now boots the real environment GLB (so the author sees terrain +
 * the live water), so the panel can take a while to appear — the timeouts are
 * generous on the dressed tracks.
 */
test.describe('editor prop-line authoring', () => {
  test('place a prop line and edit its spacing', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/?track=calibration&edit=1')
    const panel = page.locator('#editor-panel')
    await expect(panel).toBeVisible({ timeout: 45_000 })

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

  test('seat a prop line to terrain', async ({ page }) => {
    test.setTimeout(90_000)
    // sandbar has an environment GLB → the editor bakes a terrain heightmap, so
    // "Seat to terrain" has real terrain to resolve against.
    await page.goto('/?track=sandbar&edit=1')
    const panel = page.locator('#editor-panel')
    await expect(panel).toBeVisible({ timeout: 60_000 })

    await panel.locator('button[data-place="propLine"]').click()
    const canvas = page.locator('#app canvas').first()
    await canvas.waitFor()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('no canvas bounding box')
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)
    await expect(panel.locator('#ed-outliner')).toContainText('Prop Lines (1)')

    // Toggle "Seat to terrain" → the flag sticks + the note reflects seating,
    // and the Normal row relabels to "Height m" (above terrain).
    const seat = panel.locator('#ed-props input[data-proplineflag="seatToTerrain"]')
    await expect(seat).toBeVisible()
    await seat.check()
    await expect(panel.locator('#ed-props input[data-proplineflag="seatToTerrain"]')).toBeChecked()
    await expect(panel.locator('#ed-props')).toContainText('Seated to terrain')
    await expect(panel.locator('#ed-props')).toContainText('Height m')

    // Still expands to instances (seating is a Y post-pass, not a re-count).
    await expect(panel.locator('#ed-props')).toContainText('instance(s)')
  })

  test('bind a prop line to the main spline', async ({ page }) => {
    test.setTimeout(90_000)
    await page.goto('/?track=sandbar&edit=1')
    const panel = page.locator('#editor-panel')
    await expect(panel).toBeVisible({ timeout: 60_000 })

    await panel.locator('button[data-place="propLine"]').click()
    const canvas = page.locator('#app canvas').first()
    await canvas.waitFor()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('no canvas bounding box')
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)
    await expect(panel.locator('#ed-outliner')).toContainText('Prop Lines (1)')

    // Toggle "Bind to spline" → the anchor curve becomes a t0/t1 slice of the
    // racing line: the t0/t1 sliders appear, the outliner row shows the range,
    // and the line still expands to instances.
    const bind = panel.locator('#ed-props input[data-proplineflag="bind"]')
    await expect(bind).toBeVisible()
    await bind.check()
    await expect(panel.locator('#ed-props #ed-propline-t0')).toBeVisible()
    await expect(panel.locator('#ed-props #ed-propline-t1')).toBeVisible()
    await expect(panel.locator('#ed-outliner')).toContainText('⤳ t')
    await expect(panel.locator('#ed-props')).toContainText('racing line t=')

    // Slide t1 down to a partial arc → the instance count re-flows (the bound
    // stretch shrinks). Drive the range input value + dispatch input/change.
    const t1 = panel.locator('#ed-props #ed-propline-t1')
    await t1.fill('0.4')
    await t1.dispatchEvent('change')
    await expect(panel.locator('#ed-props')).toContainText('instance(s)')

    await page.screenshot({ path: 'test-results/editor-propline-bind.png' })
  })
})
