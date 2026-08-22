/**
 * Tutorial-launch URL builder. Shared by the Settings "Replay
 * tutorial" button and (effectively, via the same shape) the
 * menu-flow's tutorial mode tile.
 *
 * Round-trips: preserves track + bike picks from the caller's URL
 * search and stamps `tutorial=1` + `race=1` on top. Falls back to
 * `sandbar` (Mayday Bay, the dressed tutorial lagoon) when no track
 * is in the URL — a new player's first minute must land on real art,
 * not the procedural lagoon dev fixture.
 */

import { describe, expect, it } from 'vitest'
import { PRACTICE_LAGOON_TRACK_ID } from '../../src/engine/tutorial/script-catalog'
import {
  buildCoachedRunHref,
  buildReplayTutorialHref,
} from '../../src/engine/tutorial/tutorial-launch'

describe('buildReplayTutorialHref', () => {
  it('stamps tutorial=1 + race=1 onto the current track', () => {
    const url = new URL(buildReplayTutorialHref('?track=storm-king&bike=racer'))
    expect(url.searchParams.get('tutorial')).toBe('1')
    expect(url.searchParams.get('race')).toBe('1')
    expect(url.searchParams.get('track')).toBe('storm-king')
    expect(url.searchParams.get('bike')).toBe('racer')
  })

  it('falls back to sandbar (Mayday Bay) when no track param is present', () => {
    const url = new URL(buildReplayTutorialHref(''))
    expect(url.searchParams.get('track')).toBe('sandbar')
    expect(url.searchParams.get('tutorial')).toBe('1')
  })

  it('omits the bike param when the source had no bike', () => {
    const url = new URL(buildReplayTutorialHref('?track=south-beach'))
    expect(url.searchParams.has('bike')).toBe(false)
    expect(url.searchParams.get('track')).toBe('south-beach')
  })

  it('drops other URL params (clean tutorial route)', () => {
    // `?room=…` from a multiplayer flow shouldn't carry into the
    // single-player tutorial launch.
    const url = new URL(buildReplayTutorialHref('?track=lagoon&room=abc&debug=collision'))
    expect(url.searchParams.has('room')).toBe(false)
    expect(url.searchParams.has('debug')).toBe(false)
  })

  it('a replay from a practice-lagoon session keeps its solo water (ai=0)', () => {
    // Regression pin: Settings → "Replay tutorial" preserves the
    // current track, and the practice lagoon's card promises SOLO
    // WATER — without ai=0 the tutorial escort min() in race-boot
    // would spawn 2 casual bikes onto the station course.
    const url = new URL(buildReplayTutorialHref(`?track=${PRACTICE_LAGOON_TRACK_ID}&bike=racer`))
    expect(url.searchParams.get('track')).toBe(PRACTICE_LAGOON_TRACK_ID)
    expect(url.searchParams.get('ai')).toBe('0')
    // ...and only the lagoon gets it — sandbar's First Run keeps its
    // gentle escort.
    const sandbar = new URL(buildReplayTutorialHref('?track=sandbar'))
    expect(sandbar.searchParams.has('ai')).toBe(false)
  })
})

describe('buildCoachedRunHref', () => {
  it('is the single recipe both menu cards and the replay button share', () => {
    const first = new URL(buildCoachedRunHref('sandbar', 'cruiser', 'http://localhost/'))
    expect(first.searchParams.get('race')).toBe('1')
    expect(first.searchParams.get('tutorial')).toBe('1')
    expect(first.searchParams.get('track')).toBe('sandbar')
    expect(first.searchParams.get('bike')).toBe('cruiser')
    expect(first.searchParams.has('ai')).toBe(false)
    const lagoon = new URL(
      buildCoachedRunHref(PRACTICE_LAGOON_TRACK_ID, 'cruiser', 'http://localhost/'),
    )
    expect(lagoon.searchParams.get('ai')).toBe('0')
  })
})
