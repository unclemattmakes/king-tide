/**
 * Dev-tools palette — dock rail + Ctrl/Cmd+K command bar.
 *
 * Covers the load-bearing behaviours of src/engine/dev/*:
 *  - the dock shows in a dev build (the dev server is always `import.meta.env.DEV`)
 *  - Ctrl+K opens the command bar WITHOUT blackening the scene; Esc closes it,
 *    and Esc while it's closed still reaches the pause menu (scoped capture)
 *  - running a tool flows registry → runTool → window.__hover, and typing in
 *    the bar never drives the bike (the keyboard-stopPropagation guard)
 *  - opening a tuner docks it scene-visible (no backdrop), single-active
 *  - launching a scene navigates, preserving the deep-link context
 *
 * Headed real-GPU per hard rule 2 — drive your own server:
 *   E2E_PORT=5399 pnpm e2e dev-palette.spec.ts --workers=1
 */
import type { Page } from '@playwright/test'
import { waitForReady, waitFullyBooted } from './helpers/boot'
import { expect, test } from './helpers/console-errors'

/** Wait until the start countdown has cleared (HUD unlocked / pausable). */
async function waitRacing(page: Page): Promise<void> {
  await page.waitForFunction(() => (window.__hover?.race()?.raceTime ?? 0) > 0.5, null, {
    timeout: 15_000,
  })
}

/** Open the command bar. Waits for the dock first — its presence proves the
 *  palette (and thus the Ctrl+K listener) has finished its fire-and-forget
 *  install, so the hotkey can't race the boot. */
async function openCmdBar(page: Page): Promise<void> {
  await expect(page.locator('#dev-dock')).toBeVisible()
  await page.keyboard.press('Control+KeyK')
  await expect(page.locator('#dev-cmdbar input')).toBeFocused()
}

