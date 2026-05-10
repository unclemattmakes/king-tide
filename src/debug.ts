import { addComponent, query } from 'bitecs'
import { type Intent, snapshotGamepads } from './engine/input'
import type { RenderBackend } from './engine/render/renderer'
import type { SimWorld } from './engine/sim/ecs/world'
import type { PhysicsWorld } from './engine/sim/physics/rapier'
import { BikeTag, ControlIntentStore, RBHandleStore } from './game/components'
import { MineTag, MissileTag, ShieldEffectStore, StunStore } from './game/components/combat'
import { PickupSlot, PickupSlotStore, type PickupType } from './game/components/pickup'
import { getHeldPickup } from './game/systems/pickup'
import { computeStandings, type Standing } from './game/systems/standings'
import type { Track } from './game/tracks/types'

/**
 * Dev-only debug API. Lets Playwright (and Claude in a Chrome session) drive
 * the game programmatically: query state, push synthetic input, etc.
 *
 * Grows with each milestone.
 */
export type PlayerSnapshot = {
  /** ECS entity id of the player bike, or null if not yet spawned. */
  eid: number | null
  position: { x: number; y: number; z: number }
  velocity: { x: number; y: number; z: number }
  groundDistance: number
  isGrounded: boolean
  speed: number
}

export type RaceSnapshot = {
  lap: number
  lapsToFinish: number
  nextCheckpoint: number
  checkpointsCrossed: number
  totalCheckpoints: number
  finished: boolean
  raceTime: number
}

export type HoverDebug = {
  ready: boolean
  backend(): RenderBackend
  fps(): number
  frame(): number
  gamepads(): ReturnType<typeof snapshotGamepads>
  intent(): Intent
  setIntentOverride(i: Intent | null): void
  player(): PlayerSnapshot | null
  race(): RaceSnapshot | null
  standings(): Standing[]
  /** Player ECS entity id, once boot completes. */
  playerEid(): number | null
  /** Currently-held pickup type, or null. */
  heldPickup(): PickupType | null
  /** Set the player's held pickup directly — for deterministic e2e tests. */
  setHeldPickup(type: PickupType | null): void
  /** Set ANY bike's held pickup directly — for AI-fires-pickup e2e tests. */
  setBikeHeldPickup(eid: number, type: PickupType | null): void
  /** Inspect combat state on the player bike. */
  combat(): CombatDebugSnapshot
  /** Count of live mine + missile entities (sim-side, regardless of render). */
  combatEntityCounts(): { mines: number; missiles: number }
  /** Enumerate every bike's transform + intent — for AI debugging. */
  bikes(): BikeDebugSnapshot[]
  /** Toggle auto-play: when on, AI controls the player bike. Returns new state. */
  toggleAutoPlay(): boolean
  /** Current auto-play state. */
  isAutoPlay(): boolean
  /** Toggle the Rapier collision wireframe overlay. Returns new state. */
  toggleCollisionDebug(): boolean
  /** Current collision-debug overlay state. */
  isCollisionDebugOn(): boolean
}

export type CombatDebugSnapshot = {
  shieldRemaining: number
  stunRemaining: number
}

export type BikeDebugSnapshot = {
  eid: number
  pos: { x: number; y: number; z: number }
  vel: { x: number; y: number; z: number }
  /** World-space rotation quaternion. */
  rot: { x: number; y: number; z: number; w: number }
  /** World-space angular velocity (rad/s). */
  angvel: { x: number; y: number; z: number }
  intent: Intent
  /** Currently-held pickup, or null. */
  held: PickupType | null
}

export type DebugAccessors = {
  sim(): SimWorld
  phys(): PhysicsWorld
  track(): Track
  playerEid(): number
  toggleAutoPlay(): boolean
  isAutoPlay(): boolean
  toggleCollisionDebug(): boolean
  isCollisionDebugOn(): boolean
  /** Fast-forward the start countdown — used implicitly when an intent
   *  override is set so e2e tests don't have to wait through 3-2-1. */
  skipCountdown(): void
}

