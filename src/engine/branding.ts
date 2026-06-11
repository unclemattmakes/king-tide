/**
 * Product branding — the name in ONE place.
 *
 * "Hoverbike" was the working title; the current pick is "King Tide"
 * (the year's highest tide, reclaimed as the name of the championship —
 * see docs/ui-art-direction.md for the full pitch + runners-up).
 *
 * Everything player-facing reads from here: the title-screen wordmark,
 * the multiplayer lobby overlay, and the credits. Two static strings in
 * `index.html` (the loading screen + the <title> tag) can't import this
 * module — they carry a "keep in sync with branding.ts" comment instead.
 */

/** Wordmark form — all-caps, used by display surfaces. */
export const GAME_TITLE = 'KING TIDE'

/** Prose form — used mid-sentence (credits, copy). */
export const GAME_TITLE_PROSE = 'King Tide'

/** One-line setting hook shown under the wordmark. */
export const GAME_TAGLINE = 'Hover-racing on the drowned coast'
