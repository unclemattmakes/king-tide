import { addComponent, query, type QueryResult, removeEntity } from 'bitecs'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { distanceSquared, quatRotate } from '@/engine/sim/physics/vec'
import {
  BikeTag,
  ControlIntent,
  ControlIntentStore,
  RBHandle,
  RBHandleStore,
} from '@/game/components'
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

// --- Tunables ----------------------------------------------------------------

export const SHIELD_DURATION = 6 // seconds of bubble protection
const STUN_DURATION = 1.0 // seconds of forced-neutral input after a hit
const MINE_ARMING_DELAY = 0.6 // seconds before a fresh mine triggers on its owner
const MINE_TRIGGER_RADIUS = 2.4 // meters
const MINE_TRIGGER_RADIUS_SQ = MINE_TRIGGER_RADIUS * MINE_TRIGGER_RADIUS
const MINE_DETONATION_LIFETIME = 0.5 // seconds the despawned mine remains for visual fade
const MISSILE_SPEED = 38 // m/s
const MISSILE_TURN_RATE = 2.4 // rad/s — limits how sharply it can chase
const MISSILE_LIFETIME = 5 // seconds of flight before self-destruct
const MISSILE_HIT_RADIUS = 1.6 // meters — bike center within this radius = impact
const MISSILE_HIT_RADIUS_SQ = MISSILE_HIT_RADIUS * MISSILE_HIT_RADIUS
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

  const handle = RBHandleStore.get(victimEid)
  if (handle) {
    const rb = phys.world.getRigidBody(handle.handle)
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
    const s = ShieldEffectStore.must(eid)
    if (s.remaining > 0) ShieldEffectStore.set(eid, { remaining: s.remaining - dt })
  }
}

export function stunTickSystem(sim: SimWorld, dt: number): void {
  const eids = query(sim, [Stun])
  for (const eid of eids) {
    const s = StunStore.must(eid)
    if (s.remaining > 0) StunStore.set(eid, { remaining: s.remaining - dt })
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
        removeEntity(sim, mEid)
        continue
      }
      MineStateStore.set(mEid, mine)
      continue
    }

    // Proximity check.
    let triggered = false
    for (const bEid of bikeEids) {
      if (bEid === mine.ownerEid && mine.ageSec < MINE_ARMING_DELAY) continue
      const handle = RBHandleStore.must(bEid)
      const rb = phys.world.getRigidBody(handle.handle)
      if (!rb) continue
      const t = rb.translation()
      if (distanceSquared(t, mine.position) > MINE_TRIGGER_RADIUS_SQ) continue

      const reaction = applyHitReaction(sim, phys, bEid)
      const color = reaction.shielded ? 0x66ff99 : 0xff7733
      createExplosion(sim, mine.position, color)
      triggered = true
      break
    }

    if (triggered) {
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
  const handle = RBHandleStore.get(firerEid)
  if (!handle) return -1
  const rb = phys.world.getRigidBody(handle.handle)
  if (!rb) return -1
  const t = rb.translation()
  const q = rb.rotation()
  const fwd = quatRotate(q, { x: 0, y: 0, z: 1 })

  let bestEid = -1
  let bestDist = MISSILE_TARGET_MAX_RANGE
  const bikes = bikeEids ?? query(sim, [BikeTag, RBHandle])
  for (const bEid of bikes) {
    if (bEid === firerEid) continue
    const otherHandle = RBHandleStore.must(bEid)
    const otherRb = phys.world.getRigidBody(otherHandle.handle)
    if (!otherRb) continue
    const ot = otherRb.translation()
    const dx = ot.x - t.x
    const dy = ot.y - t.y
    const dz = ot.z - t.z
    const dist = Math.hypot(dx, dy, dz)
    if (dist > MISSILE_TARGET_MAX_RANGE) continue
    if (dist < 0.001) continue
    const dot = (fwd.x * dx + fwd.y * dy + fwd.z * dz) / dist
    if (dot < MISSILE_TARGET_CONE_DOT) continue
    if (dist < bestDist) {
      bestDist = dist
      bestEid = bEid
    }
  }
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
      removeEntity(sim, mEid)
      continue
    }

    // Steering toward target if one is acquired.
    if (m.targetEid >= 0) {
      const handle = RBHandleStore.get(m.targetEid)
      if (handle) {
        const targetRb = phys.world.getRigidBody(handle.handle)
        if (targetRb) {
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

    // Hit detection — any bike but the owner within hit radius.
    let hitEid = -1
    for (const bEid of bikeEids) {
      if (bEid === m.ownerEid && m.ageSec < 0.15) continue
      const handle = RBHandleStore.must(bEid)
      const rb = phys.world.getRigidBody(handle.handle)
      if (!rb) continue
      const bt = rb.translation()
      if (distanceSquared(bt, m.position) <= MISSILE_HIT_RADIUS_SQ) {
        hitEid = bEid
        break
      }
    }

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
      removeEntity(sim, eid)
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
  const handle = RBHandleStore.get(ownerEid)
  if (!handle) return null
  const rb = phys.world.getRigidBody(handle.handle)
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
  const handle = RBHandleStore.get(ownerEid)
  if (!handle) return null
  const rb = phys.world.getRigidBody(handle.handle)
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
