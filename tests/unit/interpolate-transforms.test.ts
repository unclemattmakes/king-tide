import { describe, expect, it } from 'vitest'
import { PrevTickTransformStore, TickTransformStore, TransformStore } from '@/game/components'
import {
  interpolateRenderTransforms,
  TELEPORT_SNAP_DIST,
} from '@/game/systems/interpolate-transforms'

const IDENT = { qx: 0, qy: 0, qz: 0, qw: 1 }

type Pose = { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }

function seed(eid: number, prev: Pose, cur: Pose): void {
  PrevTickTransformStore.set(eid, { ...prev })
  TickTransformStore.set(eid, { ...cur })
  TransformStore.set(eid, { ...cur })
}
function clear(eid: number): void {
  PrevTickTransformStore.delete(eid)
  TickTransformStore.delete(eid)
  TransformStore.delete(eid)
}

describe('interpolateRenderTransforms', () => {
  it('lerps position between the previous and latest committed tick by alpha', () => {
    const eid = 990001
    // Gap well under TELEPORT_SNAP_DIST so it interpolates rather than snaps.
    seed(eid, { x: 0, y: 0, z: 0, ...IDENT }, { x: 4, y: 2, z: -1, ...IDENT })
    interpolateRenderTransforms(0.5)
    const t = TransformStore.must(eid)
    expect(t.x).toBeCloseTo(2)
    expect(t.y).toBeCloseTo(1)
    expect(t.z).toBeCloseTo(-0.5)
    clear(eid)
  })

  it('clamps alpha to [0,1] — endpoints land exactly on prev and cur', () => {
    const eid = 990002
    const prev = { x: 1, y: 0, z: 0, ...IDENT }
    const cur = { x: 3, y: 0, z: 0, ...IDENT }
    seed(eid, prev, cur)
    interpolateRenderTransforms(-0.5)
    expect(TransformStore.must(eid).x).toBeCloseTo(1) // clamped to prev
    interpolateRenderTransforms(1.5)
    expect(TransformStore.must(eid).x).toBeCloseTo(3) // clamped to cur
    clear(eid)
  })

  it('slerps rotation — halfway between identity and a 90° yaw is a 45° yaw', () => {
    const eid = 990003
    const c = Math.cos(Math.PI / 4)
    const s = Math.sin(Math.PI / 4)
    seed(eid, { x: 0, y: 0, z: 0, ...IDENT }, { x: 0, y: 0, z: 0, qx: 0, qy: s, qz: 0, qw: c })
    interpolateRenderTransforms(0.5)
    const t = TransformStore.must(eid)
    expect(t.qy).toBeCloseTo(Math.sin(Math.PI / 8), 4)
    expect(t.qw).toBeCloseTo(Math.cos(Math.PI / 8), 4)
    expect(t.qx).toBeCloseTo(0, 6)
    expect(t.qz).toBeCloseTo(0, 6)
    clear(eid)
  })

  it('snaps (does not smear) when the prev→cur gap exceeds the teleport distance', () => {
    const eid = 990004
    seed(eid, { x: 0, y: 0, z: 0, ...IDENT }, { x: TELEPORT_SNAP_DIST + 10, y: 0, z: 0, ...IDENT })
    interpolateRenderTransforms(0.5)
    // Halfway would be ~7.5; a teleport snaps to the destination instead.
    expect(TransformStore.must(eid).x).toBeCloseTo(TELEPORT_SNAP_DIST + 10)
    clear(eid)
  })

  it('leaves entities with no tick history untouched (ghosts / replay bikes)', () => {
    const eid = 990005
    // Render-only entity: a TransformStore entry written directly each frame,
    // but no tick history. The pass must not overwrite it.
    TransformStore.set(eid, { x: 42, y: 7, z: 9, ...IDENT })
    interpolateRenderTransforms(0.5)
    expect(TransformStore.must(eid).x).toBe(42)
    expect(TransformStore.must(eid).y).toBe(7)
    TransformStore.delete(eid)
  })

  it('skips a body that has a prev tick but no latest tick yet', () => {
    const eid = 990006
    PrevTickTransformStore.set(eid, { x: 0, y: 0, z: 0, ...IDENT })
    TransformStore.set(eid, { x: 99, y: 0, z: 0, ...IDENT })
    // no TickTransformStore entry
    interpolateRenderTransforms(0.5)
    expect(TransformStore.must(eid).x).toBe(99) // unchanged
    clear(eid)
  })

  it('does not mutate the tick-history entries (only TransformStore)', () => {
    const eid = 990007
    seed(eid, { x: 0, y: 0, z: 0, ...IDENT }, { x: 4, y: 0, z: 0, ...IDENT })
    interpolateRenderTransforms(0.25)
    expect(PrevTickTransformStore.must(eid).x).toBe(0)
    expect(TickTransformStore.must(eid).x).toBe(4)
    expect(TransformStore.must(eid).x).toBeCloseTo(1)
    clear(eid)
  })
})
