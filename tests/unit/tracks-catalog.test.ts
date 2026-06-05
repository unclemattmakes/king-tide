import { describe, expect, it } from 'vitest'
import { V1_CUPS, V1_TRACKS } from '../../src/engine/menus/tracks-catalog'

/**
 * Cup lineups are derived from each track's `cup` field, so these guard the
 * reworked Reef / Open Sea rosters against an accidental reshuffle.
 */
describe('tracks-catalog cup lineups', () => {
  const cupRaces = (id: string): string[] => V1_CUPS.find((c) => c.id === id)?.races ?? []

  it('Reef Cup is Sandbar → South Beach Sunken → Cape Town', () => {
    expect(cupRaces('reef')).toEqual(['sandbar', 'south-beach-sunken', 'cape-town-drift'])
  })

  it('Open Sea Cup gains Hatteras Light after the original two', () => {
    expect(cupRaces('open-sea')).toEqual(['the-maw', 'shibuya-submerged', 'hatteras-light'])
  })

  it('Hatteras Light is tagged into the Open Sea cup, not Reef', () => {
    const hatteras = V1_TRACKS.find((t) => t.id === 'hatteras-light')
    expect(hatteras?.cup).toBe('open-sea')
    expect(V1_TRACKS.filter((t) => t.cup === 'reef').map((t) => t.id)).not.toContain('hatteras-light')
  })

  it('the other cups are untouched', () => {
    expect(cupRaces('continental')).toEqual([
      'marina-bay-7',
      'doges-drift',
      'golden-gate-drowned',
      'kilauea-crown',
    ])
    expect(cupRaces('drowned')).toEqual(['aqualand', 'angkor-drowned', 'liberty-drowned'])
  })

  it('every ship cup keeps a non-empty, gap-free race list', () => {
    for (const cup of V1_CUPS) {
      expect(cup.races.length).toBeGreaterThan(0)
      for (const trackId of cup.races) {
        expect(V1_TRACKS.some((t) => t.id === trackId)).toBe(true)
      }
    }
  })
})