declare global {
  interface Window {
    __hover?: HoverDebug
  }
}

export type DebugState = {
  ready: boolean
  backend: RenderBackend
  fps: number
  frame: number
  intent: Intent
  intentOverride: Intent | null
  playerSnapshot: PlayerSnapshot | null
  raceSnapshot: RaceSnapshot | null
}

export function installDebugApi(state: DebugState, accessors: DebugAccessors): HoverDebug {
  const api: HoverDebug = {
    get ready() {
      return state.ready
    },
    backend: () => state.backend,
    fps: () => state.fps,
    frame: () => state.frame,
    gamepads: () => snapshotGamepads(),
    intent: () => ({ ...state.intent }),
    setIntentOverride: (i) => {
      state.intentOverride = i
      // Scripted intent comes from tests / debug shells, which don't want
      // the bike held during the start countdown. Skip ahead so the
      // override takes effect immediately.
      if (i !== null) accessors.skipCountdown()
    },
    player: () => state.playerSnapshot,
    race: () => state.raceSnapshot,
    standings: () => (state.ready ? computeStandings(accessors.sim(), accessors.track()) : []),
    playerEid: () => (state.ready ? accessors.playerEid() : null),
    heldPickup: () => (state.ready ? getHeldPickup(accessors.playerEid()) : null),
    setHeldPickup: (type) => {
      if (!state.ready) return
      const sim = accessors.sim()
      const eid = accessors.playerEid()
      if (!PickupSlotStore.has(eid)) addComponent(sim, eid, PickupSlot)
      PickupSlotStore.set(eid, { held: type })
    },
    setBikeHeldPickup: (eid, type) => {
      if (!state.ready) return
      const sim = accessors.sim()
      if (!PickupSlotStore.has(eid)) addComponent(sim, eid, PickupSlot)
      PickupSlotStore.set(eid, { held: type })
    },
    combat: () => {
      if (!state.ready) return { shieldRemaining: 0, stunRemaining: 0 }
      const eid = accessors.playerEid()
      return {
        shieldRemaining: ShieldEffectStore.get(eid)?.remaining ?? 0,
        stunRemaining: StunStore.get(eid)?.remaining ?? 0,
      }
    },
    combatEntityCounts: () => {
      if (!state.ready) return { mines: 0, missiles: 0 }
      const sim = accessors.sim()
      return {
        mines: query(sim, [MineTag]).length,
        missiles: query(sim, [MissileTag]).length,
      }
    },
    toggleAutoPlay: () => accessors.toggleAutoPlay(),
    isAutoPlay: () => accessors.isAutoPlay(),
    toggleCollisionDebug: () => accessors.toggleCollisionDebug(),
    isCollisionDebugOn: () => accessors.isCollisionDebugOn(),
    bikes: () => {
      if (!state.ready) return []
      const sim = accessors.sim()
      const phys = accessors.phys()
      const eids = query(sim, [BikeTag])
      const out: BikeDebugSnapshot[] = []
      for (const eid of eids) {
        const handle = RBHandleStore.get(eid)
        if (!handle) continue
        const rb = phys.world.getRigidBody(handle.handle)
        if (!rb) continue
        const t = rb.translation()
        const v = rb.linvel()
        const q = rb.rotation()
        const av = rb.angvel()
        const intent = ControlIntentStore.get(eid) ?? {
          throttle: 0,
          steer: 0,
          brake: 0,
          fire: false,
          boost: false,
          pitch: 0,
        }
        out.push({
          eid,
          pos: { x: t.x, y: t.y, z: t.z },
          vel: { x: v.x, y: v.y, z: v.z },
          rot: { x: q.x, y: q.y, z: q.z, w: q.w },
          angvel: { x: av.x, y: av.y, z: av.z },
          intent: { ...intent },
          held: PickupSlotStore.get(eid)?.held ?? null,
        })
      }
      return out
    },
  }
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    window.__hover = api
  }
  return api
}
