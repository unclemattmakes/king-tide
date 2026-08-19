import { addComponent, hasComponent, query } from 'bitecs'
import { emptyIntent, type Intent, snapshotGamepads } from './engine/input'
import type { JitterSummary } from './engine/jitter-telemetry'
import type { PerfStats } from './engine/perf-recorder'
import { playerSettings } from './engine/player-settings'
import {
  type BundleSources,
  buildBugBundle,
  copyBundle as copyBundleHelper,
  downloadBundle as downloadBundleHelper,
  type QaBundle,
} from './engine/qa/bug-bundle'
import { type ConsoleRecord, consoleTrap as getConsoleTrap } from './engine/qa/console-trap'
import { type CameraPose, setCameraPoseOverride } from './engine/render/camera-pose-override'
import type { RenderBackend } from './engine/render/renderer'
import type { WaterMesh } from './engine/render/water'
import { getWaterMesh } from './engine/render/water-service'
import type { SimWorld } from './engine/sim/ecs/world'
import type { PhysicsWorld } from './engine/sim/physics/rapier'
import { captureSnapshot, snapshotToString } from './engine/sim/snapshot'
import { sampleShore } from './engine/sim/water/shore-field'
import { sampleWakeFromTrail, type WakeSampleOut } from './engine/sim/water/wake-trail'
import {
  effectiveSteepness,
  SHOAL_FADE_DEPTH,
  SHORE_BAND_DEPTH,
  SWELL_WAVELENGTH_MIN,
  sampleHeight,
  sampleZoneFactors,
  setWaveStamps,
  type WaveFieldState,
} from './engine/sim/water/wave-field'
import { BikeTag, ControlIntentStore, PeerControlledStore, RBHandleStore } from './game/components'
import { AITag } from './game/components/ai'
import { MineTag, MissileTag, ShieldEffectStore, StunStore } from './game/components/combat'
import { PickupSlot, PickupSlotStore, type PickupType } from './game/components/pickup'
import { type RaceTick, simulateStep } from './game/sim-step'
import { getHeldPickup } from './game/systems/pickup'
import { clearCrashTracking } from './game/systems/rider-crash'
import { resetRiderForBike } from './game/systems/rider-pose'
import { computeStandings, type Standing } from './game/systems/standings'
import type { Track } from './game/tracks/types'

