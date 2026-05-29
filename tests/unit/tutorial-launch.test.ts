/**
 * Tutorial-launch URL builder. Shared by the Settings "Replay
 * tutorial" button and (effectively, via the same shape) the
 * menu-flow's tutorial mode tile.
 *
 * Round-trips: preserves track + bike picks from the caller's URL
 * search and stamps `tutorial=1` + `race=1` on top. Falls back to
 * `lagoon` when no track is in the URL — that's the default ship
 * track the rest of the menu defaults to.
 */

import { describe, expect, it } from 'vitest'
import { buildReplayTutorialHref } from '../../src/engine/tutorial/tutorial-launch'

describe('buildReplayTutorialHref', () => {
  it('stamps tutorial=1 + race=1 onto the current track', () => {
    const url = new URL(buildReplayTutorialHref('?track=storm-king&bike=racer'))
    expect(url.searchParams.get('tutorial')).toBe('1')
    expect(url.searchParams.get('race')).toBe('1')
    expect(url.searchParams.get('track')).toBe('storm-king')
    expect(url.searchParams.get('bike')).toBe('racer')
  })

  it('falls back to lagoon when no track param is present', () => {
    const url = new URL(buildReplayTutorialHref(''))
    expect(url.searchParams.get('track')).toBe('lagoon')
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
})
