/**
 * Canonical, stable string representation of sim state. Two sims that have
 * advanced from the same seed + same inputs MUST produce the same snapshot
 * string — any divergence (Rapier float drift, missed RNG seed, off-by-one
 * tick) shows up as a mismatch.
 *
 * Used by the M10.2 determinism harness (?determinism=1) and the
 * cross-load Playwright probe in tests/e2e/m10-determinism.spec.ts.
 *
 * Sort key: entity id. Sorted output means peer ordering can never sneak
 * into the hash.
 */
import { query } from 'bitecs'
import { RBHandle, RBHandleStore } from '@/game/components'
import type { SimWorld } from './ecs/world'
import type { PhysicsWorld } from './physics/rapier'
import type { WaveFieldState } from './water/wave-field'

export type SimSnapshot = {
  rng: number
  waveTime: number
  bodies: BodySnapshot[]
}

type BodySnapshot = {
  eid: number
  px: number
  py: number
  pz: number
  qx: number
  qy: number
  qz: number
  qw: number
  vx: number
  vy: number
  vz: number
  ax: number
  ay: number
  az: number
}

export function captureSnapshot(
  sim: SimWorld,
  phys: PhysicsWorld,
  waveField: WaveFieldState,
): SimSnapshot {
  const bodies: BodySnapshot[] = []
  // RBHandle covers every entity with a Rapier rigid body — bikes, mines,
  // missiles. Anything in the sim that affects future ticks lives behind
  // one of these handles.
  const eids = [...query(sim, [RBHandle])]
  eids.sort((a, b) => a - b)
  for (const eid of eids) {
    const handle = RBHandleStore.get(eid)
    if (!handle) continue
    const rb = phys.world.getRigidBody(handle.handle)
    if (!rb) continue
    const p = rb.translation()
    const q = rb.rotation()
    const v = rb.linvel()
    const a = rb.angvel()
    bodies.push({
      eid,
      px: p.x,
      py: p.y,
      pz: p.z,
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
      vx: v.x,
      vy: v.y,
      vz: v.z,
      ax: a.x,
      ay: a.y,
      az: a.z,
    })
  }
  return {
    rng: sim.rng.state(),
    waveTime: waveField.time,
    bodies,
  }
}

/** Serialize a snapshot to a stable string. JSON.stringify with a fixed
 *  key ordering is enough — number formatting is deterministic in V8. */
export function snapshotToString(snap: SimSnapshot): string {
  return JSON.stringify(snap)
}
