/**
 * Practice Lagoon — track-layout sanity tests.
 *
 * Pins the geometry of `public/tracks/practice-lagoon.json` against
 * the stations the Practice mode script coaches, in ride order
 * (script-catalog PRACTICE_LAGOON_SCRIPT / evaluation summary #1):
 *   1. Throttle/cruise straight — south side, start line to the SE corner.
 *   2. LAUNCH — the east-straight swell lane (a heavy wave zone).
 *   3. TRICK — the jump table on the north straight (orange pylons).
 *   4. TUCK — the long-swell rollers zone west of the table.
 *   5. DRIFT — the long west sweep, long enough for an SMT hold.
 *
 * Everything is water + primitive props — the asset-light dev-test
 * venue CLAUDE.md hard rule 2 asks for. Props are matched by shape
 * signature (pylon = thin tall box), never by array index, so JSON
 * reordering can't break the pins (drift-test-track.test.ts pattern).
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MIN_HEIGHT_MULT } from '@/game/ai/pump-hints'
import { TIER_2_THRESHOLD_S } from '@/game/systems/drift-tiers'
import { buildTrackFromJson } from '@/game/tracks/json-loader'

const REPO_ROOT = path.resolve(__dirname, '../..')
const PRACTICE_JSON = path.join(REPO_ROOT, 'public', 'tracks', 'practice-lagoon.json')

function loadTrack() {
  const raw = JSON.parse(fs.readFileSync(PRACTICE_JSON, 'utf8'))
  return buildTrackFromJson(raw)
}

/** Pylon signature: thin, tall marker boxes. */
function pylons(track: ReturnType<typeof loadTrack>) {
  return track.props.filter((p) => p.size.x < 1 && p.size.y >= 2 && p.size.z < 1)
}

describe('practice-lagoon — parsing + identity', () => {
  it('parses without error and has the expected id/name', () => {
    const track = loadTrack()
    expect(track.id).toBe('practice-lagoon')
    expect(track.name).toBe('Practice Lagoon')
  })

  it('runs 2 laps — a coached lap plus a consolidation lap', () => {
    expect(loadTrack().lapsToFinish).toBe(2)
  })

  it('is fully asset-light: no environment GLB, props are primitives only', () => {
    const t = loadTrack()
    expect(t.environmentGlb).toBeUndefined()
    for (const p of t.props) expect(p.type).toBe('box')
  })

  it('ships no pickups — a coached run hands out no ordnance', () => {
    expect(loadTrack().pickupSpawns).toEqual([])
  })

  it('carries a sky block so the lagoon never renders the DEFAULT_SKY black dome', () => {
    const raw = JSON.parse(fs.readFileSync(PRACTICE_JSON, 'utf8'))
    expect(raw.sky).toBeDefined()
    expect(raw.sky.seaStateBeaufort).toBeLessThanOrEqual(2)
  })
})

describe('practice-lagoon — stations in ride order', () => {
  it('starts on the south straight facing east (throttle/cruise station)', () => {
    const t = loadTrack()
    expect(t.start.position.z).toBeLessThan(-90) // south side
    expect(t.start.yaw).toBeCloseTo(Math.PI / 2, 3) // facing +X
  })

  it('LAUNCH: a heavy swell zone sits on the east straight, past the pump-hint threshold', () => {
    const t = loadTrack()
    const launchZones = t.waveZones.filter(
      (z) => z.position.x > 100 && z.heightMult > DEFAULT_MIN_HEIGHT_MULT,
    )
    expect(launchZones.length).toBe(1)
    const zone = launchZones[0]!
    // Long rolling swells (freqMult < 1), not chop — a clean, repeatable
    // launch ramp.
    expect(zone.freqMult).toBeLessThan(1)
    // Blue entry/exit pylons frame the lane on the east straight.
    const blue = pylons(t).filter((p) => p.position.x > 100)
    expect(blue.length).toBeGreaterThanOrEqual(4)
  })

  it('TRICK: exactly one jump table on the north straight, pylon-marked', () => {
    const t = loadTrack()
    const tables = t.props.filter(
      (p) => p.position.z > 90 && p.size.y > 0.4 && p.size.y < 1.5 && p.size.x > 5 && p.size.z > 5,
    )
    expect(tables.length).toBe(1)
    expect(tables[0]!.position.x).toBeGreaterThan(0) // east half — before the tuck rollers
  })

  it('TUCK: a long-wavelength roller zone covers the west half of the north straight', () => {
    const t = loadTrack()
    const rollers = t.waveZones.filter(
      (z) => z.position.z > 90 && z.heightMult > 1 && z.freqMult < 0.6,
    )
    expect(rollers.length).toBe(1)
  })

  it('DRIFT: the west sweep is long enough to hold an SMT charge at speed', () => {
    const t = loadTrack()
    const spline = t.aiSplines.find((s) => s.id === 'main')
    expect(spline).toBeDefined()
    // Arc length over the western half of the loop (x < -45): must
    // exceed the SMT charge budget at full tilt (~28 m/s).
    const pts = spline!.points.filter((p) => p.x < -45)
    let arc = 0
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1]!
      const b = pts[i]!
      arc += Math.hypot(b.x - a.x, b.z - a.z)
    }
    expect(arc).toBeGreaterThan(TIER_2_THRESHOLD_S * 28)
    // Red apex pylons mark the outside of the sweep.
    const red = pylons(t).filter((p) => p.position.x < -140)
    expect(red.length).toBeGreaterThanOrEqual(3)
  })

  it('rewards the sweep exit with one boost pad aimed down the start straight', () => {
    const t = loadTrack()
    expect(t.boostPads.length).toBe(1)
    const pad = t.boostPads[0]!
    expect(pad.strength).toBeGreaterThan(1)
    expect(pad.position.z).toBeLessThan(-90) // south straight
    expect(pad.position.x).toBeLessThan(t.start.position.x) // before the start line
  })

  it('keeps a calming base zone so only the stations carry big water', () => {
    const t = loadTrack()
    const calming = t.waveZones.filter((z) => z.heightMult < 1)
    expect(calming.length).toBe(1)
    // The calming zone must blanket the whole course (all spline points
    // inside its footprint).
    const zone = calming[0]!
    const spline = t.aiSplines.find((s) => s.id === 'main')!
    for (const p of spline.points) {
      expect(Math.abs(p.x - zone.position.x)).toBeLessThanOrEqual(zone.halfWidth)
      expect(Math.abs(p.z - zone.position.z)).toBeLessThanOrEqual(zone.halfDepth)
    }
  })

  it('closes the loop — last spline point returns near the first', () => {
    const t = loadTrack()
    const spline = t.aiSplines.find((s) => s.id === 'main')!
    const first = spline.points[0]!
    const last = spline.points[spline.points.length - 1]!
    expect(Math.hypot(last.x - first.x, last.z - first.z)).toBeLessThan(90)
  })
})
