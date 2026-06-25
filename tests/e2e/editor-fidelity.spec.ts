import { expect, test } from '@playwright/test'

/**
 * Editor fidelity (PR1) — the editor now renders the REAL track in edit mode:
 * the environment GLB loads, the terrain heightmap bakes (so shoaling water +
 * the material waterline appear), and the wave field advances so the surface
 * actually moves. Previously edit mode rendered a bare flat plane.
 *
 * Uses `sandbar` (Mayday Bay) — a dressed track with an `environmentGlb`.
 */
test.describe('editor fidelity in edit mode', () => {
  test('loads the environment GLB and animates the water', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/?track=sandbar&edit=1')

    // The editor panel only mounts after the track (incl. env GLB) has loaded.
    const panel = page.locator('#editor-panel')
    await expect(panel).toBeVisible({ timeout: 45_000 })

    // The environment GLB is in the scene: env nodes carry `userData.kind`
    // (e.g. terrain = "track"), which editor helpers / water / sky never set.
    const envNodeCount = await page.evaluate(() => {
      const scene = (
        window as unknown as { __scene?: { traverse(cb: (o: unknown) => void): void } }
      ).__scene
      if (!scene) return -1
      let n = 0
      scene.traverse((o) => {
        const k = (o as { userData?: { kind?: string } }).userData?.kind
        if (typeof k === 'string' && k.length > 0) n++
      })
      return n
    })
    expect(envNodeCount).toBeGreaterThan(0)

    // The wave field advances — water (and any floats) are no longer frozen.
    // Poll until it has accumulated time rather than snapshotting a fixed
    // window: the heavy first render (20 MB GLB + shader compile) can stall
    // the rAF loop briefly, so two close reads could both land in one starved
    // frame. Polling only needs the loop to EVENTUALLY run, which it does.
    const readTime = () =>
      page.evaluate(
        () =>
          (window as unknown as { __editWaveField?: { time: number } }).__editWaveField?.time ?? -1,
      )
    await expect.poll(readTime, { timeout: 20_000, intervals: [400] }).toBeGreaterThan(0.5)

    // Visual confirmation: terrain + animated water behind the editor panel.
    await page.screenshot({ path: 'test-results/editor-fidelity-sandbar.png' })
  })

  test('floats a wave-rider prop on the live water surface', async ({ page }) => {
    test.setTimeout(45_000)
    await page.goto('/?track=calibration&edit=1')
    const panel = page.locator('#editor-panel')
    await expect(panel).toBeVisible({ timeout: 30_000 })

    // Place a box prop, then toggle "Float on waves" on it.
    await panel.locator('button[data-place="box"]').click()
    const canvas = page.locator('#app canvas').first()
    await canvas.waitFor()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('no canvas bounding box')
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)
    await expect(panel.locator('#ed-props')).toContainText('Box_0')
    await panel.locator('#ed-props input[data-propflag="waveRider"]').check()

    // Deselect (the float preview skips the SELECTED prop so its gizmo stays
    // grabbable) by selecting the start row instead — now the box floats.
    await panel.locator('#ed-outliner div[data-select="start"]').click()

    // Read the box helper's Y twice; the wave field bobs it over time.
    const readY = () =>
      page.evaluate(() => {
        const scene = (
          window as unknown as { __scene?: { traverse(cb: (o: unknown) => void): void } }
        ).__scene
        let y = Number.NaN
        scene?.traverse((o) => {
          const obj = o as { userData?: { entityKey?: string }; position?: { y: number } }
          if (obj.userData?.entityKey === 'prop:0' && obj.position) y = obj.position.y
        })
        return y
      })
    const y0 = await readY()
    expect(Number.isFinite(y0)).toBe(true)
    await page.waitForTimeout(700)
    const y1 = await readY()
    expect(Math.abs(y1 - y0)).toBeGreaterThan(0.01) // it's bobbing
  })

  test('sea-state edits re-scale the live wave amplitudes', async ({ page }) => {
    test.setTimeout(45_000)
    await page.goto('/?track=calibration&edit=1')
    const panel = page.locator('#editor-panel')
    await expect(panel).toBeVisible({ timeout: 30_000 })

    const ampSum = () =>
      page.evaluate(() => {
        const f = (window as unknown as { __editWaveField?: { waves: { amplitude: number }[] } })
          .__editWaveField
        return f ? f.waves.reduce((s, w) => s + Math.abs(w.amplitude), 0) : -1
      })
    const before = await ampSum()
    expect(before).toBeGreaterThan(0)

    // Crank the sea state in the Sky section → the live water gets rougher.
    const sky = panel.locator('details[data-section="sky"]')
    await sky.locator('summary').click()
    const sea = sky.locator('input[data-skyedit="seaStateBeaufort"]')
    await sea.fill('11')
    await sea.blur()
    const after = await ampSum()
    expect(after).toBeGreaterThan(before * 1.2) // amplitudes grew with the storm
  })
})
