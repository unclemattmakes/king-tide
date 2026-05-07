import { createStore } from '@/engine/sim/ecs/store'

// Shield: temporary invulnerability bubble. On hit, consumed (remaining set
// to 0) and the hit is absorbed.
export const ShieldEffect = { name: 'ShieldEffect' as const }
export type ShieldEffectData = {
  /** Seconds remaining of active protection. */
  remaining: number
}
export const ShieldEffectStore = createStore<ShieldEffectData>('ShieldEffect')

// Stun: applied to a bike that took a mine/missile hit. While remaining > 0,
// the stun-override system zeros their throttle/steer/brake/pitch so the
// player can't drive through the spinout.
export const Stun = { name: 'Stun' as const }
export type StunData = {
  remaining: number
}
export const StunStore = createStore<StunData>('Stun')

// Mine: dropped behind a bike, sits in place, detonates on proximity.
export const MineTag = { name: 'MineTag' as const }
export const MineState = { name: 'MineState' as const }
export type MineStateData = {
  ownerEid: number
  position: { x: number; y: number; z: number }
  /** Seconds since spawn — used for an arming delay so the dropper doesn't
   * blow themselves up. */
  ageSec: number
  /** Set true the frame the mine triggers; the system removes the entity
   * one tick later so render can fade out. */
  detonated: boolean
  /** Detonation visual scale (grows after detonated for one frame's worth
   * of visual feedback before despawn). */
  detonatedAt: number
}
export const MineStateStore = createStore<MineStateData>('MineState')

// Missile: launched from a bike, homes on a target until impact or timeout.
export const MissileTag = { name: 'MissileTag' as const }
export const MissileState = { name: 'MissileState' as const }
export type MissileStateData = {
  ownerEid: number
  /** Target bike eid, or -1 if no target was found (flies straight). */
  targetEid: number
  position: { x: number; y: number; z: number }
  velocity: { x: number; y: number; z: number }
  ageSec: number
  detonated: boolean
}
export const MissileStateStore = createStore<MissileStateData>('MissileState')

// Explosion: short-lived visual effect spawned at the impact point of a mine
// or missile. Render layer reads ageSec to drive scale + alpha.
export const ExplosionTag = { name: 'ExplosionTag' as const }
export const ExplosionState = { name: 'ExplosionState' as const }
export type ExplosionStateData = {
  position: { x: number; y: number; z: number }
  ageSec: number
  /** Total seconds before despawn. */
  lifetime: number
  /** Tint so missile/mine/shield-block can read distinct. */
  color: number
}
export const ExplosionStateStore = createStore<ExplosionStateData>('ExplosionState')
