/**
 * Tutorial launch — URL-building helper shared by the Settings
 * "Replay tutorial" button and the menu's tutorial mode tile.
 *
 * Preserves the player's current `track` + `bike` URL params so the
 * tutorial replays on whatever track they were just looking at.
 * Falls back to whatever defaults the page already knows when there
 * are no current params (cold boot from a fresh main-menu open into
 * Settings).
 */

const DEFAULT_TUTORIAL_TRACK = 'lagoon'

/** Build the `?race=1&track=…&bike=…&tutorial=1` href that drops
 *  the player into the tutorial-armed game loop. Reads the current
 *  page's URL for track/bike so the route is portable between the
 *  Settings overlay (called from the main menu, post-race finish
 *  screen, or pause menu) and the menu's tutorial mode tile.
 *
 *  Both args are optional and exist purely to make the function
 *  callable from non-browser contexts (tests, headless tools). In
 *  the browser the caller should rely on the `window.location`
 *  defaults. */
export function buildReplayTutorialHref(currentSearch?: string, baseHref?: string): string {
  const search = currentSearch ?? (typeof window !== 'undefined' ? window.location.search : '')
  const href =
    baseHref ?? (typeof window !== 'undefined' ? window.location.href : 'http://localhost/')
  const params = new URLSearchParams(search)
  const url = new URL(href)
  url.search = ''
  url.searchParams.set('race', '1')
  url.searchParams.set('track', params.get('track') ?? DEFAULT_TUTORIAL_TRACK)
  const bike = params.get('bike')
  if (bike) url.searchParams.set('bike', bike)
  url.searchParams.set('tutorial', '1')
  return url.toString()
}
