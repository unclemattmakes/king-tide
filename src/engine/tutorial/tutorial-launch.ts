/**
 * Tutorial launch — URL-building helpers shared by the Settings
 * "Replay tutorial" button and the menu's Practice screen. This module
 * OWNS the coached-run launch recipe: every entry point that arms the
 * beat director builds its URL here, so load-bearing params (like the
 * practice lagoon's solo `ai=0`) can't drift between doors.
 *
 * The replay path preserves the player's current `track` + `bike` URL
 * params so the tutorial replays on whatever track they were just
 * looking at, falling back to the default tutorial venue when there
 * are no current params (cold boot from a fresh main-menu open into
 * Settings).
 */

import { PRACTICE_LAGOON_TRACK_ID } from './script-catalog'

/** The venue a fresh tutorial runs on. Mayday Bay (slug `sandbar`) is
 *  the dressed tutorial lagoon — the docs' "tutorial lagoon" — so a
 *  brand-new player's first minute lands on real art, not the
 *  procedural lagoon dev fixture. */
export const DEFAULT_TUTORIAL_TRACK = 'sandbar'

/** Build the `?race=1&track=…&bike=…&tutorial=1` href for a coached
 *  run on a specific venue. The single source of the recipe: the
 *  practice lagoon always gets `ai=0` (its venue card promises solo
 *  water, and the tutorial escort min() in race-boot would otherwise
 *  spawn 2 casual bikes onto the station course). */
export function buildCoachedRunHref(
  trackId: string,
  bikeId: string | null,
  baseHref?: string,
): string {
  const href =
    baseHref ?? (typeof window !== 'undefined' ? window.location.href : 'http://localhost/')
  const url = new URL(href)
  url.search = ''
  url.searchParams.set('race', '1')
  url.searchParams.set('track', trackId)
  if (bikeId) url.searchParams.set('bike', bikeId)
  url.searchParams.set('tutorial', '1')
  if (trackId === PRACTICE_LAGOON_TRACK_ID) url.searchParams.set('ai', '0')
  return url.toString()
}

/** Build the Settings → "Replay tutorial" href. Reads the current
 *  page's URL for track/bike so the coached run replays on whatever
 *  venue the player is on (a replay from a practice-lagoon session
 *  keeps the station course — and, via `buildCoachedRunHref`, its
 *  solo water).
 *
 *  Both args are optional and exist purely to make the function
 *  callable from non-browser contexts (tests, headless tools). In
 *  the browser the caller should rely on the `window.location`
 *  defaults. */
export function buildReplayTutorialHref(currentSearch?: string, baseHref?: string): string {
  const search = currentSearch ?? (typeof window !== 'undefined' ? window.location.search : '')
  const params = new URLSearchParams(search)
  return buildCoachedRunHref(
    params.get('track') ?? DEFAULT_TUTORIAL_TRACK,
    params.get('bike'),
    baseHref,
  )
}
