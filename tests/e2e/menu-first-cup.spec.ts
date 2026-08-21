import { expect, type Locator, type Page, test } from '@playwright/test'

/**
 * The "first cup only" menu pass. Three behaviours, verified against the
 * real menus rather than the catalogue data (`tests/unit/tracks-catalog`
 * already pins the data — this is the wiring):
 *
 *  1. Race → TRACK lists exactly the Reef slate, and no Harbor /
 *     Continental / Drowned venue leaks onto the card.
 *  2. The two renamed venues read as fictional cities everywhere the
 *     player meets them (tile, bike-screen readout).
 *  3. Cup select offers only the Reef Cup (plus the dev-build cups,
 *     which are gated on `isDevBuild()`, not on cup visibility).
 *  4. `?back=1&menu=track` — what the finish screen's NEXT RACE now
 *     stamps — opens straight on the venue picker.
 *
 * Same two software-rendering accommodations as `menu-flow.spec.ts`:
 * reduced motion so the bc-rise transition doesn't fight actionability,
 * and a raised timeout for cold boot.
 */
test.use({ contextOptions: { reducedMotion: 'reduce' } })

test.describe.configure({ timeout: 120_000 })

/** Venues that must NOT appear now the card is Reef-only. */
const HIDDEN_VENUES = [
  'Needle Sound',
  'Golden Gate Drowned',
  'Opera Drowned',
  'Marina Bay 7',
  'Doge’s Drift',
  'Shibuya Submerged',
  'Kilauea Crown',
  'Aqualand',
  'Angkor Drowned',
  'Liberty Drowned',
]

async function softClick(loc: Locator): Promise<void> {
  await expect(loc).toBeVisible()
  await loc.click({ force: true })
}

/** Cold-boot to the mode screen. The Enter has to wait for the title to
 *  actually mount — `runMenuFlow` installs its keydown listener as the
 *  last thing it does, so a press fired straight after `goto` is
 *  swallowed and the flow sits on the title. */
async function openMode(page: Page, mode: string): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.bc-title .word')).toBeVisible()
  await page.keyboard.press('Enter')
  await softClick(page.locator(`.bc-mode-card[data-mode="${mode}"]`))
}

async function gotoTrackSelect(page: Page): Promise<void> {
  await openMode(page, 'race')
  await expect(page.locator('#sp-track-cards .bc-card').first()).toBeVisible()
}

/** The bike-card click resolves the menu promise, but `url-modes` then
 *  tears the attract loop down (up to a 1.5 s race + a 200 ms grace)
 *  before it navigates — so poll the URL rather than assuming the
 *  navigation has already started. */
async function waitForRaceUrl(page: Page): Promise<string> {
  await page.waitForURL(/race=1/, { timeout: 30_000 })
  return page.url()
}

