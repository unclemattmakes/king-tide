import { expect, type Locator, type Page, test } from '@playwright/test'

/**
 * Cold-boot menu flow smoke tests. The full broadcast-styled menu lives
 * in `src/engine/menus/`; these tests cover:
 *  - bare `/` lands on the title screen
 *  - the four mode commits — Race, Time Trial, Cup, Multiplayer —
 *    each stamp the URL with the right `?` params and reload into the
 *    matching game-loop branch
 *  - `?autostart=1` skips the menu entirely (the rest of the suite
 *    relies on this)
 *
 * Each mode-commit test stops at `domcontentloaded` after the menu's
 * `finish()` resolves; the race-loop tests (`m3-race`, `m6-autoplay`,
 * `m9-*`) cover what happens after the reload.
 *
 * Two accommodations for software-rendering headless (the CI default
 * per `playwright.config.ts`):
 *  - `contextOptions: { reducedMotion: 'reduce' }` short-circuits the
 *    bc-rise screen-transition slide-in. The chyron's infinite
 *    `bc-live` pulse + `bc-blink` separator dots still tick though,
 *    which is enough to keep Playwright's "stable" actionability check
 *    from settling. We use `click({ force: true })` paired with an
 *    explicit `toBeVisible()` so a regression where the card never
 *    renders still trips loudly.
 *  - Per-test timeout bumped to 120s. Cold-boot under SwiftShader
 *    spends ~15-20s on first paint + bike-thumb decode before the menu
 *    is interactive, and each subsequent screen transition pays another
 *    ~10s for scroll-into-view + layout under software rendering. The
 *    30s default starves the longer five-click flows (Cup is the
 *    worst); 120s covers them with margin.
 */
test.use({ contextOptions: { reducedMotion: 'reduce' } })

test.describe.configure({ timeout: 120_000 })

async function softClick(loc: Locator): Promise<void> {
  await expect(loc).toBeVisible()
  await loc.click({ force: true })
}

async function clickModeCard(page: Page, mode: string): Promise<void> {
  await softClick(page.locator(`.bc-mode-card[data-mode="${mode}"]`))
}

test.describe('cold-boot menu', () => {
  test('bare URL shows the title screen with PRESS START', async ({ page }) => {
    await page.goto('/')
    const title = page.locator('#title-start')
    await expect(title).toBeVisible()
    // Body gets the menu-active class so HUD chrome stays hidden.
    const bodyClass = await page.evaluate(() => document.body.classList.contains('menu-active'))
    expect(bodyClass).toBe(true)
  })

  test('?autostart=1 skips the menu and boots the race', async ({ page }) => {
    await page.goto('/?autostart=1')
    await page.waitForFunction(() => window.__hover?.player()?.isGrounded === true, {
      timeout: 30_000,
    })
    const menuVisible = await page.locator('#menu.show').count()
    expect(menuVisible).toBe(0)
  })

  test('Race path commits a race URL with track + bike + race=1', async ({ page }) => {
    await page.goto('/')
    await softClick(page.locator('#title-start'))
    await clickModeCard(page, 'race')
    // Click the first track card. With every v1 track now status:'ship',
    // the first card on `sp-track` is Sandbar. Clicking auto-advances to
    // the bike screen; there's no separate confirm button.
    await softClick(page.locator('#sp-track-cards .bc-card').first())
    // Pick the first bike (Cruiser comes first in BIKE_VARIANTS).
    // Clicking a bike auto-commits the race URL.
    await softClick(page.locator('#sp-bike-cards .bc-card').first())
    await page.waitForLoadState('domcontentloaded')
    const url = page.url()
    expect(url).toContain('race=1')
    expect(url).toMatch(/track=/)
    expect(url).toMatch(/bike=/)
    // Race mode never stamps `cup=` or `tt=1`.
    expect(url).not.toContain('cup=')
    expect(url).not.toContain('tt=1')
  })

  test('Time Trial path commits a race URL with tt=1', async ({ page }) => {
    await page.goto('/')
    await softClick(page.locator('#title-start'))
    await clickModeCard(page, 'time-trial')
    // TT reuses `sp-cup-tracks` as a venue picker — every shipped v1
    // track is listed as a clickable tile (no cup wrapper). The grid
    // grows past the headless viewport (12 v1 tracks + dev tracks on
    // dev builds), so the first card can scroll off-screen even after
    // scrollIntoViewIfNeeded — `force: true` still trips the viewport
    // guard. We dispatch the click directly to fire the handler
    // without needing the element on-screen; the click behaviour is
    // identical from the menu-flow code's POV.
    const firstTrack = page.locator('#sp-cup-track-cards .bc-card').first()
    await expect(firstTrack).toBeVisible()
    await firstTrack.dispatchEvent('click')
    await softClick(page.locator('#sp-bike-cards .bc-card').first())
    await page.waitForLoadState('domcontentloaded')
    const url = page.url()
    expect(url).toContain('race=1')
    expect(url).toContain('tt=1')
    expect(url).toMatch(/track=/)
    expect(url).toMatch(/bike=/)
    // TT is a single-track flow — no cup wiring.
    expect(url).not.toContain('cup=')
  })

  test('Cup path commits a championship URL with cup= + first race track', async ({ page }) => {
    await page.goto('/')
    await softClick(page.locator('#title-start'))
    await clickModeCard(page, 'cup')
    // First cup card is Reef Cup — `V1_CUPS[0]`. Dev placeholder + Dev
    // Cup get appended after the ship cups, so `.first()` is stable.
    await softClick(page.locator('#sp-cup-cards .bc-card').first())
    // `sp-cup-tracks` renders the lineup as inert preview tiles; the
    // commit goes through the START CUP CTA.
    await softClick(page.locator('#sp-cup-start'))
    await softClick(page.locator('#sp-bike-cards .bc-card').first())
    await page.waitForLoadState('domcontentloaded')
    const url = page.url()
    expect(url).toContain('race=1')
    expect(url).toContain('cup=reef')
    // First race in Reef Cup's lineup is `sandbar` (first matching v1
    // track in catalog order).
    expect(url).toContain('track=sandbar')
    expect(url).toMatch(/bike=/)
    // Cup mode is a championship — TT flag should never appear.
    expect(url).not.toContain('tt=1')
  })

  test('MP entry "CREATE LOBBY" navigates to a room code URL', async ({ page }) => {
    await page.goto('/')
    await softClick(page.locator('#title-start'))
    await clickModeCard(page, 'multiplayer')
    // CREATE LOBBY button is the first card on the MP entry screen.
    await softClick(page.locator('.bc-mode-card[data-action="create"]'))
    await page.waitForLoadState('domcontentloaded')
    expect(page.url()).toMatch(/[?&]room=[A-Z0-9-]+/)
  })
})
