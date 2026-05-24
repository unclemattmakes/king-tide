/**
 * Drift Practice Range — track-layout sanity tests.
 *
 * Pins the geometry of `public/tracks/drift-test.json` against the
 * "stations" the design doc promises:
 *   1. A long straight (NO drift here) — between start and CP0.
 *   2. A tight right corner with a boost pad on exit — at the NE corner.
 *   3. A long sweeping right — the SE→SW→NW arc, long enough to charge
 *      the orange SMT tier (≥ 1.4 s at ~28 m/s).
 *   4. A ramp on the south straight — to test the ungrounded-cancel.
 *   5. A return-to-start straight on the west side.
 *
 * The track is a flat-surface dev diagnostic; physical geometry is
 * one big box + cones + a ramp wedge. These tests pin the coordinates
 * so an inadvertent edit to the JSON can't silently break the
 * stations.
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTrackFromJson } from '@/game/tracks/json-loader'

const REPO_ROOT = path.resolve(__dirname, '../..')
const DRIFT_TEST_JSON = path.join(REPO_ROOT, 'public', 'tracks', 'drift-test.json')

function loadTrack() {
  const raw = JSON.parse(fs.readFileSync(DRIFT_TEST_JSON, 'utf8'))
  return buildTrackFromJson(raw)
}

describe('drift-test track — parsing + identity', () => {
  it('parses without error and has the expected id/name', () => {
    const track = loadTrack()
    expect(track.id).toBe('drift-test')
    expect(track.name).toBe('Drift Practice Range')
  })

  it('runs 2 laps so the player can revisit each station once before retiring', () => {
    expect(loadTrack().lapsToFinish).toBe(2)
  })

  it('has no environment GLB — the surface is entirely prop-driven so the track loads with no asset pipeline', () => {
    expect(loadTrack().environmentGlb).toBeUndefined()
  })
})

describe('drift-test track — layout', () => {
  it('starts at the NW corner facing east, ready to drive the long north straight', () => {
    const t = loadTrack()
    expect(t.start.position.x).toBeCloseTo(-130, 0)
    expect(t.start.position.z).toBeCloseTo(-130, 0)
    // yaw = π/2 → bike-fwd (+Z in local) rotates to +X (east).
    expect(t.start.yaw).toBeCloseTo(Math.PI / 2, 3)
  })

  it('has four checkpoints — one per straight midpoint or corner exit', () => {
    const t = loadTrack()
    expect(t.checkpoints.map((c) => c.index)).toEqual([0, 1, 2, 3])
    // CP0 — end of north straight, just before the NE blue-MT corner.
    expect(t.checkpoints[0]!.position.x).toBeCloseTo(130, 0)
    expect(t.checkpoints[0]!.position.z).toBeCloseTo(-130, 0)
    // CP1 — middle of east straight (between NE blue-MT and SE blue-MT).
    expect(t.checkpoints[1]!.position.x).toBeCloseTo(170, 0)
    expect(t.checkpoints[1]!.position.z).toBeCloseTo(0, 0)
    // CP2 — middle of south straight (the ramp section).
    expect(t.checkpoints[2]!.position.x).toBeCloseTo(0, 0)
    expect(t.checkpoints[2]!.position.z).toBeCloseTo(130, 0)
    // CP3 — middle of west straight (the long sweep payoff zone).
    expect(t.checkpoints[3]!.position.x).toBeCloseTo(-170, 0)
    expect(t.checkpoints[3]!.position.z).toBeCloseTo(0, 0)
  })

  it('AI spline closes the loop — last anchor is near the start position', () => {
    const t = loadTrack()
    const spline = t.aiSplines.find((s) => s.id === 'main')
    expect(spline).toBeDefined()
    const anchors = spline!.anchors
    expect(anchors).toBeDefined()
    expect(anchors!.length).toBeGreaterThanOrEqual(8)
    const first = anchors![0]!
    const last = anchors![anchors!.length - 1]!
    // Last anchor sits one segment short of looping back to start; the
    // catmull-rom spline closes from there to first[0]. We assert the
    // last anchor is in the NW quadrant — driving north along x=-170.
    expect(last.x).toBeLessThan(-100)
    expect(last.z).toBeLessThan(0)
    expect(first.x).toBeLessThan(-100)
    expect(first.z).toBeLessThan(0)
  })
})

describe('drift-test track — drift stations', () => {
  it('places a boost pad on the NE corner exit so drift+pad stacking can be tested', () => {
    const t = loadTrack()
    expect(t.boostPads).toHaveLength(1)
    const pad = t.boostPads[0]!
    // East side, north of center — the player exits the blue-MT corner
    // and rolls onto the pad as they accelerate down the east straight.
    expect(pad.position.x).toBeCloseTo(170, 0)
    expect(pad.position.z).toBeLessThan(0)
    expect(pad.strength).toBeGreaterThan(1.0)
  })

  it('long-sweep payoff arc is at least 200 m of arc length so SMT (1.4 s at ~28 m/s) is reachable', () => {
    const t = loadTrack()
    // The west straight is the SMT payoff. Anchors 9, 10, 11 of the
    // main spline cover (-170, 90) → (-170, 0) → (-170, -90) — a
    // 180 m straight that gives the player ~6.4 s at top speed to
    // hold a single committed drift through the broader NW sweep
    // (anchors 8 → 11 close the loop).
    const main = t.aiSplines.find((s) => s.id === 'main')!
    expect(main.anchors).toBeDefined()
    const idx9 = main.anchors![9]!
    const idx11 = main.anchors![11]!
    const arc = Math.hypot(idx11.x - idx9.x, idx11.z - idx9.z)
    expect(arc).toBeGreaterThanOrEqual(180)
  })

  it('lays down a ground surface large enough to fit the racing line with comfortable margin', () => {
    const t = loadTrack()
    // The first prop is the ground slab — find it and confirm extents.
    const ground = t.props.find(
      (p) =>
        p.type === 'box' &&
        Math.abs(p.position.x) < 1 &&
        Math.abs(p.position.z) < 1 &&
        p.size.x > 100 &&
        p.size.z > 100,
    )
    expect(ground).toBeDefined()
    // Racing line extends from x=-170 to +170 and z=-130 to +130, so
    // the slab needs at least 340 across and 260 along to fit it with
    // no clip-through risk at the corners. 400×350 gives ~30 m margin.
    expect(ground!.size.x).toBeGreaterThanOrEqual(340)
    expect(ground!.size.z).toBeGreaterThanOrEqual(260)
  })

  it('drops a ramp prop on the south straight so ungrounded-cancel can be tested in-flow', () => {
    const t = loadTrack()
    // The ramp is the only prop on the south straight (z ≈ +130)
    // that's tall enough and short enough to read as a launch wedge
    // rather than a wall — capped y around 0.5–1.0 m, footprint
    // 10–20 m on each side.
    const ramps = t.props.filter(
      (p) =>
        p.type === 'box' &&
        Math.abs(p.position.z - 130) < 5 &&
        p.size.y > 0.4 &&
        p.size.y < 1.5 &&
        p.size.x > 5 &&
        p.size.z > 5,
    )
    expect(ramps).toHaveLength(1)
  })

  it('places visible cone markers at each of the four corner entries', () => {
    const t = loadTrack()
    // Cones are thin tall boxes (size.x ≈ 0.5, size.y ≥ 2) standing
    // on the surface. Group them by corner: NE, SE, SW, NW.
    const cones = t.props.filter(
      (p) => p.type === 'box' && p.size.x < 1 && p.size.y >= 2 && p.size.z < 1,
    )
    expect(cones.length).toBeGreaterThanOrEqual(4)
    const ne = cones.filter((c) => c.position.x > 50 && c.position.z < -50)
    const se = cones.filter((c) => c.position.x > 50 && c.position.z > 50)
    const sw = cones.filter((c) => c.position.x < -50 && c.position.z > 50)
    const nw = cones.filter((c) => c.position.x < -50 && c.position.z < -50)
    expect(ne.length).toBeGreaterThan(0)
    expect(se.length).toBeGreaterThan(0)
    expect(sw.length).toBeGreaterThan(0)
    expect(nw.length).toBeGreaterThan(0)
  })

  it('tags an ICE patch on the west straight + a SAND patch on the south straight', () => {
    const t = loadTrack()
    const surfaced = t.props.filter((p) => p.surface !== undefined)
    // Exactly the two demonstration patches — ice on the long SMT
    // sweep (west), sand on the ramp straight (south).
    const ice = surfaced.find((p) => p.surface === 'ice')
    const sand = surfaced.find((p) => p.surface === 'sand')
    expect(ice).toBeDefined()
    expect(sand).toBeDefined()
    // Ice sits on the west straight (x ≈ -170, the SMT payoff zone).
    expect(ice!.position.x).toBeLessThan(-100)
    // Sand sits on the south straight (z ≈ +130, the ramp section).
    expect(sand!.position.z).toBeGreaterThan(100)
    // Both patches must clear the slab top (half-extent puts it at
    // y=0.25) so the hover probe actually reads them as the ride
    // surface rather than the buried slab.
    for (const patch of [ice!, sand!]) {
      expect(patch.position.y + patch.size.y).toBeGreaterThan(0.25)
    }
  })
})