test.describe('dev-tools palette', () => {
  test('dock shows; Ctrl+K opens a non-blackening command bar; Esc is scoped', async ({
    page,
    consoleErrors,
  }) => {
    await page.goto('/?autostart=1')
    await waitForReady(page)

    // 1) The dock rail is present and a known row is visible (panel expanded).
    await expect(page.locator('#dev-dock')).toBeVisible()
    await expect(page.locator('#dev-dock .dd-row[data-tool="panel.water"]')).toBeVisible()

    // The always-on dev telemetry strip (#hud) is off by default now.
    await expect(page.locator('#hud')).toBeHidden()

    // 2) Ctrl+K opens the command bar and focuses the input.
    await openCmdBar(page)
    // The overlay must NOT blacken the scene — it has no background of its own.
    await expect(page.locator('#dev-cmdbar')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

    // Typing filters the list.
    await page.locator('#dev-cmdbar input').fill('water')
    await expect(page.locator('#dev-cmdbar li[data-tool="panel.water"]')).toBeVisible()

    // Esc closes the bar (and must NOT also open the pause menu).
    await page.keyboard.press('Escape')
    await expect(page.locator('#dev-cmdbar')).not.toHaveClass(/open/)
    await expect(page.locator('#pause-menu')).not.toHaveClass(/show/)

    // 3) With the bar closed, Esc reaches the pause menu as normal.
    await waitRacing(page)
    await page.keyboard.press('Escape')
    await expect(page.locator('#pause-menu')).toHaveClass(/show/)
    await page.keyboard.press('Escape') // close it again

    consoleErrors.assertNone()
  })

  test('runs a toggle via the bar, sandboxes typing, reflects state, docks tuners', async ({
    page,
    consoleErrors,
  }) => {
    await page.goto('/?autostart=1')
    await waitFullyBooted(page)
    await waitRacing(page)

    // --- registry → runTool → __hover: flip collision debug from the bar ---
    expect(await page.evaluate(() => window.__hover!.isCollisionDebugOn())).toBe(false)
    await openCmdBar(page)
    await page.locator('#dev-cmdbar input').fill('collision')
    await expect(page.locator('#dev-cmdbar li[data-tool="toggle.collision"]')).toBeVisible()
    await page.keyboard.press('Enter')
    expect(await page.evaluate(() => window.__hover!.isCollisionDebugOn())).toBe(true)

    // --- the dock row reflects the live state (poll within the refresh window) ---
    await expect(page.locator('#dev-dock .dd-row[data-tool="toggle.collision"]')).toHaveClass(
      /dd-on/,
      { timeout: 2_000 },
    )

    // --- typing in the bar must NOT drive the bike ---
    // Open the bar, focus the input, and HOLD W (throttle). If the guard fails,
    // the key reaches installKeyboard and throttle ramps toward 1; with the
    // guard it stays at 0. (Race is unlocked, so a leaked key really would drive.)
    await openCmdBar(page)
    await page.keyboard.down('KeyW')
    await page.waitForTimeout(450)
    const throttle = await page.evaluate(() => window.__hover!.intent().throttle)
    await page.keyboard.up('KeyW')
    expect(throttle).toBeLessThan(0.05)
    await page.keyboard.press('Escape')

    // --- opening a tuner docks it scene-visible (no blackening, pointer-through) ---
    await page.locator('#dev-dock .dd-row[data-tool="panel.devsettings"]').click()
    await expect(page.locator('#devsettings')).toHaveClass(/show/)
    await expect(page.locator('#devsettings')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(page.locator('#devsettings')).toHaveCSS('backdrop-filter', 'none')
    await expect(page.locator('#devsettings')).toHaveCSS('pointer-events', 'none')
    await expect(page.locator('#devsettings .card')).toHaveCSS('pointer-events', 'auto')

    // --- single-active: opening Water closes Dev settings ---
    await page.locator('#dev-dock .dd-row[data-tool="panel.water"]').click()
    await expect(page.locator('#water-debug')).toHaveClass(/show/)
    await expect(page.locator('#devsettings')).not.toHaveClass(/show/)

    // --- the "Dev HUD" toggle restores the off-by-default telemetry strip ---
    await expect(page.locator('#hud')).toBeHidden()
    await openCmdBar(page)
    await page.locator('#dev-cmdbar input').fill('dev hud')
    await expect(page.locator('#dev-cmdbar li[data-tool="toggle.devhud"]')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('#hud')).toBeVisible()

    consoleErrors.assertNone()
  })

  test('launching a scene navigates and preserves the deep-link context', async ({ page }) => {
    // The scene launch reloads away from a live race, so it asks to confirm.
    page.on('dialog', (d) => d.accept())

    await page.goto('/?autostart=1&bike=racer')
    await waitForReady(page)

    await openCmdBar(page)
    await page.locator('#dev-cmdbar input').fill('bike viewer')
    await expect(page.locator('#dev-cmdbar li[data-tool="scene.viewer"]')).toBeVisible()
    await page.keyboard.press('Enter')

    // Navigated into the bike viewer, with bike=racer carried across.
    await page.waitForURL(/[?&]viewer=/, { timeout: 15_000 })
    const params = new URL(page.url()).searchParams
    expect(params.get('viewer')).toBe('1')
    expect(params.get('bike')).toBe('racer')
  })

  test('live tuning applies without a map reload', async ({ page }) => {
    // The Time-of-day control prompts for a value; auto-answer it.
    page.on('dialog', (d) => d.accept('120'))

    await page.goto('/?autostart=1')
    await waitFullyBooted(page)
    await expect(page.locator('#dev-dock')).toBeVisible()

    // Sentinel: a full page reload would wipe this window global.
    await page.evaluate(() => {
      ;(window as unknown as { __noReload?: boolean }).__noReload = true
    })

    // Freeze water — a live toggle. Deterministic engine read + UI reflection.
    await page.locator('#dev-dock .dd-row[data-tool="world.freeze-water"]').click()
    expect(await page.evaluate(() => window.__hover!.waterDebug()?.getTimeScale())).toBe(0)
    await expect(page.locator('#dev-dock .dd-row[data-tool="world.freeze-water"]')).toHaveClass(
      /dd-on/,
      { timeout: 2_000 },
    )

    // Time of day — applies live via the command bar (no navigation).
    await openCmdBar(page)
    await page.locator('#dev-cmdbar input').fill('time of day')
    await expect(page.locator('#dev-cmdbar li[data-tool="world.tod"]')).toBeVisible()
    await page.keyboard.press('Enter')

    // Neither tool reloaded the page — the sentinel survives, no ?tod was set.
    expect(
      await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
    ).toBe(true)
    expect(page.url()).not.toContain('tod')
  })

  test('brush tuner docks; terrain + rocks dial independently, live (no reload)', async ({
    page,
    consoleErrors,
  }) => {
    await page.goto('/?autostart=1')
    await waitFullyBooted(page)
    await expect(page.locator('#dev-dock')).toBeVisible()
    await page.evaluate(() => {
      ;(window as unknown as { __noReload?: boolean }).__noReload = true
    })

    // Open the Brush tuner from the command bar; it docks scene-visible (no blackening).
    await openCmdBar(page)
    await page.locator('#dev-cmdbar input').fill('brush strokes')
    await expect(page.locator('#dev-cmdbar li[data-tool="panel.brush"]')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('#brush-debug')).toHaveClass(/show/)
    await expect(page.locator('#brush-debug')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

    // Terrain and rocks are INDEPENDENT: dialing terrain strength must not touch
    // the rocks/props strength. (Range inputs are set via input event.)
    const terrain = page.locator('#brush-debug input[data-tool="terrain.brush"]')
    const rocks = page.locator('#brush-debug input[data-tool="vinyl.brush"]')
    const rocksBefore = await rocks.inputValue()
    await terrain.evaluate((el) => {
      ;(el as HTMLInputElement).value = '0.4'
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(await terrain.inputValue()).toBe('0.4')
    expect(await rocks.inputValue()).toBe(rocksBefore)

    // Live — dialing a slider never reloads the page.
    expect(
      await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
    ).toBe(true)

    consoleErrors.assertNone()
  })
})
