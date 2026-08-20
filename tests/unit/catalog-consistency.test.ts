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

import { describe, expect, it } from 'vitest'
import { MIN_LAP_SECONDS_BY_TRACK } from '../../src/engine/leaderboard/protocol'
import { V1_TRACKS } from '../../src/engine/menus/tracks-catalog'
import { getTrackTheme } from '../../src/game/tracks/theme-catalog'

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

  it('exactly the dressed venues carry art: dressed', () => {
    // Update alongside the v2 art pass: only Mayday Bay + Angel Basin
    // are art-complete today (CLAUDE.md "status: 'ship' means
    // wired/playable, not art-complete"). The Maw is also dressed but
    // deliberately parked off the card (docs/tracks/the-maw.md).
    const dressed = V1_TRACKS.filter((t) => t.art === 'dressed').map((t) => t.id)
    expect(dressed.sort()).toEqual(['mexico-city', 'sandbar'])
  })
})
