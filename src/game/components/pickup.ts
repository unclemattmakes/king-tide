import { createStore } from '@/engine/sim/ecs/store'

export type PickupType = 'boost' | 'missile' | 'mine' | 'shield'

// --- A pickup spawn point in the world ---
export const PickupSpawnTag = { name: 'PickupSpawnTag' as const }
export const PickupSpawnState = { name: 'PickupSpawnState' as const }
export type PickupSpawnStateData = {
  spawnIndex: number
  position: { x: number; y: number; z: number }
  /** The pickup currently sitting in the box. Null means box is empty / on cooldown. */
  active: boolean
  /** Seconds until the box repopulates (counts down while inactive). */
  respawnIn: number
  /** What this spawn dispenses next. (Random or fixed by track.) */
  nextType: PickupType
}
export const PickupSpawnStateStore = createStore<PickupSpawnStateData>('PickupSpawnState')

// --- A bike's currently-held pickup (one slot) ---
export const PickupSlot = { name: 'PickupSlot' as const }
export type PickupSlotData = {
  held: PickupType | null
}
export const PickupSlotStore = createStore<PickupSlotData>('PickupSlot')

// --- Active boost effect on a bike ---
export const BoostEffect = { name: 'BoostEffect' as const }
export type BoostEffectData = {
  /** Seconds remaining. */
  remaining: number
  /** Throttle multiplier while active. */
  multiplier: number
}
export const BoostEffectStore = createStore<BoostEffectData>('BoostEffect')
