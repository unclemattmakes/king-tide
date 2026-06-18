import { addComponent, hasComponent, type QueryResult, query, removeComponent } from 'bitecs'
import { destroyEntity } from '@/engine/sim/ecs/destroy'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { quatRotate } from '@/engine/sim/physics/vec'
import { BikeTag, ControlIntent, ControlIntentStore, RBHandle } from '@/game/components'
import {
  ExplosionState,
  ExplosionStateStore,
  ExplosionTag,
  MineState,
  MineStateStore,
  MineTag,
  MissileState,
  MissileStateStore,
  MissileTag,
  ShieldEffect,
  ShieldEffectStore,
  Stun,
  StunStore,
} from '@/game/components/combat'
import { createExplosion } from '@/game/entities/explosion'
import { bikeBody, forEachBikeInRange } from '@/game/systems/bike-spatial'

// --- Tunables ----------------------------------------------------------------

export const SHIELD_DURATION = 6 // seconds of bubble protection
const STUN_DURATION = 1.0 // seconds of forced-neutral input after a hit
const MINE_ARMING_DELAY = 0.6 // seconds before a fresh mine triggers on its owner
const MINE_TRIGGER_RADIUS = 2.4 // meters
const MINE_DETONATION_LIFETIME = 0.5 // seconds the despawned mine remains for visual fade
const MISSILE_SPEED = 38 // m/s
const MISSILE_TURN_RATE = 2.4 // rad/s — limits how sharply it can chase
const MISSILE_LIFETIME = 5 // seconds of flight before self-destruct
const MISSILE_HIT_RADIUS = 1.6 // meters — bike center within this radius = impact
const MISSILE_OWNER_IMMUNITY_S = 0.15 // seconds after launch the firer can't be hit by its own missile
const MISSILE_TARGET_CONE_DOT = 0.3 // dot(forward, dirToTarget) > this counts as "ahead"
const MISSILE_TARGET_MAX_RANGE = 80 // meters — beyond this, no acquisition
const MINE_DROP_OFFSET = -2.2 // meters along bike-fwd (negative = behind)
const MISSILE_LAUNCH_OFFSET = 2.4 // meters along bike-fwd at fire time
const HIT_SPIN_TORQUE = 12 // rad/s impulse around world Y at impact
const HIT_LINEAR_DAMPING = 0.55 // velocity multiplier on hit (slows the bike down)

// --- Hit reaction ------------------------------------------------------------

/**
 * Apply a "took a missile / mine" reaction to a bike. Spinouts the bike,
 * slows it, and stuns input for STUN_DURATION. If the bike has an active
 * shield, the shield is consumed and the hit is fully absorbed (returns
 * `false`).
 *
 * Returns true if the bike actually got hit (used by caller to decide
 * which explosion color to spawn).
 */
function applyHitReaction(
  sim: SimWorld,
  phys: PhysicsWorld,
  victimEid: number,
): { hit: boolean; shielded: boolean } {
  const shield = ShieldEffectStore.get(victimEid)
  if (shield && shield.remaining > 0) {
    ShieldEffectStore.set(victimEid, { remaining: 0 })
    return { hit: false, shielded: true }
  }

  {
    const rb = bikeBody(phys, victimEid)
    if (rb) {
      const v = rb.linvel()
      rb.setLinvel({ x: v.x * HIT_LINEAR_DAMPING, y: v.y, z: v.z * HIT_LINEAR_DAMPING }, true)
      const av = rb.angvel()
      // Spin around world-Y (yaw spinout). Direction randomised via the
      // sim PRNG (not Math.random) so two lockstep clients agree on which
      // way the victim spins.
      const dir = sim.rng.next() < 0.5 ? -1 : 1
      rb.setAngvel({ x: av.x, y: av.y + dir * HIT_SPIN_TORQUE, z: av.z }, true)
    }
  }

  if (!StunStore.has(victimEid)) addComponent(sim, victimEid, Stun)
  StunStore.set(victimEid, { remaining: STUN_DURATION })

  return { hit: true, shielded: false }
}

// --- Shield + stun timers ----------------------------------------------------

export function shieldTickSystem(sim: SimWorld, dt: number): void {
  const eids = query(sim, [ShieldEffect])
  for (const eid of eids) {
    const remaining = ShieldEffectStore.must(eid).remaining - dt
    if (remaining > 0) {
      ShieldEffectStore.set(eid, { remaining })
      continue
    }
    // Expired (or consumed by a hit, which sets remaining 0). Detach the
    // component + store entry instead of letting a dead timer tick forever.
    removeComponent(sim, eid, ShieldEffect)
    ShieldEffectStore.delete(eid)
  }
}

