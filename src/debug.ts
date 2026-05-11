import { addComponent, query } from 'bitecs'
import { emptyIntent, type Intent, snapshotGamepads } from './engine/input'
import type { RenderBackend } from './engine/render/renderer'
import type { SimWorld } from './engine/sim/ecs/world'
import type { PhysicsWorld } from './engine/sim/physics/rapier'
import { captureSnapshot, snapshotToString } from './engine/sim/snapshot'
import type { WaveFieldState } from './engine/sim/water/wave-field'
import { BikeTag, ControlIntentStore, RBHandleStore } from './game/components'
import { MineTag, MissileTag, ShieldEffectStore, StunStore } from './game/components/combat'
import { PickupSlot, PickupSlotStore, type PickupType } from './game/components/pickup'
import { type RaceTick, simulateStep } from './game/sim-step'
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
  /** M10.2 determinism harness. Present only when ?determinism=1 was set
   *  at boot. The sim's RAF-driven step is gated off in that mode; the
   *  harness drives `simulateStep` here. */
  determinism?: DeterminismHarness
}

export type DeterminismHarness = {
  /** True once boot finished in determinism mode. */
  ready: boolean
  /** Stable string snapshot of sim state. Two sims that ran from the same
   *  seed + same inputs MUST produce the same string. */
  snapshot(): string
  /** Drive simulateStep `ticks` times. `intents` is sampled by tick index;
   *  if it's shorter than `ticks`, the last entry repeats. Returns the
   *  snapshot taken after the final tick. Inputs forced to `locked: false`,
   *  `autoPlay: false`, `waveTimeScale: 1` so behavior is independent of
   *  HUD state or debug menus. */
  run(intents: Intent[], ticks: number): string
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
  /** When true, ?determinism=1 was set and the live sim loop is gated off.
   *  The harness on __hover.determinism drives ticks directly. */
  determinismMode(): boolean
  /** Wave field state — needed by the determinism harness to drive
   *  simulateStep. Render and live-loop code already have it captured by
   *  closure; this exposes it to debug.ts. */
  waveField(): WaveFieldState
  /** Race-event tick function returned by createRaceSystem. The determinism
   *  harness threads this through simulateStep. */
  raceTick(): RaceTick
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

  if (accessors.determinismMode()) {
    const harness: DeterminismHarness = {
      get ready() {
        return state.ready
      },
      snapshot: () =>
        snapshotToString(captureSnapshot(accessors.sim(), accessors.phys(), accessors.waveField())),
      run: (intents, ticks) => {
        const sim = accessors.sim()
        const phys = accessors.phys()
        const waveField = accessors.waveField()
        const track = accessors.track()
        const raceTick = accessors.raceTick()
        // Fall back to emptyIntent if the caller passed an empty array.
        const sample = (i: number): Intent => intents[Math.min(i, intents.length - 1)] ?? emptyIntent()
        for (let i = 0; i < ticks; i++) {
          simulateStep(sim, phys, waveField, track, raceTick, {
            playerIntent: sample(i),
            locked: false,
            autoPlay: false,
            waveTimeScale: 1,
          })
        }
        return snapshotToString(captureSnapshot(sim, phys, waveField))
      },
    }
    api.determinism = harness
  }

  // Normally __hover is dev/test only — exposing setIntentOverride etc.
  // in a public build would let anyone drive the bike from devtools. The
  // determinism harness is the exception: read-only snapshot() plus a
  // self-contained run() that doesn't touch shared state, and we need it
  // reachable on a Vercel preview to do cross-machine determinism testing.
  // So when ?determinism=1 is set, attach the API even in prod.
  if (
    import.meta.env.DEV ||
    import.meta.env.MODE === 'test' ||
    accessors.determinismMode()
  ) {
    window.__hover = api
  }
  return api
}