// Scratch for the waterSync diagnostic's wake subtraction (same single-
// threaded reuse pattern as the sim samplers' module scratch).
const _wakeScratch: WakeSampleOut = { y: 0, dydx: 0, dydz: 0 }

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
  /** Teleport the player bike to the track's start pose with zero
   *  velocity — deterministic scene reset for e2e physics specs. The
   *  player-facing respawn action snaps to the nearest racing-line
   *  point instead (boot/respawn.ts), which is wrong for specs that
   *  need identical run-ups on every attempt. */
  respawnToStart(): void
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
  /** Wave-pump counters — total events this race, last strength fired,
   *  and the performance.now() timestamp of the last event. Lets QA
   *  + dev console verify "is pumping firing at the right cadence". */
  wavePumps(): { count: number; lastStrength: number; lastAt: number }
  /** Boost-meter peek — current 0..1 charge and whether the meter is
   *  actively draining. Mirrors `BoostMeterStore` on the player bike
   *  so the dev console can verify "I pressed boost; is it engaged?"
   *  without an ECS dive. */
  boostMeter(): { charge: number; active: boolean }
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
  /** Toggle the anti-grav spline + arrow visualization. Returns new state. */
  toggleAntiGravDebug(): boolean
  /** Current anti-grav debug overlay state. */
  isAntiGravDebugOn(): boolean
  /** Toggle the per-bike hover-spring visualizer (probe rays + force
   *  arrows). Returns new state. */
  toggleHoverDebug(): boolean
  /** Current hover-debug overlay state. */
  isHoverDebugOn(): boolean
  /** Toggle the next-checkpoint direction arrow. Returns new state. Used
   *  by the screenshot harness to capture clean art frames; also the
   *  programmatic hook behind a future Settings guidance toggle. */
  toggleDirectionArrow(): boolean
  /** Current direction-arrow visibility. */
  isDirectionArrowOn(): boolean
  /** Park the camera at a fixed world pose (position + look-at target),
   *  overriding the chase camera — used by the screenshot harness to frame
   *  concept-art beats behind/beside the start line. Pass null to release. */
  setCameraPose(pose: CameraPose): void
  /** Live water-shader debug surface (`WaterMesh.debug`) for the active
   *  track, or null on procedural / edit-mode tracks with no water mesh.
   *  Exposes the same setters the water debug menu drives — lets the
   *  screenshot harness scrub foam-coverage / look uniforms in a single boot
   *  instead of re-booting per value. */
  waterDebug(): WaterMesh['debug'] | null
  /** Live handle over the track's static vinyl dressing (env-GLB
   *  buildings/set-pieces + the placed-prop group) behind one visibility
   *  switch — the frame-ablation kit's "what does the dressed scene cost"
   *  probe, the scenery sibling of `waterDebug().setWaterVisible`. Hiding
   *  snapshots the currently-visible set and showing restores exactly that
   *  set, so a mid-stream progressive reveal is never force-completed into
   *  uncompiled pipelines. Null before boot or on boot paths that don't
   *  wire it (edit mode, attract). */
  scenery(): { count: number; setVisible(on: boolean): void } | null
  /** Gerstner sim↔render transect (water-next-research.md §9): walks a line
   *  of rest points, displaces each through `WaterMesh.renderVertex` (the CPU
   *  mirror of the GPU vertex transform — pinch + zones + live amplitudes),
   *  then asks the buoyancy sampler (`sampleHeight`) what it floats on at the
   *  displaced world point. Any |Δy| beyond inverse-map noise is a positional
   *  desync between what the rider feels and what the mirror says the shader
   *  draws. Pair with `?wavedots=1&wire=1` (GPU ground truth) to close the
   *  loop — this probe alone can't catch a TSL-side bug the mirror doesn't
   *  share. Shore/shoaling-band points are skipped (the mirror is open-water
   *  only); wake terms are subtracted exactly. Defaults: 129 points × 1.5 m
   *  centred on the player, along world +X. Null before boot / no water. */
  waterSync(opts?: {
    /** Transect centre, world XZ. Default: the player. */
    x?: number
    z?: number
    /** Transect direction (normalised internally). Default (1, 0). */
    dirX?: number
    dirZ?: number
    /** Rest-point spacing, metres. Default 1.5 (sub-chop). */
    step?: number
    /** Number of rest points. Default 129 (≈192 m span). */
    count?: number
  }): WaterSyncReport | null
  /** Install (or clear) authored wave stamps on the live field — the e2e
   *  harness uses this to exercise the stamp sim↔render path on any
   *  track without authoring throwaway JSON. The water mesh mirrors the
   *  new list into its uniforms on the next tick (reference watch), so
   *  this drives BOTH sides, exactly like track-authored stamps. */
  setWaveStamps(stamps: import('./engine/sim/water/wave-field').WaveStampInput[]): void
  /** Snapshot of the live ambient wave bank — the hand-tuned default or
   *  a per-track generated spectrum (water-next-research §7.1). The e2e
   *  plumbing probe: asserts a track's `water.spectrum` actually reached
   *  the field the buoyancy sampler + shader were built from. Null
   *  before boot. */
  waveBank(): {
    count: number
    /** Entries with wavelength ≥ SWELL_WAVELENGTH_MIN (the subset the
     *  outer/skirt water layers draw and the P1 readability field keys
     *  on). */
    swellCount: number
    waves: Array<{
      wavelength: number
      amplitude: number
      speed: number
      /** Travel direction, degrees CCW from +X (pre-bearing). */
      dirDeg: number
    }>
  } | null
  /** M10.2 determinism harness. Present only when ?determinism=1 was set
   *  at boot. The sim's RAF-driven step is gated off in that mode; the
   *  harness drives `simulateStep` here. */
  determinism?: DeterminismHarness
  /** M10.4 PartyKit relay probe. Present only when ?room=<id> was set at
   *  boot. Use for verifying the wire-format round-trip across peers in a
   *  two-tab dev session. Read-only. */
  net?: NetDebugProbe
  /** Step 8 perf-recorder + HUD bridge. Attached only in dev / test mode,
   *  installed once `startGameLoop` has constructed the recorder + HUD.
   *  Lets the e2e harness and Claude debug sessions read the rolling
   *  frame-time window without poking at the HUD DOM directly. */
  perf?: PerfDebugApi
  /** Jitter telemetry summary — present only when `?jitter=1` was set at
   *  boot (attached independently of the dev/test gate, like the
   *  determinism harness, so it works on a prod build too). Quantifies the
   *  fixed-step sim vs variable render-frame cadence + the player body's
   *  per-tick vs per-frame motion smoothness, turning "the bike looks
   *  jittery" into numbers. Also mirrored on `window.__hoverJitter` so a
   *  prod build with no `__hover` surface can still read it. See
   *  engine/jitter-telemetry + the wiring in boot/game-loop. */
  jitter?: () => JitterSummary
  /** Step 8 QA bridge — console-error trap + bug-repro bundle. Attached
   *  in dev / test mode in `installDebugApi`. Production bundles ship
   *  with no `qa` surface; the trap itself stays silent. */
  qa?: QaDebugApi
}

