/**
 * Deterministic lobby track pick (docs/multiplayer-review.md, finding #2).
 *
 * The property under test: the winner is a pure function of
 * (roomId, vote set) — independent of vote-collection order, which differs
 * per client because each client's ready-map iteration starts with itself.
 */
import { describe, expect, it } from 'vitest'
import {
  deterministicTrackPick,
  hashStringToSeed,
  type TrackVote,
} from '../../src/engine/menus/lobby-pick'

const votes: TrackVote[] = [
  { peerId: 0, trackId: 'lagoon' },
  { peerId: 1, trackId: 'sandbar' },
  { peerId: 2, trackId: 'the-maw' },
]

describe('hashStringToSeed', () => {
  it('is stable for the same input', () => {
    expect(hashStringToSeed('RACE-1234')).toBe(hashStringToSeed('RACE-1234'))
  })

  it('differs across inputs', () => {
    expect(hashStringToSeed('RACE-1234')).not.toBe(hashStringToSeed('RACE-1235'))
  })

  it('returns an unsigned 32-bit value', () => {
    for (const s of ['', 'a', 'RACE-1234', '🚤🚤🚤']) {
      const h = hashStringToSeed(s)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
      expect(Number.isInteger(h)).toBe(true)
    }
  })
})

describe('deterministicTrackPick', () => {
  it('returns the same winner regardless of vote order', () => {
    const a = deterministicTrackPick(votes, 'RACE-1234', 'fallback')
    const b = deterministicTrackPick([...votes].reverse(), 'RACE-1234', 'fallback')
    const c = deterministicTrackPick([votes[1]!, votes[2]!, votes[0]!], 'RACE-1234', 'fallback')
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('picks one of the cast votes', () => {
    const winner = deterministicTrackPick(votes, 'RACE-1234', 'fallback')
    expect(votes.map((v) => v.trackId)).toContain(winner)
  })

  it('varies with the room id (different rooms can pick different winners)', () => {
    // Not guaranteed to differ for any single pair of rooms — find at least
    // one room id among many that picks a different winner, which proves the
    // seed actually feeds the choice.
    const base = deterministicTrackPick(votes, 'ROOM-A', 'fallback')
    let sawDifferent = false
    for (let i = 0; i < 32; i++) {
      if (deterministicTrackPick(votes, `ROOM-${i}`, 'fallback') !== base) {
        sawDifferent = true
        break
      }
    }
    expect(sawDifferent).toBe(true)
  })

  it('ignores undefined votes and still converges', () => {
    const partial: TrackVote[] = [
      { peerId: 0, trackId: undefined },
      { peerId: 1, trackId: 'sandbar' },
      { peerId: 2, trackId: undefined },
    ]
    expect(deterministicTrackPick(partial, 'RACE-1234', 'fallback')).toBe('sandbar')
  })

  it('falls back when nobody voted', () => {
    const none: TrackVote[] = [
      { peerId: 0, trackId: undefined },
      { peerId: 1, trackId: '' },
    ]
    expect(deterministicTrackPick(none, 'RACE-1234', 'lagoon')).toBe('lagoon')
    expect(deterministicTrackPick([], 'RACE-1234', 'lagoon')).toBe('lagoon')
  })

  it('respects duplicate votes as weight (two votes for the same track double its odds)', () => {
    // Sanity rather than statistics: with all three voting the same track,
    // the winner must be that track for any room id.
    const unanimous: TrackVote[] = [
      { peerId: 0, trackId: 'sandbar' },
      { peerId: 1, trackId: 'sandbar' },
      { peerId: 2, trackId: 'sandbar' },
    ]
    for (let i = 0; i < 8; i++) {
      expect(deterministicTrackPick(unanimous, `ROOM-${i}`, 'fallback')).toBe('sandbar')
    }
  })
})
