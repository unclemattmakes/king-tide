import { describe, expect, it } from 'vitest'
import type { Vec3 } from '@/engine/sim/physics/vec'
import { initialOob } from '@/game/components/out-of-bounds'
import { DEFAULT_CORRIDOR_HALF_WIDTH_M, MIN_CORRIDOR_HALF_WIDTH_M } from '@/game/systems/oob-tuning'
import { corridorHalfWidth, distToLine3D, resolveOob, stepOob } from '@/game/systems/out-of-bounds'

/** A straight racing line along +X at y=0, z=0, from x=0..100. */
function line(): Vec3[] {
  const pts: Vec3[] = []
  for (let x = 0; x <= 100; x += 5) pts.push({ x, y: 0, z: 0 })
  return pts
}

describe('corridorHalfWidth', () => {
  it('is the median buoy distance to the racing line', () => {
    const buoys: Vec3[] = [
      { x: 20, y: 0, z: 40 },
      { x: 40, y: 0, z: -40 },
      { x: 60, y: 0, z: 40 },
    ]
    expect(corridorHalfWidth(buoys, line())).toBeCloseTo(40, 5)
  })

  it('falls back to the default when a track ships no buoys', () => {
    expect(corridorHalfWidth([], line())).toBe(DEFAULT_CORRIDOR_HALF_WIDTH_M)
  })

  it('is floored so a tight buoy cluster cannot make the leash punishing', () => {
    const buoys: Vec3[] = [
      { x: 10, y: 0, z: 2 },
      { x: 20, y: 0, z: 3 },
    ]
    expect(corridorHalfWidth(buoys, line())).toBe(MIN_CORRIDOR_HALF_WIDTH_M)
  })
})

describe('distToLine3D', () => {
  it('is ~0 on the line', () => {
    expect(distToLine3D(line(), 50, 0, 0)).toBeCloseTo(0, 5)
  })

  it('measures 3D distance — a vertical joyride trips the leash', () => {
    expect(distToLine3D(line(), 50, 200, 0)).toBeCloseTo(200, 5)
  })
})

const leash = { soft: 60, hard: 100 }

describe('stepOob state machine', () => {
  it('in → warn past the soft wall, forfeiting race credit', () => {
    const oob = initialOob()
    const racer = { forfeited: false }
    stepOob(oob, 70, 1 / 60, 5, leash, racer)
    expect(oob.phase).toBe('warn')
    expect(racer.forfeited).toBe(true)
    expect(oob.graceRemaining).toBeCloseTo(5, 5)
  })

  it('warn → in on re-entry, but the forfeit sticks', () => {
    const oob = initialOob()
    const racer = { forfeited: false }
    stepOob(oob, 70, 1 / 60, 5, leash, racer)
    stepOob(oob, 50, 1 / 60, 5, leash, racer) // 50 < soft*0.92 (55.2)
    expect(oob.phase).toBe('in')
    expect(racer.forfeited).toBe(true)
  })

  it('warn → brace when the grace timer expires while still out', () => {
    const oob = initialOob()
    const racer = { forfeited: false }
    stepOob(oob, 70, 0.1, 0.3, leash, racer) // enter warn, grace 0.3
    stepOob(oob, 70, 0.1, 0.3, leash, racer) // 0.2
    stepOob(oob, 70, 0.1, 0.3, leash, racer) // 0.1
    stepOob(oob, 70, 0.1, 0.3, leash, racer) // 0.0 → brace
    expect(oob.phase).toBe('brace')
  })

  it('in → brace immediately past the hard wall', () => {
    const oob = initialOob()
    const racer = { forfeited: false }
    stepOob(oob, 120, 1 / 60, 5, leash, racer)
    expect(oob.phase).toBe('brace')
    expect(racer.forfeited).toBe(true)
  })

  it('brace → hit when not recovering', () => {
    const oob = initialOob()
    oob.phase = 'brace'
    oob.braceRemaining = 0.05
    oob.distance = 90
    const racer = { forfeited: true }
    stepOob(oob, 90, 0.1, 5, leash, racer)
    expect(oob.phase).toBe('lethal')
    expect(oob.lethalKind).toBe('hit')
    expect(oob.lethalTriggeredThisTick).toBe(true)
  })

  it('brace → nearmiss when recovering hard toward the line', () => {
    const oob = initialOob()
    oob.phase = 'brace'
    oob.braceRemaining = 0.05
    oob.inwardSpeed = 20
    oob.distance = 50 // already inside the soft wall
    const racer = { forfeited: true }
    stepOob(oob, 50, 0.1, 5, leash, racer)
    expect(oob.phase).toBe('lethal')
    expect(oob.lethalKind).toBe('nearmiss')
  })

  it('holds in lethal until resolveOob', () => {
    const oob = initialOob()
    oob.phase = 'lethal'
    oob.lethalKind = 'hit'
    const racer = { forfeited: true }
    stepOob(oob, 10, 1 / 60, 5, leash, racer)
    expect(oob.phase).toBe('lethal')
    resolveOob(oob)
    expect(oob.phase).toBe('in')
    expect(oob.lethalKind).toBeNull()
  })
})
