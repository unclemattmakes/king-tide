import { query } from 'bitecs'
import { type Intent, snapshotGamepads } from './engine/input'
import type { RenderBackend } from './engine/render/renderer'
import type { SimWorld } from './engine/sim/ecs/world'
import type { PhysicsWorld } from './engine/sim/physics/rapier'
import { BikeTag, ControlIntentStore, RBHandleStore } from './game/components'
import type { PickupType } from './game/components/pickup'
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
  /** Enumerate every bike's transform + intent — for AI debugging. */
  bikes(): BikeDebugSnapshot[]
  /** Toggle auto-play: when on, AI controls the player bike. Returns new state. */
  toggleAutoPlay(): boolean
  /** Current auto-play state. */
  isAutoPlay(): boolean
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
}

export type DebugAccessors = {
  sim(): SimWorld
  phys(): PhysicsWorld
  track(): Track
  playerEid(): number
  toggleAutoPlay(): boolean
  isAutoPlay(): boolean
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
    },
    player: () => state.playerSnapshot,
    race: () => state.raceSnapshot,
    standings: () => (state.ready ? computeStandings(accessors.sim(), accessors.track()) : []),
    playerEid: () => (state.ready ? accessors.playerEid() : null),
    heldPickup: () => (state.ready ? getHeldPickup(accessors.playerEid()) : null),
    toggleAutoPlay: () => accessors.toggleAutoPlay(),
    isAutoPlay: () => accessors.isAutoPlay(),
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
