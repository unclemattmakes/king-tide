import { describe, expect, it } from 'vitest'
import { V1_CUPS, V1_TRACKS } from '../../src/engine/menus/tracks-catalog'

/**
 * Cup lineups are derived from each track's `cup` field, so these guard the
 * reworked Reef / Harbor / Continental rosters against an accidental
 * reshuffle. The Harbor Cup replaced the retired Open Sea Cup in the
 * drowned-harbor-cities pass: San Francisco moved up from Continental,
 * Shibuya backfilled Continental, and the pure-open-water tracks (The Maw,
 * Hatteras Light) parked to the B-list.
 */
describe('tracks-catalog cup lineups', () => {
  const cupRaces = (id: string): string[] => V1_CUPS.find((c) => c.id === id)?.races ?? []

  it('Reef Cup is Mayday Bay → Mexico City → Cape Town', () => {
    expect(cupRaces('reef')).toEqual(['sandbar', 'mexico-city', 'cape-town-drift'])
  })

  it('the Reef Cup ships — Mexico City is built + ungated', () => {
    const t = V1_TRACKS.find((x) => x.id === 'mexico-city')
    expect(t?.status).toBe('ship')
    expect(t?.gateLabel).toBe('')
    // All three Reef tracks are built + wired, so the cup runs ungated.
    expect(V1_CUPS.find((c) => c.id === 'reef')?.status).toBe('ship')
  })

  it('Harbor Cup is Needle Sound → Golden Gate Drowned → Opera Drowned', () => {
    expect(cupRaces('harbor')).toEqual(['needle-sound', 'golden-gate-drowned', 'opera-drowned'])
  })

  it('Golden Gate Drowned moved out of Continental into the Harbor cup', () => {
    expect(V1_TRACKS.find((t) => t.id === 'golden-gate-drowned')?.cup).toBe('harbor')
    expect(cupRaces('continental')).not.toContain('golden-gate-drowned')
  })

  it('Continental backfills Golden Gate with Shibuya Submerged', () => {
    expect(cupRaces('continental')).toEqual([
      'marina-bay-7',
      'doges-drift',
      'shibuya-submerged',
      'kilauea-crown',
    ])
    expect(V1_TRACKS.find((t) => t.id === 'shibuya-submerged')?.cup).toBe('continental')
  })

  it('the Drowned cup is untouched', () => {
    expect(cupRaces('drowned')).toEqual(['aqualand', 'angkor-drowned', 'liberty-drowned'])
  })

  it('The Maw and Hatteras Light are parked — absent from the catalog + every cup roster', () => {
    expect(V1_TRACKS.some((t) => t.id === 'the-maw')).toBe(false)
    expect(V1_TRACKS.some((t) => t.id === 'hatteras-light')).toBe(false)
    for (const cup of V1_CUPS) {
      expect(cup.races).not.toContain('the-maw')
      expect(cup.races).not.toContain('hatteras-light')
    }
  })

  it('the new Harbor concepts are gated until their geometry is built', () => {
    for (const id of ['needle-sound', 'opera-drowned']) {
      const t = V1_TRACKS.find((x) => x.id === id)
      expect(t?.status).toBe('pending')
      expect(t?.gateLabel.length ?? 0).toBeGreaterThan(0)
    }
    // The cup can't run a championship through two unbuilt tracks, so the
    // cup tile is gated too — even though its SF leg is shippable.
    expect(V1_CUPS.find((c) => c.id === 'harbor')?.status).toBe('pending')
  })

  it('every cup keeps a non-empty, gap-free race list', () => {
    for (const cup of V1_CUPS) {
      expect(cup.races.length).toBeGreaterThan(0)
      for (const trackId of cup.races) {
        expect(V1_TRACKS.some((t) => t.id === trackId)).toBe(true)
      }
    }
  })
})
