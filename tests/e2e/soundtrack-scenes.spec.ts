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
 * Everything is derived from the generated manifest rather than hard-coded,
 * because scene assignment is *content*: it comes from the content-dir
 * `playlists.json`, which is expected to be re-authored. Picking the tracks
 * to exercise from the manifest is what stops this spec rotting the next
 * time a venue's set changes. It self-skips where nothing is scoped (a clone
 * whose content dir has no playlists.json bakes no scenes, and then every
 * surface legitimately plays the full pool).
 */
import { expect, test } from '@playwright/test'
import { levelPlaylist, menuPlaylist } from '../../src/engine/audio/soundtrack'
import { SOUNDTRACK } from '../../src/engine/audio/soundtrack.generated'

const titles = (list: readonly { title: string }[]) => list.map((e) => e.title)

const LEVEL_TAGS = [
  ...new Set(SOUNDTRACK.flatMap((e) => e.scenes ?? []).filter((t) => t.startsWith('level:'))),
]
const MENU_TITLES = titles(SOUNDTRACK.filter((e) => e.scenes?.includes('menu')))
const UNSCOPED_TITLES = titles(SOUNDTRACK.filter((e) => !e.scenes || e.scenes.length === 0))

/** A track that HAS its own set — prefer the Reef Cup, else whatever is
 *  assigned. Its playlist is what a race there must draw from. */
const ASSIGNED_TRACK =
  ['sandbar', 'mexico-city', 'cape-town-drift'].find((t) => LEVEL_TAGS.includes(`level:${t}`)) ??
  LEVEL_TAGS[0]?.slice('level:'.length)

/** A real, bootable track with NO set of its own — exercises the fallback. */
const UNASSIGNED_TRACK = ['the-maw', 'oval-loop', 'figure-eight'].find(
  (t) => !LEVEL_TAGS.includes(`level:${t}`),
)

/** Wait for the credit toast to name a song, and return that title. */
async function nowPlaying(page: import('@playwright/test').Page): Promise<string> {
  const title = page.locator('#music-credit .mc-title')
  await expect(title).not.toBeEmpty({ timeout: 30_000 })
  return ((await title.textContent()) ?? '').trim()
}

test.describe('scene-scoped soundtrack', () => {
  test.skip(
    MENU_TITLES.length === 0 || LEVEL_TAGS.length === 0,
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

  test('a race on an assigned track plays that venue’s own set', async ({ page }) => {
    test.skip(!ASSIGNED_TRACK, 'no level has its own playlist')
    const expected = titles(levelPlaylist(SOUNDTRACK, ASSIGNED_TRACK as string))

    await page.goto(`/?autostart=1&track=${ASSIGNED_TRACK}`)
    const playing = await nowPlaying(page)
    expect(expected, `"${playing}" should be in ${ASSIGNED_TRACK}'s playlist`).toContain(playing)
    // The venue set must be distinguishable from the front-end set, else this
    // would pass on a radio that simply ignored the scene.
    if (!titles(menuPlaylist(SOUNDTRACK)).some((t) => expected.includes(t))) {
      expect(MENU_TITLES).not.toContain(playing)
    }
  })

  test('a race on an unassigned track falls back to the default pool', async ({ page }) => {
    test.skip(!UNASSIGNED_TRACK, 'every candidate fallback track has its own playlist')
    test.skip(UNSCOPED_TITLES.length === 0, 'no unscoped songs — pool is the full set')

    await page.goto(`/?autostart=1&track=${UNASSIGNED_TRACK}`)
    const playing = await nowPlaying(page)
    expect(UNSCOPED_TITLES, `"${playing}" should be a default-pool song`).toContain(playing)
  })
})
