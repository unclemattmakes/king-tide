/**
 * Scene-scoped soundtrack — end-to-end proof that the right playlist plays
 * on the right surface, and that it starts without a "click to re-focus".
 *
 * The unit tests cover the resolvers as pure functions; what they can't show
 * is that the wiring picks the right scene at each entry point and that the
 * eager resume actually starts a song. Both are asserted here off the
 * now-playing credit toast (`#music-credit`), which is driven by the
 * jukebox's real `onSongChange` — so a passing run means a song genuinely
 * started, not merely that a playlist was computed.
 *
 * Scene assignment comes from the content-dir `playlists.json` baked into
 * `soundtrack.generated.ts`; this spec reads the manifest rather than
 * hard-coding titles, so re-authoring the playlists can't silently rot it.
 * It self-skips when nothing is tagged `menu` (a clone whose content dir has
 * no playlists.json bakes no scenes, and then every surface legitimately
 * plays the full pool).
 */
import { expect, test } from '@playwright/test'
import { SOUNDTRACK } from '../../src/engine/audio/soundtrack.generated'

const MENU_TITLES = SOUNDTRACK.filter((e) => e.scenes?.includes('menu')).map((e) => e.title)
const UNSCOPED_TITLES = SOUNDTRACK.filter((e) => !e.scenes || e.scenes.length === 0).map(
  (e) => e.title,
)

/** Wait for the credit toast to name a song, and return that title. */
async function nowPlaying(page: import('@playwright/test').Page): Promise<string> {
  const title = page.locator('#music-credit .mc-title')
  await expect(title).not.toBeEmpty({ timeout: 30_000 })
  return ((await title.textContent()) ?? '').trim()
}

test.describe('scene-scoped soundtrack', () => {
  test.skip(
    MENU_TITLES.length === 0 || UNSCOPED_TITLES.length === 0,
    'no playlists.json scene tags baked into the manifest — nothing to scope',
  )

  test('the menu plays a menu-tagged song, with no gesture', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#menu.show .bc-title', { timeout: 30_000 })

    // Deliberately no click/keypress before this: the eager resume in
    // installSoundtrackRadio is what has to start the music.
    const playing = await nowPlaying(page)
    expect(MENU_TITLES, `"${playing}" should be one of the menu-tagged songs`).toContain(playing)
  })

  test('a race on an unassigned track plays the default pool, not the menu set', async ({
    page,
  }) => {
    // `sandbar` has no `level:` assignment, so it resolves to the default
    // pool — which is what proves the race surface is scoped differently
    // from the menu rather than just reusing whatever played first.
    await page.goto('/?autostart=1&track=sandbar')
    const playing = await nowPlaying(page)
    expect(UNSCOPED_TITLES, `"${playing}" should be a default-pool song`).toContain(playing)
    expect(MENU_TITLES).not.toContain(playing)
  })
})