export type QaDebugApi = {
  /** Snapshot of every console message currently in the trap ring (oldest
   *  first). Includes `console.error` / `console.warn`, uncaught
   *  exceptions, and unhandled promise rejections. */
  consoleRecords(): ConsoleRecord[]
  /** Count of records observed since boot. Use with `consoleRecordsSince`
   *  to assert "no new errors during this window". */
  consoleTotalCount(): number
  /** Records emitted since the caller observed `prevCount`. */
  consoleRecordsSince(prevCount: number): ConsoleRecord[]
  /** True iff any error-class record is currently in the ring (warnings
   *  don't count). The default assertion for e2e specs. */
  consoleHasErrors(): boolean
  /** Wipe the console-trap ring (for spec setup). */
  consoleClear(): void
  /** Build a fresh bug-repro bundle. Pure — doesn't mutate trap or any
   *  other state. Returned object is JSON-serialisable. */
  bundle(): QaBundle
  /** Trigger a browser download of the current bundle. */
  downloadBundle(filename?: string): void
  /** Best-effort clipboard copy; resolves false if the browser refused. */
  copyBundle(): Promise<boolean>
}

/** Snapshot of `renderer.info` GPU-side counters, read on demand. The
 *  per-frame `calls` / `triangles` reset each `renderer.render()`;
 *  `geometries` / `textures` are running live totals. Surfaced so the
 *  profiler harness can answer the draw-call question (the BatchedMesh /
 *  GPU-culling P2 decision is gated on whether we're draw-call-bound). */
export type RenderInfoSnapshot = {
  calls: number
  triangles: number
  geometries: number
  textures: number
}

export type PerfDebugApi = {
  /** Current rolling-window stats (≤10s @ 60 fps). Computed on demand. */
  stats(): PerfStats
  /** CSV string of every sample currently in the ring. Header included. */
  csv(): string
  /** Save the CSV to disk via the same Blob + anchor click pattern used
   *  by `downloadReplay`. Defaults to a timestamped filename. */
  downloadCsv(filename?: string): void
  /** Wipe the ring back to empty — useful in e2e tests when you want a
   *  clean window after a settle-in period. */
  resetWindow(): void
  /** Last-render `renderer.info` counters (draw calls, triangles, live
   *  geometry/texture totals). On-demand; pairs with `window.__gpuProfile`
   *  for a full CPU-frame + GPU-time + draw-call profiling picture. */
  renderInfo(): RenderInfoSnapshot
  /** Toggle the perf overlay's visibility. Returns the new state. */
  toggleHud(): boolean
  /** Current overlay visibility. */
  isHudOn(): boolean
}

