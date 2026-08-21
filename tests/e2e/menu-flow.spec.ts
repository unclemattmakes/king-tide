import { expect, type Locator, type Page, test } from '@playwright/test'

/**
 * Cold-boot menu flow smoke tests. The full broadcast-styled menu lives
 * in `src/engine/menus/`; these tests cover:
 *  - bare `/` lands on the title screen
 *  - the four mode commits — Single Race, Time Trial, Cup (off the mode
 *    screen) and Multiplayer (off the title fork) — each stamp the URL
 *    with the right `?` params and reload into the matching game-loop
 *    branch
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

/** Wait for a menu commit to actually land in the address bar.
 *  `finish()` resolves the menu promise, but `url-modes` then tears the
 *  attract loop down (up to a 1.5 s race + a 200 ms grace) before it
 *  calls `location.assign` — so `waitForLoadState('domcontentloaded')`
 *  can return on the *old* page and read a URL that hasn't changed yet.
 */
async function waitForCommit(page: Page, pattern: RegExp): Promise<string> {
  await page.waitForURL(pattern, { timeout: 30_000 })
  return page.url()
}

/** Cold-boot, then advance off the title. The Enter has to wait for the
 *  title to actually mount: `runMenuFlow` installs its keydown listener
 *  as the last thing it does, so a press fired straight after `goto` is
 *  swallowed and the flow sits on the title screen — which then shows up
 *  as a "mode card is hidden" failure several lines later.
 */
async function gotoAndStart(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.bc-title .word')).toBeVisible()
  await page.keyboard.press('Enter')
}

async function clickModeCard(page: Page, mode: string): Promise<void> {
  await softClick(page.locator(`.bc-mode-card[data-mode="${mode}"]`))
}

test.describe('cold-boot menu', () => {
  test('bare URL shows the cold-boot title screen', async ({ page }) => {
    await page.goto('/')
    // The title offers an explicit SINGLE PLAYER / MULTIPLAYER fork now,
    // so it is no longer an any-key surface. Assert on the wordmark
    // rather than either button, which the relocation tests below cover.
    await expect(page.locator('.bc-title .word')).toBeVisible()
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
    await gotoAndStart(page)
    await clickModeCard(page, 'race')
    // Click the first track card. With every v1 track now status:'ship',
    // the first card on `sp-track` is Sandbar. Clicking auto-advances to
    // the bike screen; there's no separate confirm button.
    await softClick(page.locator('#sp-track-cards .bc-card').first())
    // Pick the first bike (Cruiser comes first in BIKE_VARIANTS).
    // Clicking a bike auto-commits the race URL.
    await softClick(page.locator('#sp-bike-cards .bc-card').first())
    const url = await waitForCommit(page, /race=1/)
    expect(url).toMatch(/track=/)
    expect(url).toMatch(/bike=/)
    // Race mode never stamps `cup=` or `tt=1`.
    expect(url).not.toContain('cup=')
    expect(url).not.toContain('tt=1')
  })

  test('Time Trial path commits a race URL with tt=1', async ({ page }) => {
    await gotoAndStart(page)
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
    const url = await waitForCommit(page, /race=1/)
    expect(url).toContain('tt=1')
    expect(url).toMatch(/track=/)
    expect(url).toMatch(/bike=/)
    // TT is a single-track flow — no cup wiring.
    expect(url).not.toContain('cup=')
  })

  test('Cup path commits a championship URL with cup= + first race track', async ({ page }) => {
    await gotoAndStart(page)
    await clickModeCard(page, 'cup')
    // First cup card is Reef Cup — `V1_CUPS[0]`. Dev placeholder + Dev
    // Cup get appended after the ship cups, so `.first()` is stable.
    await softClick(page.locator('#sp-cup-cards .bc-card').first())
    // Championship cups skip the lineup-preview step and land directly
    // on bike-select. Pick the first bike to commit the cup.
    await softClick(page.locator('#sp-bike-cards .bc-card').first())
    const url = await waitForCommit(page, /race=1/)
    expect(url).toContain('cup=reef')
    // First race in Reef Cup's lineup is `sandbar` (first matching v1
    // track in catalog order).
    expect(url).toContain('track=sandbar')
    expect(url).toMatch(/bike=/)
    // Cup mode is a championship — TT flag should never appear.
    expect(url).not.toContain('tt=1')
  })

  test('MP entry "CREATE LOBBY" navigates to a room code URL', async ({ page }) => {
    // Multiplayer forks off the TITLE screen now, not the mode picker —
    // the mode screen is the single-player branch only.
    await page.goto('/')
    await expect(page.locator('.bc-title .word')).toBeVisible()
    await softClick(page.locator('#title-multi'))
    // CREATE LOBBY button is the first card on the MP entry screen.
    await softClick(page.locator('.bc-mode-card[data-action="create"]'))
    expect(await waitForCommit(page, /[?&]room=/)).toMatch(/[?&]room=[A-Z0-9-]+/)
  })
})

/**
 * The mode screen's job is picking a format. Three "…" links competing
 * with that got moved somewhere they belong: Credits + Making of into
 * Settings → About, and Leaderboards onto the track pickers, where a
 * board is about the venue in front of you.
 */
test.describe('mode-screen link relocation', () => {
  test('mode screen keeps only BACK and SETTINGS', async ({ page }) => {
    await gotoAndStart(page)
    await expect(page.locator('#mode-cards')).toBeVisible()
    for (const gone of ['#mode-leaderboards', '#mode-credits', '#mode-making-of']) {
      expect(await page.locator(gone).count(), `${gone} is still on the mode screen`).toBe(0)
    }
    await expect(page.locator('#mode-settings')).toBeVisible()
  })

  test('track pickers carry the leaderboards link, and BACK returns there', async ({ page }) => {
    await gotoAndStart(page)
    await clickModeCard(page, 'race')
    await expect(page.locator('#sp-track-cards .bc-card').first()).toBeVisible()
    await softClick(page.locator('#sp-track-leaderboards'))
    // Leaderboard opened; BACK must land on the picker we came from
    // rather than dumping us on the mode screen.
    await softClick(page.locator('#lb-back'))
    await expect(page.locator('#sp-track-cards .bc-card').first()).toBeVisible()
  })

  test('Time Trial venue picker offers leaderboards too', async ({ page }) => {
    await gotoAndStart(page)
    await clickModeCard(page, 'time-trial')
    await expect(page.locator('#sp-cup-track-cards .bc-card').first()).toBeVisible()
    await expect(page.locator('#sp-cup-tracks-leaderboards')).toBeVisible()
  })

  test('Settings → About holds credits + making of', async ({ page }) => {
    await gotoAndStart(page)
    await softClick(page.locator('#mode-settings'))
    await expect(page.locator('#settings-menu')).toHaveClass(/show/)
    await softClick(page.locator('#sm-tabs .sm-tab', { hasText: 'ABOUT' }))
    await expect(page.locator('.sm-row[data-row="about-credits"]')).toBeVisible()
    await expect(page.locator('.sm-row[data-row="about-making-of"]')).toBeVisible()
    // Credits are a menu step, so the row is live here (a mid-race
    // Settings open leaves it disabled instead) and closes the overlay.
    await softClick(page.locator('.sm-row[data-row="about-credits"] button'))
    await expect(page.locator('#credits-back')).toBeVisible()
    await softClick(page.locator('#credits-back'))
    await expect(page.locator('#mode-cards')).toBeVisible()
  })
})
