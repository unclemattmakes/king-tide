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
    // Edit mode now boots the real environment GLB before mounting the
    // panel, so allow a generous load window (also absorbs Vite cold-start).
    await expect(panel).toBeVisible({ timeout: 30_000 })
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

    // Click a checkpoint row → selection updates the props panel with
    // editable numeric inputs (the typed-entry surface).
    await outliner.locator('div[data-select="gate:0"]').click()
    await expect(panel.locator('#ed-props')).toContainText('cp_00')
    await expect(panel.locator('#ed-props')).toContainText('Half width')
    await expect(panel.locator('#ed-props input[data-numedit="halfWidth"]')).toBeVisible()
    // Lagoon-edit's gates are spline-bound, so the props panel should
    // show the binding marker.
    await expect(panel.locator('#ed-props')).toContainText('bound to spline')
  })

  test('exposes track-settings, sky, and wave-zone authoring surfaces', async ({ page }) => {
    test.setTimeout(30_000)
    await page.goto('/?track=calibration&edit=1')

    const panel = page.locator('#editor-panel')
    // Edit mode now boots the real environment GLB before mounting the
    // panel, so allow a generous load window (also absorbs Vite cold-start).
    await expect(panel).toBeVisible({ timeout: 30_000 })

    // New place tool for wave zones.
    await expect(panel.locator('button[data-place="waveZone"]')).toBeVisible()

    // Track settings: open the (default-collapsed) section and confirm the
    // name / laps / float-gates inputs.
    const track = panel.locator('details[data-section="track"]')
    await track.locator('summary').click()
    await expect(track.locator('input[data-trackedit="name"]')).toBeVisible()
    await expect(track.locator('input[data-trackedit="lapsToFinish"]')).toBeVisible()
    await expect(track.locator('input[data-trackedit="floatGates"]')).toBeVisible()
    // Collapse it again so the outliner stays reachable below.
    await track.locator('summary').click()

    // Sky section: open the <details> and confirm the atmosphere controls.
    const sky = panel.locator('details[data-section="sky"]')
    await sky.locator('summary').click()
    await expect(sky.locator('input[data-skyedit="seaStateBeaufort"]')).toBeVisible()
    await expect(sky.locator('select[data-skyedit="colorGrade"]')).toBeVisible()
    await sky.locator('summary').click()

    // Place a wave zone FIRST (no entity selected → no gizmo to intercept
    // the ground click). It shows up in the outliner and its props panel
    // exposes the multiplier inputs.
    await panel.locator('button[data-place="waveZone"]').click()
    const canvas = page.locator('#app canvas').first()
    await canvas.waitFor()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('no canvas bounding box')
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)
    await expect(panel.locator('#ed-outliner')).toContainText('Wave Zones (1)')
    await expect(panel.locator('#ed-props input[data-numedit="heightMult"]')).toBeVisible()

    // Typed numeric entry mutates the draft: edit a gate's height and
    // confirm the input round-trips the value through a re-render.
    await panel.locator('#ed-outliner div[data-select="gate:0"]').click()
    const heightInput = panel.locator('#ed-props input[data-numedit="height"]')
    await heightInput.fill('9')
    await heightInput.blur()
    await expect(panel.locator('#ed-props input[data-numedit="height"]')).toHaveValue('9')
  })

  test('Ctrl+Z undoes a placement', async ({ page }) => {
    test.setTimeout(30_000)
    await page.goto('/?track=calibration&edit=1')

    const panel = page.locator('#editor-panel')
    // Edit mode now boots the real environment GLB before mounting the
    // panel, so allow a generous load window (also absorbs Vite cold-start).
    await expect(panel).toBeVisible({ timeout: 30_000 })
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
    // Edit mode now boots the real environment GLB before mounting the
    // panel, so allow a generous load window (also absorbs Vite cold-start).
    await expect(panel).toBeVisible({ timeout: 30_000 })
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