test.describe('menus show only the first cup', () => {
  test('Race → TRACK lists exactly the three Reef venues', async ({ page }) => {
    await gotoTrackSelect(page)
    // Dev builds append one dev sample below the ship venues; filter it
    // out by its DEV badge, same as the CUP and Time Trial specs below.
    const shipVenues = page.locator('#sp-track-cards .bc-card:not(:has(.bc-dev-badge)) .name')
    expect((await shipVenues.allInnerTexts()).map((n) => n.trim())).toEqual([
      'MAYDAY BAY',
      'ANGEL BASIN',
      'CONTAINER CHAOS',
    ])
  })

  test('the venue pickers carry ONE dev sample, not the whole dev bin', async ({ page }) => {
    // The Dev Cup holds 30+ playtest tracks. Single Race and Time Trial
    // each show exactly one as a sample of the shape — listing them all
    // buried the three real venues they sit beside. Dev builds only;
    // production renders no dev content at all, so this asserts "at most
    // one" and pins the ceiling rather than requiring one to exist.
    await gotoTrackSelect(page)
    expect(await page.locator('#sp-track-cards .bc-dev-badge').count()).toBeLessThanOrEqual(1)
    await openMode(page, 'time-trial')
    await expect(page.locator('#sp-cup-track-cards .bc-card').first()).toBeVisible()
    expect(await page.locator('#sp-cup-track-cards .bc-dev-badge').count()).toBeLessThanOrEqual(1)
  })

  test('no later-cup venue leaks onto the track card', async ({ page }) => {
    await gotoTrackSelect(page)
    const body = (await page.locator('#sp-track-cards').innerText()).toUpperCase()
    for (const venue of HIDDEN_VENUES) {
      expect(body, `${venue} is still on the card`).not.toContain(venue.toUpperCase())
    }
    // The gated-tile convention should have nothing left to gate — every
    // visible Reef venue ships.
    expect(await page.locator('#sp-track-cards .bc-card.bc-disabled').count()).toBe(0)
  })

  test('CUP select offers the Reef Cup only', async ({ page }) => {
    await openMode(page, 'cup')
    await expect(page.locator('#sp-cup-cards .bc-card').first()).toBeVisible()
    // Dev builds append the two dev cups; they're gated on isDevBuild(),
    // not on cup visibility, so filter them out by their DEV badge.
    const shipCups = page.locator('#sp-cup-cards .bc-card:not(:has(.bc-dev-badge)) .name')
    expect((await shipCups.allInnerTexts()).map((n) => n.trim())).toEqual(['REEF CUP'])
  })

  test('Time Trial venue picker is the Reef slate too', async ({ page }) => {
    await openMode(page, 'time-trial')
    await expect(page.locator('#sp-cup-track-cards .bc-card').first()).toBeVisible()
    const shipVenues = page.locator('#sp-cup-track-cards .bc-card:not(:has(.bc-dev-badge)) .name')
    expect((await shipVenues.allInnerTexts()).map((n) => n.trim())).toEqual([
      'MAYDAY BAY',
      'ANGEL BASIN',
      'CONTAINER CHAOS',
    ])
  })
})

test.describe('renamed venues read fictional', () => {
  test('no real-world city name survives on the track card', async ({ page }) => {
    await gotoTrackSelect(page)
    const body = (await page.locator('#sp-track-cards').innerText()).toUpperCase()
    for (const real of ['MEXICO CITY', 'CAPE TOWN', 'TABLE MOUNTAIN', 'REFORMA']) {
      expect(body, `track card still says ${real}`).not.toContain(real)
    }
  })

  test('the bike screen reads back the fictional name', async ({ page }) => {
    await gotoTrackSelect(page)
    // Second tile is the renamed Angel Basin (slug still `mexico-city`).
    await softClick(page.locator('#sp-track-cards .bc-card').nth(1))
    await expect(page.locator('#bike-track-readout')).toHaveText('ANGEL BASIN')
  })

  test('committing Angel Basin still races the mexico-city slug', async ({ page }) => {
    await gotoTrackSelect(page)
    await softClick(page.locator('#sp-track-cards .bc-card').nth(1))
    await softClick(page.locator('#sp-bike-cards .bc-card').first())
    // The rename is display-only: GLBs, track JSON and the saved best-lap
    // ledger all still key off the original slug.
    expect(await waitForRaceUrl(page)).toContain('track=mexico-city')
  })
})

test.describe('NEXT RACE routes to track select', () => {
  test('?back=1&menu=track opens on the venue picker, not the title', async ({ page }) => {
    await page.goto('/?back=1&menu=track')
    await expect(page.locator('#sp-track-cards .bc-card').first()).toBeVisible()
    // Title + mode screens must not be the visible one.
    expect(await page.locator('.bc-title.show').count()).toBe(0)
    // Breadcrumbs should read as the RACE path with TRACK current.
    await expect(page.locator('#menu-crumbs .bc-crumb.is-current')).toHaveText('TRACK')
  })

  test('picking from there commits a normal single race', async ({ page }) => {
    await page.goto('/?back=1&menu=track')
    await softClick(page.locator('#sp-track-cards .bc-card').first())
    await softClick(page.locator('#sp-bike-cards .bc-card').first())
    const url = await waitForRaceUrl(page)
    expect(url).toContain('track=sandbar')
    // Not a cup leg — no championship param should ride along.
    expect(url).not.toContain('cup=')
  })

  test('back from the venue picker still reaches the mode screen', async ({ page }) => {
    await page.goto('/?back=1&menu=track')
    await expect(page.locator('#sp-track-cards .bc-card').first()).toBeVisible()
    await softClick(page.locator('#sp-track-back'))
    await expect(page.locator('.bc-mode-card[data-mode="race"]')).toBeVisible()
  })
})
