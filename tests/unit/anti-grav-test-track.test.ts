import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildTrackFromJson } from '../../src/game/tracks/json-loader'

describe('anti-grav-test.json fixture', () => {
  it('parses cleanly with the JSON loader', () => {
    const raw = readFileSync('public/tracks/anti-grav-test.json', 'utf8')
    const json = JSON.parse(raw)
    const track = buildTrackFromJson(json)
    expect(track.id).toBe('anti-grav-test')
    expect(track.props.length).toBeGreaterThanOrEqual(3)
    expect(track.checkpoints.length).toBeGreaterThan(0)
    // Spline anchors should sample into a non-empty dense polyline.
    const main = track.aiSplines.find((s) => s.id === 'main')
    expect(main?.points.length ?? 0).toBeGreaterThan(20)
    // Spline-banking authoring: the wall section uses anchorBankings ≈ π/2.
    expect(main?.antiGrav).toBe(true)
    expect(main?.anchorBankings?.some((b) => b > 1.0)).toBe(true)
    expect(main?.bankings?.length).toBe(main?.points.length)
  })
})