export function stunTickSystem(sim: SimWorld, dt: number): void {
  const eids = query(sim, [Stun])
  for (const eid of eids) {
    const remaining = StunStore.must(eid).remaining - dt
    if (remaining > 0) {
      StunStore.set(eid, { remaining })
      continue
    }
    removeComponent(sim, eid, Stun)
    StunStore.delete(eid)
  }
}

/**
 * Force-zero throttle / steer / brake / pitch on stunned bikes. Runs AFTER
 * applyPlayerIntent and aiControlSystem so it overrides whatever they wrote.
 * Fire/boost are left alone — the spinout is over the chassis, not the
 * weapons UI.
 */
export function stunOverrideSystem(sim: SimWorld): void {
  const eids = query(sim, [BikeTag, ControlIntent, Stun])
  for (const eid of eids) {
    const stun = StunStore.must(eid)
    if (stun.remaining <= 0) continue
    const intent = ControlIntentStore.must(eid)
    ControlIntentStore.set(eid, {
      ...intent,
      throttle: 0,
      steer: 0,
      brake: 0,
      pitch: 0,
    })
  }
}

// --- Mines -------------------------------------------------------------------

export function mineSystem(sim: SimWorld, phys: PhysicsWorld, dt: number): void {
  const mineEids = query(sim, [MineTag, MineState])
  const bikeEids = query(sim, [BikeTag, RBHandle])

  for (const mEid of mineEids) {
    const mine = MineStateStore.must(mEid)
    mine.ageSec += dt

    if (mine.detonated) {
      // After detonation the mine lingers briefly so render can fade it.
      if (mine.ageSec - mine.detonatedAt > MINE_DETONATION_LIFETIME) {
        destroyEntity(sim, mEid)
        continue
      }
      MineStateStore.set(mEid, mine)
      continue
    }

    // Proximity check. Pick the lowest-eid bike in range (not first in query
    // order) so the victim is deterministic across peers — see review §1.4.
    let victim = -1
    forEachBikeInRange(
      sim,
      phys,
      mine.position,
      MINE_TRIGGER_RADIUS,
      ({ eid: bEid }) => {
        // The dropper is immune until the mine arms.
        if (bEid === mine.ownerEid && mine.ageSec < MINE_ARMING_DELAY) return
        if (victim === -1 || bEid < victim) victim = bEid
      },
      { bikeEids },
    )

    if (victim !== -1) {
      const reaction = applyHitReaction(sim, phys, victim)
      const color = reaction.shielded ? 0x66ff99 : 0xff7733
      createExplosion(sim, mine.position, color)
      mine.detonated = true
      mine.detonatedAt = mine.ageSec
    }
    MineStateStore.set(mEid, mine)
  }
}

// --- Missiles ----------------------------------------------------------------

/**
 * Pick the nearest other bike that's roughly in front of the firer and
 * within range. Returns the eid or -1.
 *
 * Callers in tight per-frame loops (e.g. aiCombatSystem) can pass a
 * pre-fetched `bikeEids` array to avoid re-running the ECS query for
 * each AI on the same tick.
 */
export function pickMissileTarget(
  sim: SimWorld,
  phys: PhysicsWorld,
  firerEid: number,
  bikeEids?: QueryResult,
): number {
  const rb = bikeBody(phys, firerEid)
  if (!rb) return -1
  const t = rb.translation()
  const q = rb.rotation()
  const fwd = quatRotate(q, { x: 0, y: 0, z: 1 })

  let bestEid = -1
  let bestDist = MISSILE_TARGET_MAX_RANGE
  forEachBikeInRange(
    sim,
    phys,
    t,
    MISSILE_TARGET_MAX_RANGE,
    ({ eid: bEid, dx, dy, dz, dist }) => {
      if (dist < 0.001) return
      const dot = (fwd.x * dx + fwd.y * dy + fwd.z * dz) / dist
      if (dot < MISSILE_TARGET_CONE_DOT) return
      // Nearest wins; exact-distance ties broken by lowest eid so the choice
      // is independent of (peer-divergent) query order — see review §1.4.
      if (dist < bestDist || (dist === bestDist && bEid < bestEid)) {
        bestDist = dist
        bestEid = bEid
      }
    },
    { skipEid: firerEid, bikeEids },
  )
  return bestEid
}

