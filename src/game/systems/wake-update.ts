import { query } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { sampleHeight, type WaveFieldState } from '@/engine/sim/water/wave-field'
import { BikeTag, RBHandle, RBHandleStore } from '@/game/components'

/**
 * Populate `field.wakes` from the live bike rigid bodies. Run once per fixed
 * step BEFORE `hoverSystem` so the buoyancy probe reads each bike's surface
 * height with all wakes already deposited — that's what lets a trailing
 * rider feel (and "jump") the player's wake, not just see it.
 *
 * Weight fades the wake as the bike lifts off the surface (mirrors the
 * existing `gatherBikeImpacts` formula in `main.ts`, which the render side
 * also uses). The ambient height read here intentionally excludes wakes
 * (we just cleared them), so weight is driven by wave altitude only — no
 * feedback loop.
 */
export function wakeUpdateSystem(sim: SimWorld, phys: PhysicsWorld, field: WaveFieldState): void {
  field.wakes.length = 0
  const eids = query(sim, [BikeTag, RBHandle])
  for (const eid of eids) {
    const rbh = RBHandleStore.get(eid)
    if (!rbh) continue
    const rb = phys.world.getRigidBody(rbh.handle)
    if (!rb) continue
    const t = rb.translation()
    const v = rb.linvel()
    const surfaceY = sampleHeight(field, t.x, t.z)
    const altitude = t.y - surfaceY
    let weight = 1
    if (altitude > 0.5) {
      weight = Math.max(0, 1 - (altitude - 0.5) / 1.5)
    }
    if (weight <= 0.05) continue
    field.wakes.push({ x: t.x, z: t.z, vx: v.x, vz: v.z, weight })
  }
}