export type NetDebugProbe = {
  /** True once the server has assigned us a slot AND the socket is OPEN. */
  ready(): boolean
  /** Our assigned peer slot, or -1 before the server's hello arrives. */
  peerId(): number
  /** Slots currently held by remote peers in our room. */
  remotePeers(): readonly number[]
  /** M10.11 — true if we're the AI host for the current room state.
   *  Lowest-slot peer wins. Single-player → always true. */
  isHost(): boolean
  /** Last N InputFrames received from remote peers (most recent last).
   *  Bounded — earlier frames are dropped. */
  recentRemoteFrames(): ReadonlyArray<{ tick: number; peerId: number; intent: Intent }>
  /** Last-write-wins intent buffer per remote peer slot. This is what
   *  the sim loop drains into per-tick `peerInputs` each fixed step. */
  latestPeerIntents(): Record<number, Intent>
  /** M10.11 — count of TransformSnapshot messages received from peers
   *  since connect. Useful as an e2e wait point ("wait until tab 2 has
   *  applied at least one snapshot from tab 1"). */
  snapshotsReceived(): number
  /** Sim-truth bike positions straight from the Rapier bodies (player /
   *  AI by index / remote by peer slot) — NOT render interpolation. The
   *  two-tab e2e (m10-11-state-sync.spec.ts) compares these across tabs
   *  to assert snapshot-sync convergence; AI indices line up with the
   *  snapshot wire format's `bikeIndex`. */
  bikePoses(): {
    player: { x: number; y: number; z: number } | null
    ai: ({ x: number; y: number; z: number } | null)[]
    /** true = Dynamic (locally simulated); false = kinematic
     *  (snapshot-driven). Aligned with `ai`. */
    aiDynamic: boolean[]
    remote: Record<number, { x: number; y: number; z: number }>
  }
  /** Synchronized-start barrier stamps (Date.now): when this tab
   *  reported race-loaded, when the relay's race-go arrived, and
   *  whether the relay speaks the barrier protocol at all. The two-tab
   *  e2e compares stamps across tabs to prove the shared start. */
  barrier(): { supported: boolean; loadedAt: number | null; goAt: number | null }
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

/** Result of a `waterSync` transect. All heights in metres. */
export type WaterSyncReport = {
  /** Usable (deep-water) samples actually compared. */
  samples: number
  /** Points dropped because they fell inside the shore-wave / shoaling band
   *  (depth < max(SHOAL_FADE_DEPTH, SHORE_BAND_DEPTH)) — `renderVertex` is
   *  open-water-only, so shallow points would report shoaling, not pinch. */
  skippedShallow: number
  /** Raw field steepness Q, and the post-no-fold-clamp Q actually applied. */
  steepness: number
  effectiveQ: number
  /** True when any wave zone had non-neutral factors over a usable sample. */
  zoned: boolean
  /** Largest |horizontal pinch displacement| seen — proves the transect
   *  exercised the Gerstner pinch rather than degenerating to Q ≈ 0. */
  maxDisp: number
  /** max / RMS / mean of (sim height − mirrored render height). */
  maxAbsDy: number
  rmsDy: number
  meanDy: number
  /** Highest mirrored render-surface height seen on the transect (world
   *  Y). Lets specs prove a feature was LIVE where they probed — e.g. an
   *  injected wave stamp's ridge towers over the ambient baseline. */
  maxRenderY: number
  /** Mean mirrored render-surface height across the transect (world Y).
   *  With/without-feature probes at the SAME frozen clock difference out
   *  the ambient exactly — the deterministic liveness oracle for
   *  localized features (a stamp's ridge area) where maxRenderY depends
   *  on what the ambient happens to be doing at the ridge. */
  meanRenderY: number
  /** The water clock the transect was evaluated at — lets specs steer the
   *  clock onto a deterministic cycle moment (e.g. a stamp's peak). */
  fieldTime: number
  /** Displaced world position of the worst sample. */
  worst: { x: number; z: number; dy: number }
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
  /** M10.11 — rigid body type. Dynamic = locally simulated; Kinematic =
   *  pose-driven by network snapshots; Fixed = static (shouldn't happen
   *  on bikes today). 'unknown' = couldn't resolve the body. */
  bodyType: 'dynamic' | 'kinematic-position' | 'kinematic-velocity' | 'fixed' | 'unknown'
  /** M10.11 — has the AITag component (AI controller is driving). */
  hasAI: boolean
  /** M10.11 — has the PeerControlled component (and its peerId, if so). */
  peerControlled: { peerId: number } | null
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
  toggleAntiGravDebug(): boolean
  isAntiGravDebugOn(): boolean
  toggleHoverDebug(): boolean
  isHoverDebugOn(): boolean
  toggleDirectionArrow(): boolean
  isDirectionArrowOn(): boolean
  /** Optional frame-ablation scenery handle — the track's vinyl dressing
   *  behind one visibility switch (see HoverDebug.scenery). Boot paths
   *  without GLB dressing (edit mode) simply don't provide it. */
  scenery?(): { count: number; setVisible(on: boolean): void }
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
  /** Optional accessor for the M10.4 net probe. Returns null when no
   *  ?room=<id> was provided at boot (single-player). */
  netProbe?(): NetDebugProbe | null
}

declare global {
  interface Window {
    __hover?: HoverDebug
    /** Jitter telemetry summary accessor. Attached by the game loop when
     *  `?jitter=1` is set, independent of the `__hover` dev/test gate so
     *  it's reachable on prod builds. See engine/jitter-telemetry. */
    __hoverJitter?: () => JitterSummary
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
  pumpEventCount?: number
  lastPumpStrength?: number
  lastPumpAt?: number
  boostMeterCharge?: number
  boostMeterActive?: boolean
  boostBtnDown?: boolean
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
    respawnToStart: () => {
      if (!state.ready) return
      const phys = accessors.phys()
      const track = accessors.track()
      const rbh = RBHandleStore.get(accessors.playerEid())
      const rb = rbh ? phys.world.getRigidBody(rbh.handle) : null
      if (!rb) return
      const halfYaw = track.start.yaw / 2
      clearCrashTracking(accessors.playerEid())
      rb.setTranslation(
        { x: track.start.position.x, y: track.start.position.y, z: track.start.position.z },
        true,
      )
      rb.setRotation({ x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) }, true)
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
      resetRiderForBike(accessors.sim(), phys, accessors.playerEid())
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
    wavePumps: () => ({
      count: state.pumpEventCount ?? 0,
      lastStrength: state.lastPumpStrength ?? 0,
      lastAt: state.lastPumpAt ?? 0,
    }),
    boostMeter: () => ({
      charge: state.boostMeterCharge ?? 0,
      active: state.boostMeterActive ?? false,
    }),
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
    toggleAntiGravDebug: () => accessors.toggleAntiGravDebug(),
    isAntiGravDebugOn: () => accessors.isAntiGravDebugOn(),
    toggleHoverDebug: () => accessors.toggleHoverDebug(),
    isHoverDebugOn: () => accessors.isHoverDebugOn(),
    toggleDirectionArrow: () => accessors.toggleDirectionArrow(),
    isDirectionArrowOn: () => accessors.isDirectionArrowOn(),
    setCameraPose: (pose) => setCameraPoseOverride(pose),
    waterDebug: () => getWaterMesh()?.debug ?? null,
    scenery: () => (state.ready ? (accessors.scenery?.() ?? null) : null),
    setWaveStamps: (stamps) => {
      if (!state.ready) return
      setWaveStamps(accessors.waveField(), stamps)
    },
    waveBank: () => {
      if (!state.ready) return null
      const field = accessors.waveField()
      const waves = field.waves.map((w) => ({
        wavelength: w.wavelength,
        amplitude: w.amplitude,
        speed: w.speed,
        dirDeg: (Math.atan2(w.dirZ, w.dirX) * 180) / Math.PI,
      }))
      return {
        count: waves.length,
        swellCount: field.waves.filter((w) => w.wavelength >= SWELL_WAVELENGTH_MIN).length,
        waves,
      }
    },
    waterSync: (opts) => {
      const mesh = getWaterMesh()
      if (!mesh || !state.ready) return null
      const field = accessors.waveField()
      const p = state.playerSnapshot
      const cx = opts?.x ?? p?.position.x ?? 0
      const cz = opts?.z ?? p?.position.z ?? 0
      const count = Math.max(2, Math.floor(opts?.count ?? 129))
      const step = opts?.step ?? 1.5
      const dLen = Math.hypot(opts?.dirX ?? 1, opts?.dirZ ?? 0) || 1
      const dirX = (opts?.dirX ?? 1) / dLen
      const dirZ = (opts?.dirZ ?? 0) / dLen
      // Centre the transect on (cx, cz).
      const x0 = cx - (dirX * step * (count - 1)) / 2
      const z0 = cz - (dirZ * step * (count - 1)) / 2
      // Past this depth the shore wave (< SHORE_BAND_DEPTH) is inert and
      // the mirror + sampler evaluate the same terms. Terrain shoaling is
      // NOT a skip reason: `renderVertex` models the same factor the GPU
      // applies (it must, since shoaling v2 reaches to 14 m — coastal
      // transects would have nowhere left to compare).
      const deepThreshold = Math.max(SHOAL_FADE_DEPTH, SHORE_BAND_DEPTH)
      const v = { x: 0, y: 0, z: 0 }
      let samples = 0
      let skippedShallow = 0
      let sumDy = 0
      let sumSqDy = 0
      let maxAbsDy = 0
      let maxDisp = 0
      let maxRenderY = Number.NEGATIVE_INFINITY
      let sumRenderY = 0
      let zoned = false
      const worst = { x: 0, z: 0, dy: 0 }
      for (let i = 0; i < count; i++) {
        const rx = x0 + dirX * step * i
        const rz = z0 + dirZ * step * i
        mesh.renderVertex(rx, rz, v)
        if (field.shore) {
          const s = sampleShore(field.shore, v.x, v.z)
          if (s && s.depth < deepThreshold) {
            skippedShallow++
            continue
          }
        }
        const fx = sampleZoneFactors(field.zones, v.x, v.z, field.time)
        if (
          fx.heightMult !== 1 ||
          fx.freqMult !== 1 ||
          fx.surgeY !== 0 ||
          fx.bearingRad !== undefined
        ) {
          zoned = true
        }
        // The sampler adds per-bike wake trails; the mirror doesn't. The wake
        // is a world-point term (no inverse-map interaction), so subtracting
        // it here is exact, not an approximation.
        let wakeY = 0
        for (const tr of field.trails) {
          sampleWakeFromTrail(tr, v.x, v.z, field.time, _wakeScratch)
          wakeY += _wakeScratch.y
        }
        const dy = sampleHeight(field, v.x, v.z) - wakeY - v.y
        const disp = Math.hypot(v.x - rx, v.z - rz)
        if (disp > maxDisp) maxDisp = disp
        if (v.y > maxRenderY) maxRenderY = v.y
        sumRenderY += v.y
        samples++
        sumDy += dy
        sumSqDy += dy * dy
        const a = Math.abs(dy)
        if (a > maxAbsDy) {
          maxAbsDy = a
          worst.x = v.x
          worst.z = v.z
          worst.dy = dy
        }
      }
      return {
        samples,
        skippedShallow,
        steepness: field.steepness,
        effectiveQ: effectiveSteepness(field),
        zoned,
        maxDisp,
        maxAbsDy,
        rmsDy: samples > 0 ? Math.sqrt(sumSqDy / samples) : 0,
        meanDy: samples > 0 ? sumDy / samples : 0,
        maxRenderY: samples > 0 ? maxRenderY : 0,
        meanRenderY: samples > 0 ? sumRenderY / samples : 0,
        fieldTime: field.time,
        worst,
      }
    },
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
          trickLeft: false,
          trickRight: false,
        }
        const rapierBT = phys.rapier.RigidBodyType
        const bodyTypeRaw = rb.bodyType()
        const bodyType: BikeDebugSnapshot['bodyType'] =
          bodyTypeRaw === rapierBT.Dynamic
            ? 'dynamic'
            : bodyTypeRaw === rapierBT.KinematicPositionBased
              ? 'kinematic-position'
              : bodyTypeRaw === rapierBT.KinematicVelocityBased
                ? 'kinematic-velocity'
                : bodyTypeRaw === rapierBT.Fixed
                  ? 'fixed'
                  : 'unknown'
        const peerControlled = PeerControlledStore.get(eid) ?? null
        out.push({
          eid,
          pos: { x: t.x, y: t.y, z: t.z },
          vel: { x: v.x, y: v.y, z: v.z },
          rot: { x: q.x, y: q.y, z: q.z, w: q.w },
          angvel: { x: av.x, y: av.y, z: av.z },
          intent: { ...intent },
          held: PickupSlotStore.get(eid)?.held ?? null,
          bodyType,
          hasAI: hasComponent(sim, eid, AITag),
          peerControlled,
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
        const sample = (i: number): Intent =>
          intents[Math.min(i, intents.length - 1)] ?? emptyIntent()
        // Reused single-entry peer-input map — the determinism harness
        // only ever drives slot 0 (the local peer).
        const peerInputs = new Map<number, Intent>()
        for (let i = 0; i < ticks; i++) {
          peerInputs.clear()
          peerInputs.set(0, sample(i))
          simulateStep(sim, phys, waveField, track, raceTick, {
            peerInputs,
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

  const netProbe = accessors.netProbe?.() ?? null
  if (netProbe) {
    api.net = netProbe
  }

  // QA surface — console trap + bug bundle. Gated on dev/test like the
  // rest of __hover; production never sees the trap nor the bundle. The
  // bundle's `sources` closes over the live accessors so each call
  // re-samples — the bundle is a snapshot, not a cache.
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    const trap = getConsoleTrap()
    const sources: BundleSources = {
      consoleTrap: trap,
      player: () => {
        const p = state.playerSnapshot
        if (!p) return null
        return {
          eid: p.eid,
          position: { ...p.position },
          velocity: { ...p.velocity },
          speed: p.speed,
          isGrounded: p.isGrounded,
        }
      },
      race: () => {
        const r = state.raceSnapshot
        if (!r) return null
        return { ...r }
      },
      renderer: () => state.backend,
      settings: () => playerSettings,
      perfStats: () => (state.ready && api.perf ? api.perf.stats() : null),
      network: () =>
        netProbe
          ? {
              ready: netProbe.ready(),
              peerId: netProbe.peerId(),
              remotePeers: netProbe.remotePeers(),
              isHost: netProbe.isHost(),
              snapshotsReceived: netProbe.snapshotsReceived(),
            }
          : null,
    }
    api.qa = {
      consoleRecords: () => trap?.records() ?? [],
      consoleTotalCount: () => trap?.totalCount() ?? 0,
      consoleRecordsSince: (prev) => trap?.recordsSince(prev) ?? [],
      consoleHasErrors: () => trap?.hasErrors() ?? false,
      consoleClear: () => trap?.clear(),
      bundle: () => buildBugBundle(sources),
      downloadBundle: (filename?: string) =>
        downloadBundleHelper(buildBugBundle(sources), filename),
      copyBundle: () => copyBundleHelper(buildBugBundle(sources)),
    }
  }

  // Normally __hover is dev/test only — exposing setIntentOverride etc.
  // in a public build would let anyone drive the bike from devtools. The
  // determinism harness is the exception: read-only snapshot() plus a
  // self-contained run() that doesn't touch shared state, and we need it
  // reachable on a Vercel preview to do cross-machine determinism testing.
  // So when ?determinism=1 is set, attach the API even in prod.
  if (import.meta.env.DEV || import.meta.env.MODE === 'test' || accessors.determinismMode()) {
    window.__hover = api
  }
  return api
}

/**
 * Step 8 — late-bind the perf API onto `window.__hover.perf`.
 *
 * `installDebugApi` runs in main.ts BEFORE the rAF loop is constructed,
 * but the perf-recorder + HUD live inside `startGameLoop`. So the loop
 * calls this helper once it's built them to graft the surface area onto
 * the live debug bridge. Gated to dev / test mode + the determinism
 * harness (same gate as `__hover` itself) — production bundles get
 * nothing attached. The `downloadCsv` wrapper is built here because the
 * Blob+anchor pattern is DOM-specific and we want the game-loop code
 * to stay focused on plumbing.
 */
export type PerfDebugInstall = {
  stats: () => PerfStats
  csv: () => string
  resetWindow: () => void
  renderInfo: () => RenderInfoSnapshot
  toggleHud: () => boolean
  isHudOn: () => boolean
}

export function installPerfDebugApi(install: PerfDebugInstall): void {
  // Determinism mode publishes a curated __hover in prod, but the perf
  // recorder isn't part of that contract — gate on dev/test only.
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'test') return
  const hover = window.__hover
  if (!hover) return
  hover.perf = {
    stats: install.stats,
    csv: install.csv,
    resetWindow: install.resetWindow,
    renderInfo: install.renderInfo,
    toggleHud: install.toggleHud,
    isHudOn: install.isHudOn,
    downloadCsv: (filename?: string) => {
      const text = install.csv()
      const blob = new Blob([text], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const name = filename ?? `hoverbike-perf-${stamp}.csv`
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
  }
}