export function missileSystem(sim: SimWorld, phys: PhysicsWorld, dt: number): void {
  const eids = query(sim, [MissileTag, MissileState])
  const bikeEids = query(sim, [BikeTag, RBHandle])

  for (const mEid of eids) {
    const m = MissileStateStore.must(mEid)
    m.ageSec += dt
    if (m.detonated || m.ageSec > MISSILE_LIFETIME) {
      // Despawn (lingering visual is via Explosion, not the missile itself).
      destroyEntity(sim, mEid)
      continue
    }

    // Drop a target that's no longer a live bike (entity despawned, or its id
    // recycled into a non-bike) so we don't home on a stale rigid-body handle.
    if (m.targetEid >= 0 && !hasComponent(sim, m.targetEid, BikeTag)) m.targetEid = -1

    // Steering toward target if one is acquired.
    if (m.targetEid >= 0) {
      const targetRb = bikeBody(phys, m.targetEid)
      if (targetRb) {
        {
          const tt = targetRb.translation()
          const toX = tt.x - m.position.x
          const toY = tt.y - m.position.y
          const toZ = tt.z - m.position.z
          const distToTarget = Math.hypot(toX, toY, toZ)
          if (distToTarget > 0.001) {
            const desiredX = (toX / distToTarget) * MISSILE_SPEED
            const desiredY = (toY / distToTarget) * MISSILE_SPEED
            const desiredZ = (toZ / distToTarget) * MISSILE_SPEED
            // Slew velocity toward desired by at most MISSILE_TURN_RATE * dt
            // worth of angular change. Easier: lerp velocity vector and
            // re-normalize to MISSILE_SPEED.
            const k = Math.min(MISSILE_TURN_RATE * dt, 1)
            let vx = m.velocity.x + (desiredX - m.velocity.x) * k
            let vy = m.velocity.y + (desiredY - m.velocity.y) * k
            let vz = m.velocity.z + (desiredZ - m.velocity.z) * k
            const speed = Math.hypot(vx, vy, vz)
            if (speed > 0.001) {
              vx = (vx / speed) * MISSILE_SPEED
              vy = (vy / speed) * MISSILE_SPEED
              vz = (vz / speed) * MISSILE_SPEED
            }
            m.velocity.x = vx
            m.velocity.y = vy
            m.velocity.z = vz
          }
        }
      }
    }

    // Integrate position.
    m.position.x += m.velocity.x * dt
    m.position.y += m.velocity.y * dt
    m.position.z += m.velocity.z * dt

    // Hit detection — lowest-eid bike (but the owner) within hit radius, so
    // the victim is deterministic across peers when two overlap (review §1.4).
    let hitEid = -1
    forEachBikeInRange(
      sim,
      phys,
      m.position,
      MISSILE_HIT_RADIUS,
      ({ eid: bEid }) => {
        if (bEid === m.ownerEid && m.ageSec < MISSILE_OWNER_IMMUNITY_S) return
        if (hitEid === -1 || bEid < hitEid) hitEid = bEid
      },
      { bikeEids },
    )

    if (hitEid >= 0) {
      const reaction = applyHitReaction(sim, phys, hitEid)
      const color = reaction.shielded ? 0x66ff99 : 0xff5577
      createExplosion(sim, m.position, color)
      m.detonated = true
    }

    MissileStateStore.set(mEid, m)
  }
}

// --- Explosions tick ---------------------------------------------------------

export function explosionTickSystem(sim: SimWorld, dt: number): void {
  const eids = query(sim, [ExplosionTag, ExplosionState])
  for (const eid of eids) {
    const e = ExplosionStateStore.must(eid)
    e.ageSec += dt
    if (e.ageSec >= e.lifetime) {
      destroyEntity(sim, eid)
      continue
    }
    ExplosionStateStore.set(eid, e)
  }
}

// --- Drop helpers (called by pickup-use) -------------------------------------

export function getMineDropPosition(
  phys: PhysicsWorld,
  ownerEid: number,
): {
  x: number
  y: number
  z: number
} | null {
  const rb = bikeBody(phys, ownerEid)
  if (!rb) return null
  const t = rb.translation()
  const q = rb.rotation()
  const fwd = quatRotate(q, { x: 0, y: 0, z: 1 })
  return {
    x: t.x + fwd.x * MINE_DROP_OFFSET,
    y: t.y - 0.4, // settle the disc just below ride height
    z: t.z + fwd.z * MINE_DROP_OFFSET,
  }
}

export function getMissileLaunchTransform(
  phys: PhysicsWorld,
  ownerEid: number,
): {
  position: { x: number; y: number; z: number }
  velocity: { x: number; y: number; z: number }
} | null {
  const rb = bikeBody(phys, ownerEid)
  if (!rb) return null
  const t = rb.translation()
  const q = rb.rotation()
  const fwd = quatRotate(q, { x: 0, y: 0, z: 1 })
  // Launch horizontally — keep y zero so missiles don't dive into the water
  // when the bike is pitched.
  const fx = fwd.x
  const fz = fwd.z
  const flen = Math.hypot(fx, fz) || 1
  const hx = fx / flen
  const hz = fz / flen
  return {
    position: {
      x: t.x + hx * MISSILE_LAUNCH_OFFSET,
      y: t.y + 0.2,
      z: t.z + hz * MISSILE_LAUNCH_OFFSET,
    },
    velocity: { x: hx * MISSILE_SPEED, y: 0, z: hz * MISSILE_SPEED },
  }
}
