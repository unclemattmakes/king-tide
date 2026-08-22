/**
 * Cross-catalog consistency — three hand-maintained track tables share
 * ids but had no shared key or drift test, and it showed in production:
 * Mayday Bay's venue card said REEF CUP while its race intro plate said
 * TUTORIAL CUP (menu tracks-catalog vs. sim theme-catalog disagreeing),
 * and the leaderboard min-lap table quietly kept entries for parked
 * tracks. This pins the three tables together:
 *
 *   - src/engine/menus/tracks-catalog.ts   (venue cards, cup rosters)
 *   - src/game/tracks/theme-catalog.ts     (race intro plate)
 *   - src/engine/leaderboard/protocol.ts   (min-lap sanity floors)
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIN_LAP_SECONDS_BY_TRACK } from '../../src/engine/leaderboard/protocol'
import { V1_TRACKS } from '../../src/engine/menus/tracks-catalog'
import { getTrackTheme } from '../../src/game/tracks/theme-catalog'

const TRACKS_DIR = path.resolve(__dirname, '../../public/tracks')

const CUP_DISPLAY: Record<string, string> = {
  reef: 'Reef',
  harbor: 'Harbor',
  continental: 'Continental',
  drowned: 'Drowned',
}

const shipTracks = V1_TRACKS.filter((t) => t.status === 'ship')

describe('catalog consistency', () => {
  it('every shipped venue has an explicit intro-plate theme (no fallback)', () => {
    for (const t of shipTracks) {
      expect(getTrackTheme(t.id), `theme-catalog entry missing for ${t.id}`).not.toBeNull()
    }
  })

  it('the intro plate and the venue card agree on the cup', () => {
    for (const t of shipTracks) {
      const theme = getTrackTheme(t.id)
      if (!theme) continue // covered by the test above
      expect(theme.cup, `cup label drift on ${t.id}`).toBe(CUP_DISPLAY[t.cup])
    }
  })

  it('every shipped venue has a leaderboard min-lap floor', () => {
    for (const t of shipTracks) {
      expect(
        MIN_LAP_SECONDS_BY_TRACK[t.id],
        `MIN_LAP_SECONDS_BY_TRACK missing ${t.id}`,
      ).toBeGreaterThan(0)
    }
  })

  it('the venue card promises the lap count the track JSON actually runs', () => {
    // Race completion checks `track.lapsToFinish` (race.ts) — a card
    // that says 1 lap over a 3-lap JSON understates the commitment 3×.
    // Sandbar shipped exactly that drift for a while (evaluation
    // game-design #9); this pins every catalog entry with a JSON twin.
    for (const t of V1_TRACKS) {
      const jsonPath = path.join(TRACKS_DIR, `${t.id}.json`)
      if (!fs.existsSync(jsonPath)) continue // procedural / not-yet-authored venues
      const spec = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as { lapsToFinish?: number }
      if (typeof spec.lapsToFinish !== 'number') continue
      expect(t.laps, `venue card laps drift on ${t.id}`).toBe(spec.lapsToFinish)
    }
  })

  it('no live catalog copy still sells the cut anti-grav mechanic', () => {
    // Anti-grav is cut (parked for a possible DLC — CLAUDE.md "Current
    // direction"). Liberty's card shipped "anti-grav showcase" copy long
    // after the cut, hidden only by the Drowned Cup being off the card —
    // a landmine for the day that cup unlocks.
    for (const t of V1_TRACKS) {
      expect(
        `${t.setPiece} ${t.location}`.toLowerCase(),
        `v1-historical anti-grav copy on ${t.id}`,
      ).not.toContain('anti-grav')
    }
  })

  it('exactly the dressed venues carry art: dressed', () => {
    // Update alongside the v2 art pass: only Mayday Bay + Angel Basin
    // are art-complete today (CLAUDE.md "status: 'ship' means
    // wired/playable, not art-complete"). The Maw is also dressed but
    // deliberately parked off the card (docs/tracks/the-maw.md).
    const dressed = V1_TRACKS.filter((t) => t.art === 'dressed').map((t) => t.id)
    expect(dressed.sort()).toEqual(['mexico-city', 'sandbar'])
  })
})
