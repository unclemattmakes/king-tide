/**
 * Live-race rAF loop. The biggest body lifted out of `main.ts` — once
 * every subsystem is wired up, `startGameLoop` takes the bundle and
 * runs the fixed-step sim → render → HUD pipeline forever.
 *
 * Architecture: sim runs on a fixed-dt accumulator (see `simulateStep`
 * in `src/game/sim-step.ts`); render runs once per rAF callback. The
 * input intent is sampled once at the top of each rAF frame and fed
 * unchanged through any pending sim ticks — i.e. multiple sim ticks in
 * a single render frame all see the same intent. This matches the
 * legacy single-file behavior; future rollback netcode will swap this
 * for a per-tick intent decode.
 *
 * Determinism mode (`?determinism=1`) gates the sim off so the
 * Playwright harness can drive ticks via `__hover.determinism.run()`;
 * render still runs so the page is alive.
 */

import { query } from 'bitecs'
import * as THREE from 'three'
import type { PlayerSnapshot, RaceSnapshot } from '@/debug'
import { installPerfDebugApi } from '@/debug'
import type { AudioEngine } from '@/engine/audio/audio'
import {
  type CupFinisher,
  type CupProgress,
  clearCupProgress,
  getCupProgressFor,
  nextCupTrackId,
  pointsForPosition,
  recordCupRaceFinish,
  totalCupPoints,
} from '@/engine/cup-progress'
import { setWaveDotsController } from '@/engine/dev/dev-runtime'
import { type Intent, inputSourceLabel, readPlayerIntent } from '@/engine/input'
import { tickCameraLook } from '@/engine/input/camera-look'
import { createJitterTelemetry } from '@/engine/jitter-telemetry'
import { buildTrackList, nextTrackId } from '@/engine/menus/catalog'
import { trackDisplayName } from '@/engine/menus/tracks-catalog'
import {
  decodeInputFrameFrom,
  encodeInputFrameInto,
  INPUT_FRAME_WIRE_BYTES,
  LOCAL_PEER_ID,
} from '@/engine/net/input-frame'
import { createPerfRecorder, type PerfStats } from '@/engine/perf-recorder'
import {
  ANTI_GRAV_CAMERA_SCALAR,
  DEFAULT_PLAYER_SETTINGS,
  markTutorialCompleted,
  playerSettings,
} from '@/engine/player-settings'
import type { AnimatedPropsSystem } from '@/engine/render/animated-props'
import { createAntiGravHud } from '@/engine/render/anti-grav-hud'
import { createBoostMeterHud } from '@/engine/render/boost-meter-hud'
import type { ChaseCamera } from '@/engine/render/camera'
import { getCameraPoseOverride } from '@/engine/render/camera-pose-override'
import type { DirectionArrow } from '@/engine/render/direction-arrow'
import { createDriftTierHud } from '@/engine/render/drift-tier-hud'
import { updateSwayTime, updateWind } from '@/engine/render/foliage-sway'
import { shouldRenderFrame } from '@/engine/render/frame-cap'
import { createGpuProfiler } from '@/engine/render/gpu-profiler'
import type { HorizonRing } from '@/engine/render/horizon-ring'
import { createLaunchGradeHud } from '@/engine/render/launch-grade-hud'
import { updateLavaTime } from '@/engine/render/lava-river-material'
import { renderLeaderboardFinishBanner } from '@/engine/render/leaderboard-finish-banner'
import { createOobHud } from '@/engine/render/oob-hud'
import { createPerfHud, type RenderInfoLite } from '@/engine/render/perf-hud'
import { createPumpFx } from '@/engine/render/pump-fx'
import { getActiveTier } from '@/engine/render/quality-preset'
import type { RaceHud } from '@/engine/render/race-hud'
import type { RaceIntro } from '@/engine/render/race-intro'
import type { RaceIntroUi } from '@/engine/render/race-intro-ui'
import type { RacingLineRibbon } from '@/engine/render/racing-line-ribbon'
import { probeGpuRenderer } from '@/engine/render/renderer'
import { renderFrame } from '@/engine/render/renderer-service'
import { createSharkSequence } from '@/engine/render/shark-sequence'
import type { SkySystem } from '@/engine/render/sky'
import { setTerrainWaterLevel } from '@/engine/render/terrain-water-level-service'
import type { TrackVisuals } from '@/engine/render/track-mesh'
import { createTrickPromptHud } from '@/engine/render/trick-prompt-hud'
import { createTuckHud } from '@/engine/render/tuck-hud'
import { createTutorialHud } from '@/engine/render/tutorial-hud'
import { type BikeImpact, updateUnderwaterFog } from '@/engine/render/water'
import { createWavePumpHud } from '@/engine/render/wave-pump-hud'
import type { WaveRiderRenderSystem } from '@/engine/render/wave-rider-render'
import { sliceBestLap } from '@/engine/replay/best-lap-slice'
import { REPLAY_FLOATS_PER_BIKE, serializeReplay } from '@/engine/replay/format'
import { getGhostBestLap, setGhost } from '@/engine/replay/ghost-state'
import type { ReplayRecorder } from '@/engine/replay/recorder'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { vecHorizontalLength } from '@/engine/sim/physics/vec'
import { advanceTide, createTide, type TideConfig, tideActive } from '@/engine/sim/water/tide'
import { sampleHeight, type WaveFieldState } from '@/engine/sim/water/wave-field'
import { detectSteamDeck, getDeckProfile } from '@/engine/steam-deck'
import { createTutorialDirector } from '@/engine/tutorial/tutorial-director'
import { DEFAULT_TUTORIAL_SCRIPT } from '@/engine/tutorial/tutorial-script'
import {
  createWavePumpObserver,
  MIN_SPEED_FRAC,
  MIN_THROTTLE,
  MIN_VY_PEAK,
} from '@/engine/wave-pump-observer'
import type { AssetManifest } from '@/game/assets/manifest'
import { aiCallSign } from '@/game/bikes/callsigns'
import { type BikeVariant, variantForAiSlot } from '@/game/bikes/variants'
import {
  AntiGravOverrideStore,
  BikeStatsStore,
  BoostMeterStore,
  ControlIntentStore,
  DriftStateStore,
  HoverStateStore,
  LaunchGradeStore,
  RBHandleStore,
  TransformStore,
  TrickStateStore,
} from '@/game/components'
import {
  ExplosionState,
  ExplosionStateStore,
  ExplosionTag,
  MineTag,
  MissileState,
  MissileStateStore,
  MissileTag,
} from '@/game/components/combat'
import { OutOfBoundsStore } from '@/game/components/out-of-bounds'
import type { PickupType } from '@/game/components/pickup'
import { RacerStore } from '@/game/components/race'
import { RescueStateStore } from '@/game/components/rescue'
import type { RaceTick } from '@/game/sim-step'
import { defaultSimTuning, simTuningFromDevSettings, simulateStep } from '@/game/sim-step'
import { chargeBoostMeter } from '@/game/systems/boost-meter'
import { isOverBoostPad } from '@/game/systems/boost-pad'
import type { GhostRunner } from '@/game/systems/ghost-runner'
import { slopeAwareSweetSpot, TUCK_SWEET_SPOT, tuckFactor } from '@/game/systems/hover'
import { interpolateRenderTransforms } from '@/game/systems/interpolate-transforms'
import { GRACE_PRESETS } from '@/game/systems/oob-tuning'
import { leashFor, type OobConfig, resolveOob } from '@/game/systems/out-of-bounds'
import { getHeldPickup } from '@/game/systems/pickup'
import { tickRemoteInterp } from '@/game/systems/remote-interp'
import { ejectRider } from '@/game/systems/rider-crash'
import { resetRiderForBike } from '@/game/systems/rider-pose'
import { computeStandings } from '@/game/systems/standings'
import type { WaveRiderSystem } from '@/game/systems/wave-rider'
import type { Track } from '@/game/tracks/types'
import { createCameraTuner } from './camera-tuner'
import type { MultiplayerHandle } from './multiplayer'
import { respawnBikeToLine } from './respawn'
import { createSimSurfaceProbe } from './sim-surface-probe'
import { downloadReplay, formatTime, ordinal } from './utils'

export interface BootState {
  ready: boolean
  backend: string
  fps: number
  frame: number
  intent: Intent
  intentOverride: Intent | null
  playerSnapshot: PlayerSnapshot | null
  raceSnapshot: RaceSnapshot | null
  /** Total wave-pump events fired this race. Exposed to the QA bundle
   *  + dev console so tuning passes can verify "is pumping firing at
   *  the right cadence". */
  pumpEventCount?: number
  /** Strength of the most recent pump event (0..1). */
  lastPumpStrength?: number
  /** performance.now() timestamp of the most recent pump event. */
  lastPumpAt?: number
  /** Live boost-meter charge (0..1) on the player bike. Mirrored here
   *  each render frame so the HUD reads from one place instead of
   *  re-querying the ECS store on every paint. */
  boostMeterCharge?: number
  /** Live boost-meter active flag. Used by the render side to detect
   *  the activate/deactivate transitions for FX hooks. */
  boostMeterActive?: boolean
  /** Previous render-frame `intent.boost` for rising-edge detection
   *  on the boost button (independent of the sim's rising-edge
   *  detection in boostMeterSystem, which we can't easily observe
   *  from the render side). */
  boostBtnDown?: boolean
  /** Whether the player bike was over a boost pad last render frame.
   *  Drives the rising-edge "entered a pad" FX punch so a pad reads as
   *  a real boost (see the boost-pad feel block in the render loop). */
  onBoostPad?: boolean
}

export interface GameLoopHud {
  fpsEl: HTMLElement | null
  backendEl: HTMLElement | null
  inputEl: HTMLElement | null
  raceEl: HTMLElement | null
  audioEl: HTMLElement | null
  finishEl: HTMLElement | null
  finishTitle: HTMLElement | null
  finishSub: HTMLElement | null
  finishPos: HTMLElement | null
  finishTime: HTMLElement | null
  finishBest: HTMLElement | null
}

export interface GameLoopControl {
  /** True when the player bike is currently AI-driven (test/auto-play). */
  isAutoPlay(): boolean
  /** Engage/disengage AI auto-play — flips the sim-step flag AND swaps the
   *  player's AITag. The out-of-bounds return-to-course autopilot reuses this. */
  setAutoPlay(on: boolean): void
  /** True when the pause menu is open (single-player gates the sim). */
  isPausedForMenu(): boolean
  /** True when the determinism harness has gated off the sim. */
  isDeterminismPaused(): boolean
}

export interface GameLoopOpts {
  /** Shared boot state (intent, FPS, etc.). */
  state: BootState
  /** Subsystems. */
  sim: SimWorld
  phys: PhysicsWorld
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  /**
   * True when the renderer was constructed with GPU timestamp tracking
   * (`?gpuprofile=1` on a WebGPU backend with the `timestamp-query` feature).
   * When set, the loop spins up the opt-in GPU-time profiler and ticks it
   * once per rendered frame. False on WebGL2 / unsupported adapters, where
   * the profiler is an inert no-op. Optional so the other boot modes that
   * call `startGameLoop` don't need to thread it.
   */
  gpuTimestampsTracked?: boolean
  audio: AudioEngine
  chase: ChaseCamera
  waveField: WaveFieldState
  waterMesh: {
    tick: (impacts: readonly BikeImpact[], focus: { x: number; z: number }) => void
    debug: { getTimeScale: () => number }
    /** The sea-surface Object3D. Its `.position.y` is the world sea level the
     *  water shader mirrors each frame; the King-tide drives it live. */
    mesh: { position: { y: number } }
  }
  sky: SkySystem
  /** Per-lap weather progression. Stepped each frame; `onLapStart` is
   *  invoked from the race-system lap-start branch in main.ts (the lap
   *  signal originates there). No-op for tracks without `lapWeather`. */
  lapWeather: {
    step(dt: number): void
    onLapStart(lap: number): void
  }
  horizonRing: HorizonRing
  trackVisuals: TrackVisuals
  raceHud: RaceHud
  /** Pre-lap cinematic-camera director. Plays a short shot sequence
   *  before the race countdown arms; when its `isDone()` returns true,
   *  the loop calls `raceHud.armCountdown()` to start the 3/2/1/GO
   *  ticks. Always supplied — for tracks/modes where no intro should
   *  play, the caller passes a director built in `'off'` mode which
   *  reports done from the first tick. */
  raceIntro: RaceIntro
  /** Optional broadcast overlay shown during the intro shots. Null when
   *  the cinematic is `'off'` (multiplayer / `?skipintro=1` / opt-out).
   *  The loop ticks it from `raceIntro.elapsed()` while the director is
   *  active, hides it on the first frame the director reports done, and
   *  flips to its `skipFade()` whenever the skip prompt's handlers
   *  call `raceIntro.skip()`. */
  raceIntroUi: RaceIntroUi | null
  raceTick: RaceTick
  dirArrow: DirectionArrow
  /** Optional B3 racing-line flow ribbon. Present on the race path when the
   *  track has a `main` AI spline; absent (null) for splineless / procedural
   *  tracks and the other `startGameLoop` callers. Ticked each render frame with
   *  the wave-field clock + the player XZ; self-hides while its master flag is
   *  off, so it costs one early-out per frame until a playtest turns it on. */
  racingLineRibbon?: RacingLineRibbon | null
  physicsDebug: { tick: () => void }
  /** Per-bike hover-spring visualizer. Tick is cheap-when-off (early
   *  return on the global flag) so we always call it in the render loop. */
  hoverDebug: { tick: (sim: SimWorld) => void }
  bikeRender: () => void
  riderRender: () => void
  pickupRender: (dt: number) => void
  combatRender: (dt: number) => void
  fxTick: (dt: number) => void
  /** Pump-trick exhaust burst — called on the pump event tick to fire
   *  a one-shot blast of exhaust particles from the bike's rear. The
   *  per-frame `fxTick` continues to drive the steady-state exhaust;
   *  this is just an event-triggered overlay. */
  triggerPumpBurst: (eid: number, strength: number, perfect: boolean) => void
  /** Unified track-emitter particle system. No-op when the track ships
   *  no `kind=emitter` empties (procedural tracks, edit mode, etc.). */
  particleTick: (dt: number) => void
  /** Landmark animation — drives ``landmark_mechanical_rig`` arm
   *  rotations from ``elapsedSeconds`` since boot. No-op when the
   *  track ships no mechanical rigs. Reads
   *  ``playerSettings.animatedLandmarks`` internally; toggling it off
   *  pins arms to rest. */
  landmarkTick: (elapsedSeconds: number) => void
  /** Track + per-bike state. */
  track: Track
  trackId: string
  manifest: AssetManifest
  playerEid: number
  aiEids: number[]
  playerVariant: BikeVariant
  /** Multiplayer wiring. */
  multiplayer: MultiplayerHandle
  roomId: string | null
  /** Cup id from `?cup=<id>` — non-null when the race is part of a
   *  championship. The live cup-progress state lives in sessionStorage
   *  (`cup-progress.ts`); this id is just the lookup key. */
  cupId: string | null
  /** Replay recorder — null in replay playback mode. */
  recorder: ReplayRecorder | null
  recorderStart: number
  /** Time Trial mode flag. Routes the finish overlay through the
   *  best-lap-slice / `setGhost` persistence path, and labels the
   *  per-frame ghost runner. */
  timeTrialMode?: boolean
  /** Optional ghost runner — driven each render frame off the
   *  player's current lap time. Null when no saved ghost exists for
   *  (track, bike) or when not in TT mode. */
  ghostRunner?: GhostRunner | null
  /** Optional wave-rider sim system. Present iff the track has any
   *  prop tagged as a wave-rider. Stepped each fixed-dt tick via
   *  `simulateStep`. */
  waveRiderSys?: WaveRiderSystem
  /** Optional wave-rider render system. Present when at least one
   *  prop placement produced a WaveRider entity bound to a real prop
   *  GLB. Called each render frame to sync mesh transforms. */
  waveRiderRender?: WaveRiderRenderSystem
  /** Optional animated-prop render system. Present when the track has any
   *  prop with `animated:true` resolving to a GLB that ships animation
   *  clips (e.g. the swimming great white). `update(dt)` advances each
   *  instance's `THREE.AnimationMixer` every render frame. Render-only —
   *  no sim coupling. */
  animatedProps?: AnimatedPropsSystem
  /** True once the progressive scenery warm has compiled + revealed every
   *  deferred mesh (always true when nothing was deferred / `?progwarm=0`).
   *  When a cinematic intro played, the countdown holds — briefly, capped —
   *  until this reports true, so the warm's per-material node-build dips land
   *  on the start grid instead of the opening seconds of the race. Optional:
   *  the other `startGameLoop` callers (benchmark, wave-rider) don't thread
   *  it and get today's immediate arm. */
  sceneryWarmed?: () => boolean
  /** Lap timing state, mutated each lap. */
  lapState: {
    lapStartRaceTime: number
    bestLapThisRace: number | null
    lastLapTime: number | null
    bestLapAllTime: number | null
  }
  /** Read-only callbacks from the pause/auto/determinism controls. */
  control: GameLoopControl
  /** HUD element handles. `null` entries are tolerated. */
  hud: GameLoopHud
  /** Called when the player crosses the finish line. */
  onFinish: () => void
  /** Tutorial mode flag — when true, the loop spins up the tutorial
   *  director + HUD widget alongside the live race. The framework is
   *  track-agnostic (the default script clears on generic
   *  throttle/look/pump/anti-grav signals) so any track works. */
  tutorialMode?: boolean
}

/**
 * Apply a forward impulse along the bike's heading proportional to
 * `strength`. Capped at a fraction of `topSpeed` so chained kicks
 * preserve speed through a swell train without runaway acceleration.
 *
 * Three tiers, gated by the `tier` argument:
 *
 *   - `'trick'`   — credible trick lands. Small forward impulse plus
 *                   a vertical loft, so the bike visibly leaves the
 *                   surface and the trick reads as happening in an
 *                   air arc rather than on the terrain. The bigger
 *                   speed payoff comes from the boost meter the
 *                   trick fills.
 *   - `'boost'`   — boost-meter activation kick. Full-strength impulse,
 *                   purely horizontal. Pairs with the sustained accel
 *                   multiplier the meter system applies via hover.ts.
 *
 * The bike's velocity-cap sits at `topSpeed * PUMP_SPEED_CAP_FRAC` —
 * meaningfully above the natural topSpeed gate (which sits at 1.0) so
 * the kick pushes the bike into an "earned overspeed" band that drag
 * pulls back from over the next 1–2 s. The `speedFalloff` term in
 * `hover.ts` already kills accel past topSpeed, so the overspeed band
 * fades naturally once kicks stop firing.
 *
 * Skipped when the rigid body or its mass isn't available — defensive
 * for the edge between bike spawn and the next physics step.
 */
const PUMP_IMPULSE_DV_TRICK = 3.0
const PUMP_IMPULSE_DV_BOOST = 14.5
const PUMP_IMPULSE_DV_TRICK_LIFT = 4.5
const PUMP_SPEED_CAP_FRAC = 1.3

/** Minimum clearance (m) the chase camera keeps above the local water
 *  surface. The bike rides over crests via the wave-tracking buoyancy
 *  (see WATER_SURFACE_FOLLOW in hover.ts); this clamp is the visual safety
 *  net so a tall crest behind the bike can't punch the lens underwater. */
const CAMERA_WATER_CLEARANCE = 0.6

/** Longest the countdown waits on the progressive scenery warm after the
 *  intro finishes. The single-player intro path no longer defers scenery at
 *  all (race-boot.ts `deferScenery` — the dressed scene compiles under the
 *  loading screen), so today this hold is a pure no-op safety net kept for
 *  any future cinematic-with-deferred-warm path. The cap keeps the race
 *  startable no matter what, trading the tail back for a prompt start. */
const SCENERY_WARM_HOLD_CAP_MS = 6_000

function applyPumpImpulse(
  phys: PhysicsWorld,
  playerEid: number,
  stats: { topSpeed: number; mass: number },
  strength: number,
  tier: 'trick' | 'boost',
): void {
  const handle = RBHandleStore.get(playerEid)
  if (!handle) return
  const rb = phys.world.getRigidBody(handle.handle)
  if (!rb) return
  const m = rb.mass()
  if (!Number.isFinite(m) || m <= 0) return
  // Forward direction in world XZ from the bike's quaternion. Three.js
  // would handle this with a Quaternion helper, but we're in the sim
  // layer here — do it inline.
  const q = rb.rotation()
  const fwdX = 2 * (q.x * q.z + q.y * q.w)
  const fwdZ = 1 - 2 * (q.x * q.x + q.y * q.y)
  const fwdLen = Math.hypot(fwdX, fwdZ)
  if (fwdLen < 1e-4) return
  const ux = fwdX / fwdLen
  const uz = fwdZ / fwdLen
  // How much horizontal-speed headroom remains under the pump cap.
  // 0 → fully saturated, skip the impulse so chained pumps don't pile
  // up well past the cap.
  const v = rb.linvel()
  const speed = Math.hypot(v.x, v.z)
  const cap = stats.topSpeed * PUMP_SPEED_CAP_FRAC
  if (speed >= cap) return
  const baseDv = tier === 'boost' ? PUMP_IMPULSE_DV_BOOST : PUMP_IMPULSE_DV_TRICK
  const wanted = strength * baseDv
  const allowed = Math.min(wanted, Math.max(0, cap - speed))
  // Vertical loft on tricks only — boost-pad / meter kicks stay purely
  // horizontal. The loft is scaled by strength so a marginal qualifier
  // gets a small nudge while a strong launch gets a clear arc. Applied
  // unconditionally (no speed-cap clamp on y) because the cap is a
  // horizontal-speed budget, not a vertical one.
  const liftDv = tier === 'trick' ? strength * PUMP_IMPULSE_DV_TRICK_LIFT : 0
  if (allowed <= 0 && liftDv <= 0) return
  rb.applyImpulse({ x: ux * allowed * m, y: liftDv * m, z: uz * allowed * m }, true)
}

/**
 * Run the live-race game loop forever. Synchronous — it kicks off the
 * first `requestAnimationFrame` and returns.
 */
export function startGameLoop(opts: GameLoopOpts): void {
  const {
    state,
    sim,
    phys,
    scene,
    camera,
    renderer,
    gpuTimestampsTracked = false,
    audio,
    chase,
    waveField,
    waterMesh,
    sky,
    lapWeather,
    horizonRing,
    trackVisuals,
    raceHud,
    raceIntro,
    raceIntroUi,
    raceTick,
    dirArrow,
    racingLineRibbon,
    physicsDebug,
    hoverDebug,
    bikeRender,
    riderRender,
    pickupRender,
    combatRender,
    fxTick,
    triggerPumpBurst,
    particleTick,
    landmarkTick,
    track,
    trackId,
    manifest,
    playerEid,
    aiEids,
    playerVariant,
    multiplayer,
    roomId,
    cupId,
    recorder,
    recorderStart,
    lapState,
    control,
    hud,
    onFinish,
    tutorialMode,
    timeTrialMode,
    ghostRunner,
    waveRiderSys,
    waveRiderRender,
    animatedProps,
    sceneryWarmed,
  } = opts

  let finishShown = false

  // ── Out-of-bounds (docs/out-of-bounds-design.md) ─────────────────────────
  // Single-player Race + Time Trial only — multiplayer (lockstep determinism)
  // and the tutorial opt out. The detection state machine lives in the sim
  // (`outOfBoundsSystem`); here we drive the warning popup, the autopilot
  // handoff, and the lethal consequence.
  const oobHud = createOobHud()
  const oobEligible = !roomId && !tutorialMode
  // Autopilot latches: `oobAutopilotActive` = OOB turned autopilot on (so we
  // only ever turn off what we turned on, never the dev T/F1 test mode).
  // `oobPlayerOverride` sticks once the player touches the controls during a
  // danger window, so we don't fight them by re-engaging autopilot.
  let oobAutopilotActive = false
  let oobPlayerOverride = false
  // Which outcome the in-flight shark breach is playing — read by onComplete
  // to decide respawn ('hit') vs ride-on ('nearmiss').
  let sharkLethalKind: 'hit' | 'nearmiss' = 'hit'

  // The AirJaws set-piece (Phase 2). Render-only; its callbacks drive the sim
  // mutations (rider eject, bike capture/carry, respawn) against the player rb.
  const sharkSeq = createSharkSequence({
    scene,
    camera,
    waterHeight: () => track.water?.height ?? 0,
    getBikePos: (out) => {
      const rbh = RBHandleStore.get(playerEid)
      const rb = rbh ? phys.world.getRigidBody(rbh.handle) : null
      if (!rb) return null
      const p = rb.translation()
      return out.set(p.x, p.y, p.z)
    },
    onChomp: () => {
      const rbh = RBHandleStore.get(playerEid)
      const rb = rbh ? phys.world.getRigidBody(rbh.handle) : null
      if (!rb) return
      const v = rb.linvel()
      ejectRider(sim, phys, playerEid, { x: v.x, y: v.y, z: v.z })
      // Capture the bike — kinematic so it rides the shark's mouth cleanly
      // (no physics fight) until the respawn restores it.
      rb.setBodyType(phys.rapier.RigidBodyType.KinematicPositionBased, true)
    },
    carryBikeTo: (x, y, z) => {
      const rbh = RBHandleStore.get(playerEid)
      const rb = rbh ? phys.world.getRigidBody(rbh.handle) : null
      if (rb) rb.setTranslation({ x, y, z }, true)
    },
    onComplete: () => {
      if (sharkLethalKind === 'hit') respawnToLine()
      const oob = OutOfBoundsStore.get(playerEid)
      if (oob) resolveOob(oob)
    },
    audioCue: () => audio.explosion(),
  })

  function oobConfigNow(): OobConfig {
    return {
      enabled: oobEligible && playerSettings.outOfBounds !== 'off',
      graceS: GRACE_PRESETS[playerSettings.oobGraceTimer],
    }
  }

  function playerTouchedControls(i: Intent): boolean {
    return (
      Math.abs(i.throttle) > 0.15 ||
      Math.abs(i.steer) > 0.15 ||
      Math.abs(i.pitch) > 0.15 ||
      i.brake > 0.15 ||
      i.boost ||
      i.fire ||
      i.trickLeft ||
      i.trickRight
    )
  }

  // Engage/disengage the return-to-course autopilot from the player's OOB
  // phase + raw intent. Reuses the existing test-mode seam: `setAutoPlay`
  // flips the flag the sim step reads AND swaps the player's AITag.
  function reconcileOobAutopilot(): void {
    const oob = OutOfBoundsStore.get(playerEid)
    const inDanger = !!oob && (oob.phase === 'warn' || oob.phase === 'brace')
    if (!inDanger || control.isPausedForMenu() || finishShown) {
      oobPlayerOverride = false
      if (oobAutopilotActive) {
        control.setAutoPlay(false)
        oobAutopilotActive = false
      }
      return
    }
    if (playerTouchedControls(state.intent)) oobPlayerOverride = true
    const shouldDrive = !oobPlayerOverride
    if (shouldDrive && !oobAutopilotActive && !control.isAutoPlay()) {
      control.setAutoPlay(true)
      oobAutopilotActive = true
    } else if (!shouldDrive && oobAutopilotActive) {
      control.setAutoPlay(false)
      oobAutopilotActive = false
    }
  }

  // Snap the bike onto the nearest racing-line sample, facing along the line,
  // and re-seat the rider. OOB respawn (vs. controls' respawn-to-start) so a
  // mid-race rescue doesn't cost the whole lap of progress.
  function respawnToLine(): void {
    // Shared with the manual respawn key + the stuck-rescue consumer —
    // one teleport implementation, one set of invariants (dynamic body
    // restore, tide-safe drop height, crash-tracking clear, rider
    // re-seat). See src/boot/respawn.ts.
    respawnBikeToLine({ sim, phys, track, waveField, eid: playerEid })
  }

  // Stuck-rescue consumer — the sim flags a wedge / long rider-eject
  // (stuck-rescue.ts, one-shot edge like the OOB lethal flag); the loop
  // performs the actual teleport. Skipped while the shark sequence owns
  // the bike so the two rescues can't fight over the body.
  function handleRescueRequest(): void {
    const rescue = RescueStateStore.get(playerEid)
    if (!rescue || !rescue.requestedThisTick) return
    rescue.requestedThisTick = false
    if (sharkSeq.isActive()) return
    respawnToLine()
  }

  // Consume the one-shot lethal trigger. Phase 1: 'hit' snaps you back on
  // course; 'nearmiss' lets you ride on (you recovered in time). Phase 2 swaps
  // in the shark cutscene here. The forfeit already stands either way.
  function handleOobLethal(): void {
    const oob = OutOfBoundsStore.get(playerEid)
    if (!oob || !oob.lethalTriggeredThisTick) return
    oob.lethalTriggeredThisTick = false
    if (playerSettings.outOfBounds === 'shark') {
      // The great white takes over. Leave oob.phase === 'lethal' so the sim
      // holds (the system no-ops, no re-trigger) until the sequence's
      // onComplete respawns + resolves it.
      sharkLethalKind = oob.lethalKind ?? 'hit'
      const rbh = RBHandleStore.get(playerEid)
      const rb = rbh ? phys.world.getRigidBody(rbh.handle) : null
      const p = rb?.translation()
      sharkSeq.start(sharkLethalKind, {
        x: p?.x ?? 0,
        y: p?.y ?? track.water?.height ?? 0,
        z: p?.z ?? 0,
      })
    } else {
      // Autopilot mode — quiet rescue, no shark.
      if (oob.lethalKind === 'hit') respawnToLine()
      resolveOob(oob)
    }
    if (oobAutopilotActive) {
      control.setAutoPlay(false)
      oobAutopilotActive = false
    }
    oobPlayerOverride = false
  }

  // Per-frame audio dispatch needs to remember "what was true last tick" so
  // it can fire one-shots on transitions. Player slot for collect/fire
  // events; sim entity counts for any-bike weapon spawns.
  let prevPlayerHeld: PickupType | null = null
  let prevMineCount = 0
  let prevMissileCount = 0
  let prevExplosionCount = 0

  // Pump-trick signal — detects clean crest launches on the player
  // bike each render frame (wave crest, ramp lip, terrain bump) and
  // fires the HUD chyron + audio cue + over-the-top FX overlay. Lives
  // on the render side (not in simulateStep) because pump events are
  // pure feedback — no determinism dependency, no replay obligations.
  const wavePumpObserver = createWavePumpObserver()
  const wavePumpHud = createWavePumpHud()
  const pumpFx = createPumpFx(camera)
  const boostMeterHud = createBoostMeterHud()
  const driftTierHud = createDriftTierHud()
  const tuckHud = createTuckHud(TUCK_SWEET_SPOT)
  const trickPromptHud = createTrickPromptHud()
  // Launch/landing verdict chyron — the wave-mastery feedback loop's
  // render half. Sim decides (launchGradeSystem); this only announces.
  const launchGradeHud = createLaunchGradeHud()

  // Anti-grav HUD widget. Reads the player bike's AntiGravOverride
  // each render frame and fades the indicator in/out. The chase
  // camera's anti-grav follow weight piggybacks on the same per-frame
  // read so the two surfaces stay in lockstep.
  const antiGravHud = createAntiGravHud()

  // Tutorial framework — spun up only when the caller passed
  // `tutorialMode: true`. The HUD + director sit in the per-frame
  // block below; we also notify the director from the wave-pump fire
  // path so beat 4 ("WAVE PUMP") clears on a real pump event.
  const tutorialHud = tutorialMode ? createTutorialHud() : null
  const tutorialDirector = tutorialMode
    ? createTutorialDirector(DEFAULT_TUTORIAL_SCRIPT, {
        onBeatArmed: (beat) => {
          const idx = tutorialDirector?.currentBeatIndex() ?? 0
          const total = DEFAULT_TUTORIAL_SCRIPT.beats.length
          tutorialHud?.setBeat({
            title: beat.title,
            ...(beat.hint ? { hint: beat.hint } : {}),
            progressLabel: `BEAT ${idx + 1}/${total}`,
          })
        },
        onBeatCleared: (beat, how) => {
          // Celebrate only what was actually performed; a timed-out
          // beat moves on with a neutral flash — no "+PUMP" for a
          // pump that never happened.
          tutorialHud?.flashCleared(how === 'performed' ? (beat.clearMessage ?? 'OK') : 'MOVING ON')
        },
        onCompleted: () => {
          tutorialHud?.finish(DEFAULT_TUTORIAL_SCRIPT.finishMessage)
          markTutorialCompleted()
        },
      })
    : null

  // Set a sensible default wind once at race start. The per-track wind
  // round-trip is a Phase α follow-up — for now every track gets a
  // gentle on-shore breeze so palms aren't statically rigid. Direction
  // is world-XZ unit vector (here: +X, "east"); strength is metres of
  // peak xz displacement applied to a fully-swaying vertex tip.
  updateWind({ x: 1, z: 0.2 }, 0.18, 1.4)

  const tmpPos = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()
  const tmpTarget = new THREE.Vector3()
  // Scratch for pushing the chase cam's live rest pose into the race-intro
  // director each frame — see the intro-active block below. Kept at loop
  // scope so the push is allocation-free.
  const introChaseRestPos = new THREE.Vector3()
  const introChaseRestLook = new THREE.Vector3()

  // Reused per-frame minimap-dot buffer. raceHud copies the array each tick
  // (it sorts a shallow clone), so we can safely truncate and mutate in place.
  // The dot objects themselves live in `hudBikePool` and are mutated by index
  // so the population path is allocation-free once the pool is warm.
  type HudBike = { x: number; z: number; isPlayer: boolean; isLeader: boolean }
  const hudBikes: HudBike[] = []
  const hudBikePool: HudBike[] = []

  // Reused per-frame buffer for the GPU water shader's bike impact array —
  // drives the at-hull effects (dimple, propwash, bow spray). Sourced from
  // `waveField.wakes`, which `wakeUpdateSystem` populated in the physics
  // loop above. The trailing WAKE itself doesn't ride this: the water mesh
  // reads the sim's `waveField.trails` directly (the same points buoyancy
  // samples), so the drawn wake and the felt wake can't diverge.
  // Returned view (truncated each frame) plus a persistent index-pool of
  // mutable impact objects, mutated by index so the population path is
  // allocation-free once the pool is warm — same pattern as `hudBikePool`.
  const bikeImpacts: BikeImpact[] = []
  const bikeImpactPool: BikeImpact[] = []
  function gatherBikeImpacts(): readonly BikeImpact[] {
    bikeImpacts.length = 0
    for (const w of waveField.wakes) {
      let impact = bikeImpactPool[bikeImpacts.length]
      if (!impact) {
        impact = { x: 0, z: 0, vx: 0, vz: 0, weight: 0 }
        bikeImpactPool.push(impact)
      }
      impact.x = w.x
      impact.z = w.z
      impact.vx = w.vx
      impact.vz = w.vz
      impact.weight = w.weight
      bikeImpacts.push(impact)
    }
    return bikeImpacts
  }

  let last = performance.now()
  let physAccum = 0
  let framesThisSecond = 0
  let fpsAccumStart = last
  // Step 8 — wall-clock anchor for the framerate cap. The gate compares
  // `now - lastRenderedAt` against `1000/cap` so a rAF tick that fires
  // mid-interval just bails out of the render half (sim still steps,
  // determinism preserved). `0` here means "fire the very next eligible
  // frame" — the cap kicks in only after the first render lands.
  let lastRenderedAt = 0

  // ── King-tide ──────────────────────────────────────────────────────────
  // A slow vertical swing of the mean water level across the race (see
  // engine/sim/water/tide.ts). Authored per-track via `water.tide`; a
  // `?tide=<amp>[,<periodS>[,<phase>]]` URL override forces/retunes it on any
  // track for verification (amplitude 0 = off). The frame loop assigns the
  // current `tide.height` to BOTH `waveField.baseY` (sim buoyancy) and
  // `waterMesh.mesh.position.y` (the shader's sea level) so the surface, the
  // floating buoys and the gate bob all ride it together. Untouched when the
  // track ships no tide and no override → every existing track is unchanged.
  const tideBaseHeight = track.water?.height ?? 0
  const tideOverride = ((): TideConfig | undefined => {
    if (typeof window === 'undefined') return undefined
    const raw = new URLSearchParams(window.location.search).get('tide')
    if (raw === null) return undefined
    const parts = raw.split(',')
    const amp = Number(parts[0])
    const period = Number(parts[1])
    const phase = Number(parts[2])
    if (!Number.isFinite(amp)) return undefined
    return {
      amplitudeM: amp,
      periodS: Number.isFinite(period) && period > 0 ? period : 120,
      ...(Number.isFinite(phase) ? { phase } : {}),
    }
  })()
  const tide = createTide(tideBaseHeight, tideOverride ?? track.water?.tide)

  // Step 8 — Perf overlay + rolling-window recorder. The recorder samples
  // every render frame (allocation-free); the HUD reads cached stats at
  // the same 500 ms cadence as the FPS pill so we don't pay the percentile
  // sort 60x/sec. Initial visibility flips on for `?perf=1`; the global
  // backquote keybind toggles thereafter. Both default to off in normal
  // gameplay so the panel never gets in the way unless explicitly asked
  // for. The `renderer.info` shape is the live, mutating object — we
  // capture the reference once.
  const perfRecorder = createPerfRecorder()
  const perfHud = createPerfHud()
  // Static env diagnostics — backend, real GPU driver (hardware vs llvmpipe),
  // and whether the Deck profile latched. Set once; persists across toggles.
  perfHud.setDiagnostics({
    backend: state.backend,
    gpu: probeGpuRenderer(),
    deckApplied: getDeckProfile() !== null,
    deckSignals: detectSteamDeck().signals,
    quality: getActiveTier(),
  })
  const rendererInfo = (renderer as unknown as { info: RenderInfoLite }).info
  // Opt-in WebGPU GPU-time profiler (`?gpuprofile=1`). A no-op unless the
  // renderer was built with timestamp tracking (WebGPU + `timestamp-query`).
  // Ticked once per rendered frame below; it throttles the async resolve so
  // it never blocks the hot path. `renderer` is the WebGPURenderer behind the
  // WebGLRenderer cast — it exposes `resolveTimestampsAsync` + `info.*.timestamp`.
  const gpuProfiler = createGpuProfiler(
    renderer as unknown as Parameters<typeof createGpuProfiler>[0],
    { enabled: gpuTimestampsTracked },
  )
  const initialPerfOn =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('perf')
  perfHud.setVisible(initialPerfOn)
  // Cached snapshot from the last visible refresh — survives the on-off
  // toggle so the panel doesn't flash zeros on the first frame after
  // unhide. The HUD only paints when visible, so we just re-paint with
  // the cached row text from the previous fresh sample when the user
  // peeks the panel back open.
  let lastPerfStats: PerfStats = perfRecorder.stats()
  const onPerfKeyDown = (e: KeyboardEvent): void => {
    if (e.code !== 'Backquote') return
    // Don't fire while typing into a text field — backquote is a useful
    // glyph in the in-app editor's free-form inputs.
    const target = e.target as Element | null
    const tag = target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    perfHud.setVisible(!perfHud.isVisible())
    e.preventDefault()
  }
  window.addEventListener('keydown', onPerfKeyDown)
  // Surface the recorder + HUD on the dev-only __hover.perf accessor so
  // CI traces, the e2e harness and Claude debug sessions can read the
  // window's stats and dump CSVs to disk.
  installPerfDebugApi({
    stats: () => perfRecorder.stats(),
    csv: () => perfRecorder.toCsv(),
    resetWindow: () => perfRecorder.reset(),
    renderInfo: () => ({
      // drawCalls is the PER-FRAME count; render.calls is a cumulative-since-boot
      // total (three only resets it in setAnimationLoop, which this app's custom
      // rAF loop bypasses — renderFrame() resets the per-frame metrics instead).
      calls: rendererInfo.render.drawCalls,
      triangles: rendererInfo.render.triangles,
      geometries: rendererInfo.memory.geometries,
      textures: rendererInfo.memory.textures,
    }),
    isHudOn: () => perfHud.isVisible(),
    toggleHud: () => {
      perfHud.setVisible(!perfHud.isVisible())
      return perfHud.isVisible()
    },
  })

  // Jitter telemetry — opt-in via `?jitter=1`. Quantifies the fixed-step
  // sim vs variable render-frame mismatch (steps-per-frame histogram +
  // the interpolation alpha currently discarded each frame) and the
  // player body's per-tick vs per-frame motion smoothness, so "the bike
  // looks jittery" becomes a measured number rather than a vibe. Off by
  // default → zero hot-path cost; when on it adds one player rigid-body
  // read per sim tick + a periodic console summary. Reachable from
  // `window.__hoverJitter()` (prod-safe, like the determinism harness)
  // and `window.__hover.jitter()` in dev/test.
  const jitterOn =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('jitter')
  const jitter = jitterOn ? createJitterTelemetry(phys.fixedDt * 1000) : null
  let lastJitterLogAt = last
  if (jitter && typeof window !== 'undefined') {
    window.__hoverJitter = () => jitter.summary()
    if (window.__hover) window.__hover.jitter = () => jitter.summary()
    console.info(
      '[jitter] telemetry on (?jitter=1). window.__hoverJitter() for a live summary; logging every 2s.',
    )
  }

  // Sim-surface probe — opt-in via `?wavedots=1`. Parks a red dot grid at the
  // SIM water height (`sampleHeight`) around the player so the buoyancy surface
  // can be read against the rendered mesh (pair with `?wire=1`) on a REAL track
  // — unlike the synthetic `?waveriders=1` scene, this has the track's terrain
  // heightmap + shore field installed, so shoaling + shore breakers show. The
  // gap between dots and wireframe is the sim↔render discrepancy, live. Render-
  // only; never touches the sim. See sim-surface-probe.ts.
  let simSurfaceProbe =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('wavedots')
      ? createSimSurfaceProbe(scene)
      : null
  // Let the dev palette toggle the sim-surface probe live (no `?wavedots`
  // reload). The probe needs the loop's `scene` to build its dot grid and is
  // ticked below, so the loop owns the lifecycle and hands the palette a
  // create/dispose toggle. Dev builds only — same gate as the palette itself.
  if (
    typeof window !== 'undefined' &&
    (import.meta.env.DEV || new URLSearchParams(window.location.search).has('dev'))
  ) {
    setWaveDotsController({
      isOn: () => simSurfaceProbe !== null,
      toggle: () => {
        if (simSurfaceProbe) {
          simSurfaceProbe.dispose()
          simSurfaceProbe = null
        } else {
          simSurfaceProbe = createSimSurfaceProbe(scene)
        }
        return simSurfaceProbe !== null
      },
    })
  }

  // Chase-camera tuner — opt-in via `?camtune=1`. A live slider panel over the
  // running race for offset / look-ahead / orbit-pivot / damping / FOV. The
  // chase cam re-reads CHASE_CAM_TUNING every frame, so edits re-frame the view
  // immediately; the tuned look persists across reloads (localStorage) and the
  // panel's "Copy Δ" reports the delta to propagate to the other cameras. The
  // shared tuning object also drives the replay spectator-chase, so it stays in
  // step. Dev-only; render-side, never touches the sim. See camera-tuner.ts.
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('camtune')) {
    createCameraTuner(camera)
  }

  // Dev-tools palette — the always-visible dock rail + Ctrl/⌘K command bar that
  // surface every buried dev scene / tuner / debug toggle in one searchable
  // place. Dev builds only (same gate as the `body.dev-build` chrome in
  // main.ts). Loaded as its own chunk and fire-and-forget, since startGameLoop
  // is synchronous; the palette owns the dev-settings / water / camera tuners
  // now (their old top-right buttons are folded into the rail). See
  // src/engine/dev/palette.ts.
  if (
    typeof window !== 'undefined' &&
    (import.meta.env.DEV || new URLSearchParams(window.location.search).has('dev'))
  ) {
    void import('@/engine/dev/palette').then((m) => m.installDevPalette({ camera }))
  }

  // M10.4 — wire-encoded input round-trip. simTick is the monotonic count
  // of fixed-step sim ticks driven by simulateStep; it lines up across
  // peers in lockstep multiplayer because both sides advance one tick per
  // delivered InputFrame batch. The DataView is reused per tick to avoid
  // a per-frame allocation. LOCAL_PEER_ID (shared with boot/multiplayer's
  // disconnect handler) stamps frames whenever no room slot is held.
  let simTick = 0
  const inputFrameBuffer = new ArrayBuffer(INPUT_FRAME_WIRE_BYTES)
  const inputFrameView = new DataView(inputFrameBuffer)
  // Reused per-tick to feed simulateStep without allocating a fresh Map
  // each frame. cleared at the top of each tick before population.
  const tickPeerInputs = new Map<number, Intent>()

  // M10.11 — TransformSnapshot broadcast cadence: 20 Hz (every 3 sim ticks
  // at 60 Hz). Actual send lives in the multiplayer handle.
  const SNAPSHOT_TICKS = 3

  // Reused scratch buffers for the replay recorder. The recorder copies into
  // its own storage when it accepts a sample (rate-limited), so feeding it the
  // same buffer each frame is safe. Slot list is fixed for the session.
  const replaySlots: number[] = [playerEid, ...aiEids]
  const replayFlat = new Float64Array(replaySlots.length * REPLAY_FLOATS_PER_BIKE)
  // Re-used missile snapshot list, refreshed each recorder frame from
  // the live MissileState entities. The recorder copies the values
  // into its own per-track storage.
  const missileSnapshots: import('@/engine/replay/recorder').MissileSnapshot[] = []
  // Combat-event bookkeeping for the recorder. Detonation isn't an
  // event the sim emits — we infer it from a missile we'd been
  // sampling disappearing from the world between recorder ticks.
  // Explosion bursts are spawned as ExplosionTag entities; the
  // first recorder tick that sees a given eid records the burst.
  const seenMissileEids = new Set<number>()
  const lastMissilePos = new Map<number, { x: number; y: number; z: number }>()
  const recordedExplosionEids = new Set<number>()

  // Pre-lap intro state.
  //
  // The intro director runs entirely on the render side; while it's
  // active we skip the chase-camera pipeline and let the director
  // write `camera.position` + `camera.lookAt` directly. The race-hud
  // already gates the sim via `isLocked()` so no physics state
  // advances during the cinematic — same gate the existing 3/2/1
  // countdown uses.
  //
  // `introArmed` flips to true once the director reports done so the
  // `armCountdown()` call only fires once. `introSkipHandle` is the
  // skip-prompt DOM node + cleanup; lazily created on the first
  // active frame and torn down when the intro ends.
  let introArmed = raceIntro.isDone()
  // Stamped on the first frame after the director finishes; anchors the
  // scenery-warm hold cap (see the arm branch below).
  let introHoldStartedAt: number | null = null

  // Synchronized start (multiplayer). The HUD is built with deferStart
  // in a room, so no tab's 3-2-1 runs until the relay's race-go
  // releases the whole grid at once — start skew becomes one-way relay
  // latency instead of load-time difference. The loop reports
  // race-loaded once the room is ready (being inside frame() means
  // we're rendering), then arms on the go. Fallbacks: an old relay
  // (no startBarrier in its hello) arms immediately on ready — the
  // pre-barrier behavior — and a hard timeout covers a dead relay or a
  // lost go so the grid can never hang forever.
  const MP_START_FAILSAFE_MS = 15_000
  let mpStartArmed = !roomId // single-player: barrier not in play
  const mpBootedAt = performance.now()
  let introSkipPromptEl: HTMLElement | null = null
  let introSkipKeyHandler: ((e: KeyboardEvent) => void) | null = null
  let introSkipPointerHandler: ((e: Event) => void) | null = null

  function teardownIntroSkipUi(): void {
    if (introSkipKeyHandler) {
      window.removeEventListener('keydown', introSkipKeyHandler, true)
      introSkipKeyHandler = null
    }
    if (introSkipPointerHandler) {
      window.removeEventListener('mousedown', introSkipPointerHandler)
      window.removeEventListener('touchstart', introSkipPointerHandler)
      introSkipPointerHandler = null
    }
    if (introSkipPromptEl) {
      introSkipPromptEl.classList.remove('ris-active')
    }
  }

  function ensureIntroSkipUi(): void {
    if (introSkipKeyHandler) return
    // Lazy-build the skip prompt — Settings → Gameplay → "Pre-lap
    // intro: Off" players never see the DOM cost. The element id is
    // referenced by the CSS rule in index.html.
    let el = document.getElementById('race-intro-skip')
    if (!el) {
      el = document.createElement('div')
      el.id = 'race-intro-skip'
      el.textContent = 'PRESS ANY KEY · SPACE / ENTER TO SKIP'
      document.body.appendChild(el)
    }
    introSkipPromptEl = el
    el.classList.add('ris-active')

    introSkipKeyHandler = (e: KeyboardEvent) => {
      // Only act while the director is still playing — once it's done
      // a stray Space press shouldn't accidentally do anything.
      if (!raceIntro.isActive()) return
      // Avoid eating modifier-chord presses (e.g. Cmd+Shift+R). Plain
      // Space / Enter / Escape / Mouse click skip the intro.
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      raceIntro.skip()
      raceIntroUi?.skipFade()
      e.preventDefault()
    }
    introSkipPointerHandler = () => {
      if (!raceIntro.isActive()) return
      raceIntro.skip()
      raceIntroUi?.skipFade()
    }
    // Capture-phase keydown so the skip beats the pause-menu's
    // Escape handler (which is in bubble phase). The skip handler
    // exits early once the intro is done so once the race begins the
    // pause-menu handler resumes its normal Escape duties.
    window.addEventListener('keydown', introSkipKeyHandler, true)
    window.addEventListener('mousedown', introSkipPointerHandler)
    window.addEventListener('touchstart', introSkipPointerHandler, { passive: true })
  }

  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 1 / 15)
    last = now

    // King-tide: breathe the mean water level for THIS frame before the sim
    // accumulator (so buoyancy reads the new baseY) and before the render
    // (waterMesh syncs mesh.y → the shader sea level). The flat racing-line
    // ribbon rides along by the tide delta. No-op on still-water tracks.
    if (tideActive(tide)) {
      const h = advanceTide(tide, dt)
      waveField.baseY = h
      waterMesh.mesh.position.y = h
      // The terrain shader anchors its wet band / waterline trio / underwater
      // tint to this; push it so the painted shoreline rides the tide too.
      setTerrainWaterLevel(h)
      if (racingLineRibbon) racingLineRibbon.mesh.position.y = h - tideBaseHeight
    }

    // Step 8 — feed the rolling-window recorder. Allocation-free hot path
    // (writes a single Float32Array slot + advances the head index). The
    // expensive parts (sort, percentiles, render-info read) only run when
    // the HUD is visible AND the 500ms cadence ticks below.
    perfRecorder.sample(now)

    state.intent = state.intentOverride ?? readPlayerIntent(dt)

    // Reconcile the out-of-bounds autopilot BEFORE the accumulator so this
    // frame's sim steps see the handoff. Reads last tick's OOB phase + this
    // frame's raw player intent (the touch-to-resume hand-back signal).
    reconcileOobAutopilot()
    const oobCfg = oobConfigNow()
    // Sample the mutable `playerSettings.rubberBandAssist` ONCE per frame,
    // OUTSIDE the fixed-step accumulator, so the deterministic step never
    // reads the singleton mid-tick (ADR 0002 / sim-purity guard). SP feeds
    // the live toggle; MP pins the frozen default so peers agree — mirrors
    // the `tuning` SP/MP split below.
    const rubberBandAssistNow =
      roomId === null ? playerSettings.rubberBandAssist : DEFAULT_PLAYER_SETTINGS.rubberBandAssist

    physAccum += dt
    // Pause menu gates the sim in single-player. Reset the accumulator
    // so unpause doesn't trigger a burst of catch-up steps. Multiplayer
    // keeps stepping — pausing one peer can't pause the relay.
    if (control.isPausedForMenu() && !roomId) {
      physAccum = 0
    }
    // In determinism mode the sim is gated off — the harness drives ticks
    // manually via __hover.determinism.run(). physAccum keeps draining so
    // we don't spike on unpause.
    const net = multiplayer.room
    // Jitter telemetry — count the sim steps this render frame and resolve
    // the player body once so the per-tick / per-frame reads below are a
    // single handle lookup. Both are no-ops unless `?jitter=1` is set.
    let stepsThisFrame = 0
    const jitterHandle = jitter ? RBHandleStore.get(playerEid) : null
    const jitterRb = jitterHandle ? phys.world.getRigidBody(jitterHandle.handle) : null
    while (physAccum >= phys.fixedDt) {
      if (!control.isDeterminismPaused()) {
        // M10.4 — drive the sim from a wire-encoded InputFrame even in
        // single-player. The round-trip is cheap (~10 bytes / one alloc)
        // and ensures the same quantization is applied locally as remotely,
        // so any feel changes from the wire format are visible day one.
        // Frames are no longer BROADCAST, though: since M10.11 remote
        // bikes are pose-driven by TransformSnapshots (no PeerControlled
        // tag), so relayed intents drove nothing while costing
        // 60 msg/s/peer through the relay — ~20x the snapshot message
        // rate. M10.13 (owner-authoritative combat) will reintroduce
        // intent/event traffic deliberately; the codec, NetRoom.sendFrame
        // and the receive path stay wired for it.
        const myPeerId = net?.ready ? net.peerId : LOCAL_PEER_ID
        const localFrame = {
          tick: simTick,
          peerId: myPeerId,
          intent: state.intent,
        }
        encodeInputFrameInto(inputFrameView, 0, localFrame)
        const decoded = decodeInputFrameFrom(inputFrameView, 0)
        // M10.5 — sim consumes a per-peer input map. Single-player passes
        // exactly one entry (slot 0). M10.6 — when a room is connected,
        // drain the last-known intent for each remote peer in too; any
        // PeerControlled bike whose peerId is in the map receives that
        // intent.
        tickPeerInputs.clear()
        tickPeerInputs.set(decoded.peerId, decoded.intent)
        if (net) {
          for (const [pid, intent] of net.latestPeerIntents) {
            if (pid !== decoded.peerId) tickPeerInputs.set(pid, intent)
          }
        }
        const iAmHost = multiplayer.isHost()
        // M10.11+ — advance every buffered remote-bike sample to its
        // wall-clock-interpolated pose for this tick BEFORE phys.step().
        // simulateStep's own `phys.step()` then commits the kinematic
        // next-pose, so the next syncFromPhysics + render sees a smooth
        // motion instead of the per-snapshot teleport that direct
        // setNextKinematic produces at 20 Hz vs 60 Hz tick rate.
        tickRemoteInterp(phys, performance.now())
        simulateStep(sim, phys, waveField, track, raceTick, {
          peerInputs: tickPeerInputs,
          locked: raceHud.isLocked(),
          autoPlay: control.isAutoPlay(),
          waveTimeScale: waterMesh.debug.getTimeScale(),
          runAI: iAmHost,
          oob: oobCfg,
          // SP: live dev sliders still tune feel. MP (roomId set): frozen
          // defaults so peers step identically — mirrors waveTimeScale /
          // runAI pinning above (docs/systems-review.md §1.2).
          tuning: roomId === null ? simTuningFromDevSettings() : defaultSimTuning(),
          // Sampled once per frame outside the accumulator (see above) so
          // the deterministic step never reads `playerSettings` mid-tick.
          rubberBandAssist: rubberBandAssistNow,
          ...(waveRiderSys ? { waveRiders: waveRiderSys } : {}),
        })
        // M10.11 — broadcast at 20 Hz. The send is gated on `net.ready &&
        // remotePeers > 0` inside the multiplayer handle, so this no-ops
        // outside a room.
        if (simTick % SNAPSHOT_TICKS === 0) multiplayer.buildAndSendSnapshot(simTick, iAmHost)
        simTick++
        stepsThisFrame++
        // Per-tick player pose → sim-side motion smoothness + hover-ring
        // detector. Reads the body *after* this step committed.
        if (jitter && jitterRb) {
          const tp = jitterRb.translation()
          jitter.recordTick(tp.x, tp.y, tp.z)
        }
      }
      physAccum -= phys.fixedDt
    }

    // Render interpolation — write each physics body's render pose to the
    // point `renderAlpha` of the way between its last two committed ticks,
    // so the fixed 60 Hz sim renders smoothly at the variable refresh rate.
    // Runs after the accumulator drains and before the camera + any render
    // system reads TransformStore.
    const renderAlpha = physAccum / phys.fixedDt
    interpolateRenderTransforms(renderAlpha)

    // Out-of-bounds — consume any lethal trigger (in shark mode this kicks off
    // the breach; in autopilot mode it respawns / rides on), advance the
    // breach animation, and drive the warning popup. The autopilot handoff was
    // already reconciled at the top of the frame.
    handleOobLethal()
    handleRescueRequest()
    sharkSeq.tick(dt)
    oobHud.update(OutOfBoundsStore.get(playerEid), oobAutopilotActive)

    // Jitter telemetry — once per render frame, after interpolation: how
    // many steps ran, the leftover alpha, and the player's *actual rendered*
    // (interpolated) pose, so the render-jerk number reflects what's on
    // screen. Periodic console summary so `?jitter=1` is readable without
    // devtools.
    if (jitter && jitterRb) {
      const rp = TransformStore.get(playerEid) ?? jitterRb.translation()
      jitter.recordFrame(dt * 1000, stepsThisFrame, renderAlpha, rp.x, rp.y, rp.z)
      if (now - lastJitterLogAt >= 2000) {
        lastJitterLogAt = now
        const s = jitter.summary()
        console.info(
          `[jitter] render ${s.renderHz.toFixed(0)}Hz / sim ${s.simHz.toFixed(0)}Hz | ` +
            `steps/frame ${s.meanStepsPerFrame.toFixed(2)} ` +
            `(froze ${(s.zeroStepFrac * 100).toFixed(0)}%, ≥2 ${(s.multiStepFrac * 100).toFixed(0)}%) | ` +
            `alpha discarded ${(s.meanAlpha * 100).toFixed(0)}% | ` +
            `jerk render ${s.renderJerkMean.toFixed(4)}m vs sim ${s.simJerkMean.toFixed(4)}m | ` +
            `vReversals ${s.vertReversalsPerSec.toFixed(1)}/s\n         ${s.verdict}`,
        )
      }
    }

    // Replay capture. The recorder rate-limits internally (default 30Hz),
    // so we gate on `shouldSample` first to skip the per-bike WASM-bound
    // rigid-body reads on frames the recorder would discard. At a 30Hz
    // rate inside a 60Hz rAF loop that halves the per-bike `getRigidBody`
    // + `translation` + `rotation` calls (~600 WASM-bound calls/sec at
    // 5 bikes). Capture stops once the finish UI shows so the recording
    // ends cleanly at the moment of crossing the line.
    if (recorder && !finishShown) {
      const elapsed = (now - recorderStart) / 1000
      if (recorder.shouldSample(elapsed)) {
        for (let i = 0; i < replaySlots.length; i++) {
          const eid = replaySlots[i] as number
          const handle = RBHandleStore.get(eid)
          const rb = handle ? phys.world.getRigidBody(handle.handle) : null
          const o = i * REPLAY_FLOATS_PER_BIKE
          if (!rb) {
            for (let k = 0; k < REPLAY_FLOATS_PER_BIKE; k++) replayFlat[o + k] = 0
            replayFlat[o + 6] = 1 // qw — keep the identity quat for the no-rb fallback
            continue
          }
          const t = rb.translation()
          const q = rb.rotation()
          replayFlat[o] = t.x
          replayFlat[o + 1] = t.y
          replayFlat[o + 2] = t.z
          replayFlat[o + 3] = q.x
          replayFlat[o + 4] = q.y
          replayFlat[o + 5] = q.z
          replayFlat[o + 6] = q.w
          // v2 input-state slots — driven from the live ECS so playback
          // can route drift sparks / tuck slipstream / boost-blossom
          // exhaust against the actual race state. Defaults to 0 when
          // a component is missing so a partial-snapshot frame stays
          // sane.
          const intent = ControlIntentStore.get(eid)
          const drift = DriftStateStore.get(eid)
          replayFlat[o + 7] = intent?.pitch ?? 0
          replayFlat[o + 8] = intent?.throttle ?? 0
          replayFlat[o + 9] = intent?.boost ? 1 : 0
          replayFlat[o + 10] = drift?.driftDir ?? 0
          replayFlat[o + 11] = drift?.highestTier ?? 0
        }
        recorder.sample(elapsed, replayFlat)
        // Live missile snapshots — one per in-flight MissileTag entity,
        // pushed at the same cadence as bike frames so the replay-side
        // combat driver can interpolate cleanly. The recorder
        // aggregates per-eid streams into `ReplayMissileTrack` entries
        // at finalize.
        missileSnapshots.length = 0
        const liveMissiles = query(sim, [MissileTag, MissileState])
        const liveMissileSet = new Set<number>()
        for (const mEid of liveMissiles) {
          liveMissileSet.add(mEid)
          const ms = MissileStateStore.get(mEid)
          if (!ms || ms.detonated) continue
          missileSnapshots.push({
            simEid: mEid,
            x: ms.position.x,
            y: ms.position.y,
            z: ms.position.z,
            vx: ms.velocity.x,
            vy: ms.velocity.y,
            vz: ms.velocity.z,
          })
          seenMissileEids.add(mEid)
          lastMissilePos.set(mEid, {
            x: ms.position.x,
            y: ms.position.y,
            z: ms.position.z,
          })
        }
        recorder.sampleMissiles(elapsed, missileSnapshots)
        // Detonation = a missile we'd been sampling has fallen out of
        // the live set since the last recorder tick. Mark it with its
        // last-known position so the replay-side combat driver knows
        // where to pin the trail's final frame.
        for (const mEid of seenMissileEids) {
          if (liveMissileSet.has(mEid)) continue
          const pos = lastMissilePos.get(mEid)
          if (pos) recorder.markMissileDetonated(mEid, elapsed, pos)
          seenMissileEids.delete(mEid)
          lastMissilePos.delete(mEid)
        }
        // New explosion bursts — every fresh ExplosionTag entity gets
        // one record. `ageSec` lets us back-date `t` to the actual
        // spawn moment rather than the recorder-tick boundary.
        const liveExplosions = query(sim, [ExplosionTag, ExplosionState])
        const liveExplosionSet = new Set<number>()
        for (const eEid of liveExplosions) {
          liveExplosionSet.add(eEid)
          if (recordedExplosionEids.has(eEid)) continue
          recordedExplosionEids.add(eEid)
          const ex = ExplosionStateStore.get(eEid)
          if (!ex) continue
          recorder.recordExplosion({
            t: Math.max(0, elapsed - ex.ageSec),
            x: ex.position.x,
            y: ex.position.y,
            z: ex.position.z,
            color: ex.color,
            lifetime: ex.lifetime,
          })
        }
        // Prune the seen set so it doesn't grow unbounded over the
        // race. Explosions despawn after `lifetime` (~0.6 s); once
        // they're gone they can't fire again.
        for (const eEid of recordedExplosionEids) {
          if (!liveExplosionSet.has(eEid)) recordedExplosionEids.delete(eEid)
        }
      }
    }

    // Pre-lap intro — drives the camera through the cinematic shot
    // sequence before the race countdown arms. While the intro is
    // active we skip the chase-camera pipeline entirely; the director
    // writes `camera.position` + `camera.lookAt` directly. The sim is
    // already gated via `raceHud.isLocked()` because the HUD was
    // built with `deferStart: true`, so no physics state advances
    // during these shots.
    const introActive = raceIntro.isActive()
    // The shark death-cam owns the camera during a 'hit' breach (same yield as
    // the intro director). A near-miss leaves the chase cam running.
    const sharkOwnsCamera = sharkSeq.ownsCamera()
    if (introActive) {
      ensureIntroSkipUi()
      // Push the chase cam's live first-tick goal to the director so the
      // descent shot lerps onto the chase cam's actual pickup pose instead
      // of the statically-authored `chaseGoal` (which only approximates it
      // — the bike's hover spring has usually lifted it a hair above the
      // spawn Y by the time the intro plays, so the two disagree by half
      // a metre or so → visible camera pop at handoff).
      const introRbHandle = RBHandleStore.get(playerEid)
      if (introRbHandle) {
        const introPlayerRb = phys.world.getRigidBody(introRbHandle.handle)
        if (introPlayerRb) {
          const it = introPlayerRb.translation()
          const iq = introPlayerRb.rotation()
          tmpPos.set(it.x, it.y, it.z)
          tmpQuat.set(iq.x, iq.y, iq.z, iq.w)
          chase.goalPose(tmpPos, tmpQuat, introChaseRestPos, introChaseRestLook)
          raceIntro.setChaseRest(introChaseRestPos, introChaseRestLook)
        }
      }
      raceIntro.tick(dt)
      // Drive the broadcast overlay from the same elapsed clock the
      // camera uses, so the stage transitions track the shot boundaries
      // exactly. `tick` is allocation-free (just a class flip on the
      // root); safe on the hot path.
      raceIntroUi?.tick(raceIntro.elapsed())
    } else if (!introArmed) {
      // First frame after the director reports done: tear down the skip
      // prompt, then arm the countdown so the 3/2/1/GO ticks (which drive
      // the start-lights overlay) start playing. Multiplayer compositions
      // also call `armCountdown` from the lobby clear path; both call
      // sites are idempotent because `armCountdown` early-outs if the
      // countdown is already running.
      //
      // Scenery-warm hold (safety net): the intro path never defers scenery
      // any more (race-boot.ts `deferScenery` keys on introMode — the whole
      // dressed scene compiles under the loading screen), so `sceneryWarmed()`
      // is true by construction here and this passes through on the first
      // done-frame — the countdown arms immediately. The capped hold stays as
      // the guard for any future path that plays a cinematic with a deferred
      // warm still streaming. Only reachable when a cinematic actually played:
      // intro mode 'off' (multiplayer, `?skipintro=1`, user setting)
      // constructs the director already done, so `introArmed` starts true and
      // this branch — hold included — never runs there.
      if (introHoldStartedAt === null) {
        introHoldStartedAt = performance.now()
        teardownIntroSkipUi()
        raceIntroUi?.hide()
      }
      const warmDone = sceneryWarmed?.() ?? true
      if (warmDone || performance.now() - introHoldStartedAt >= SCENERY_WARM_HOLD_CAP_MS) {
        raceHud.armCountdown()
        introArmed = true
      }
    }

    // Multiplayer synchronized start — see MP_START_FAILSAFE_MS above.
    if (!mpStartArmed) {
      const barrier = multiplayer.raceStartBarrier()
      if (barrier.loadedAt === null && net?.ready) {
        multiplayer.markRaceLoaded()
        raceHud.setHoldBanner('WAITING FOR RIDERS…')
      }
      const timedOut = performance.now() - mpBootedAt > MP_START_FAILSAFE_MS
      const legacyRelay = net?.ready === true && !barrier.supported
      if (barrier.goAt !== null || legacyRelay || timedOut) {
        if (timedOut && barrier.goAt === null && !legacyRelay) {
          console.warn('[net] start-barrier timeout — arming countdown locally')
        }
        raceHud.armCountdown()
        mpStartArmed = true
      }
    }

    let lastLookMagnitude = 0
    const rbHandle = RBHandleStore.get(playerEid)
    const hover = HoverStateStore.get(playerEid)
    if (rbHandle && hover) {
      const playerRb = phys.world.getRigidBody(rbHandle.handle)
      if (playerRb) {
        const v = playerRb.linvel()
        // Camera + direction arrow + HUD follow the player's interpolated
        // render pose (TransformStore was smoothed by
        // `interpolateRenderTransforms` above) so they share the bike's
        // render clock — no camera-vs-bike shimmer. Velocity stays from the
        // rigid body; it needs no interpolation.
        const rt = TransformStore.get(playerEid)
        if (rt) {
          tmpPos.set(rt.x, rt.y, rt.z)
          tmpQuat.set(rt.qx, rt.qy, rt.qz, rt.qw)
        } else {
          const t = playerRb.translation()
          const q = playerRb.rotation()
          tmpPos.set(t.x, t.y, t.z)
          tmpQuat.set(q.x, q.y, q.z, q.w)
        }
        if (!introActive && !sharkOwnsCamera) {
          // Chase camera + camera-look only while neither the intro nor the
          // shark death-cam is owning the camera. Letting them run during a
          // cutscene would lerp the chase pose against the director's pose
          // every frame and produce a fight; suppressing them keeps the
          // cinematic shots clean.
          const look = tickCameraLook(dt)
          lastLookMagnitude = Math.abs(look.yaw) + Math.abs(look.pitch)
          chase.setOrbit(look.yaw, look.pitch)
          chase.tick(tmpPos, tmpQuat, dt)
        }
        // Pump FX overlays — FOV punch + screen shake. Must run after
        // `chase.tick` so the shake offset doesn't get baked into the
        // chase camera's interpolated position before it's read.
        pumpFx.tick(dt)
        // Dev/test posed-camera override (screenshot harness). Applied
        // last so it wins over the chase pipeline + pump shake, giving a
        // fixed pose for framing concept-art beats. Null in normal play.
        const camPose = getCameraPoseOverride()
        if (camPose) {
          camera.position.set(camPose.pos.x, camPose.pos.y, camPose.pos.z)
          camera.lookAt(camPose.target.x, camPose.target.y, camPose.target.z)
        }
        state.playerSnapshot = {
          eid: playerEid,
          position: { x: tmpPos.x, y: tmpPos.y, z: tmpPos.z },
          velocity: { x: v.x, y: v.y, z: v.z },
          groundDistance: hover.groundDistance,
          isGrounded: hover.isGrounded,
          speed: vecHorizontalLength({ x: v.x, y: 0, z: v.z }),
        }
      }
    }

    // Audio dispatch — runs once per render frame, after physics.
    // Continuous engine + wind layers are driven by the player's speed.
    audio.tickEngine(state.playerSnapshot?.speed ?? 0)

    // Anti-grav HUD + camera follow. AntiGravOverride.weight is already
    // smoothed by the resolver; we just multiply by the player's
    // intensity scalar (full/reduced/off) and feed the result to both
    // surfaces. The HUD widget ignores the intensity scalar (motion-
    // sickness players still need the affordance signal); only the
    // camera follow opts out at intensity=off.
    let inAntiGravForTutorial = false
    {
      const override = AntiGravOverrideStore.get(playerEid)
      const w = override?.active ? override.weight : 0
      inAntiGravForTutorial = override?.active === true && w > 0.05
      antiGravHud.setWeight(w)
      const scalar = ANTI_GRAV_CAMERA_SCALAR[playerSettings.antiGravCameraIntensity]
      chase.setAntiGravFollow(w * scalar)
    }

    // Drift-roll: bank the chase camera into the corner while drifting.
    // Magnitude scales with the highest tier reached this drift so the
    // visual progression matches the audible payoff hierarchy
    // (blue MT → orange SMT → purple UMT). Gated by
    // `playerSettings.driftIntensity`:
    //   - full:   ±5° at tier 1, ±7° at tier 2, ±9° at tier 3
    //   - subtle: half magnitude — for motion-sensitive players who
    //             still want the directional cue
    //   - off:    zero — the mechanic still applies but no camera tell
    //
    // Same DriftState read also drives the HUD tier badge + the
    // continuous skid-audio layer + the one-shot release whoosh below.
    {
      const drift = DriftStateStore.get(playerEid)
      const intensity = playerSettings.driftIntensity
      let rollRad = 0
      if (drift && drift.driftDir !== 0 && intensity !== 'off') {
        const baseDeg = drift.highestTier >= 3 ? 9 : drift.highestTier >= 2 ? 7 : 5
        const baseRad = (baseDeg * Math.PI) / 180
        const scalar = intensity === 'subtle' ? 0.5 : 1.0
        // Sign convention: driftDir=-1 (left drift) → positive roll
        // around the camera's local Z, which rotates the horizon
        // clockwise from the player's perspective and reads as
        // "leaning left into the corner."
        rollRad = -drift.driftDir * baseRad * scalar
      }
      chase.setDriftRoll(rollRad)
      driftTierHud.update(drift?.driftDir ?? 0, drift?.highestTier ?? 0)

      // Drift skid loop — continuous tyre-scrape level. Intensity =
      // speed fraction while drifting + grounded; zero otherwise so
      // the loop fades out on cancel (the audio engine smooths the
      // ramp). Suppressed when `driftIntensity` is `off`, halved on
      // `subtle` — matches the visual layer's opt-out semantics.
      const driftAudioOn =
        !!drift &&
        drift.driftDir !== 0 &&
        intensity !== 'off' &&
        state.playerSnapshot?.isGrounded === true
      if (driftAudioOn) {
        const speed = state.playerSnapshot?.speed ?? 0
        const skidIntensity = Math.min(1, speed / 28)
        audio.driftSkid(intensity === 'subtle' ? skidIntensity * 0.5 : skidIntensity)
      } else {
        audio.driftSkid(0)
      }

      // One-shot whoosh on the tick a drift release fires a boost.
      // `releasedThisTick` is the sim-side edge flag set by
      // driftSystem; tier dictates pitch/brightness (MT/SMT/UMT).
      if (drift?.releasedThisTick && drift.releasedTier > 0) {
        if (intensity !== 'off') {
          audio.driftBoost(drift.releasedTier)
          // Speed-lines whoosh scaled by tier (MT→SMT→UMT = 1/3→1).
          pumpFx.speedLines(drift.releasedTier / 3)
        }
        // Tutorial: the DRIFT beat clears on the first charged
        // release. Signalled regardless of `driftIntensity` — the
        // beat is about the mechanic, not the FX, and a player who
        // turned visuals off should still graduate the beat.
        tutorialDirector?.notifyDrift(drift.releasedTier)
      }
    }

    // Tutorial director — advance the script. The "LOOK AROUND" beat
    // clears once either the mouse drag or the gamepad right-stick
    // moves the camera-look state away from neutral; we treat any
    // non-trivial yaw/pitch magnitude as a "touch". Held while paused
    // (the director pauses with the loop) so the beat timer doesn't
    // tick away behind the pause menu.
    if (tutorialDirector && tutorialHud && !control.isPausedForMenu()) {
      const intent = ControlIntentStore.get(playerEid)
      if (lastLookMagnitude > 0.05) tutorialDirector.notifyOrbitTouch()
      tutorialDirector.tick(dt, {
        playerSpeed: state.playerSnapshot?.speed ?? 0,
        throttle: Math.max(0, intent?.throttle ?? 0),
        inAntiGrav: inAntiGravForTutorial,
      })
    }

    // Trick-boost signal — under the airborne-gated model the sim has
    // already decided whether this tick fires a credible trick (see
    // `trickHopSystem`). The render-side wave-pump observer is now a
    // thin shim that translates the sim's `trickFiredThisTick` flag
    // into a `PumpEvent`. Skipped while auto-play is on (the auto-
    // pilot doesn't get the player reward). When a pump event lands:
    //   (a) flash HUD / play audio,
    //   (b) trigger the over-the-top FX (FOV punch + speedlines +
    //       camera shake + exhaust burst),
    //   (c) apply a forward impulse,
    //   (d) charge the boost meter (~3 tricks = full meter), and
    //   (e) start the visual spin on TrickState.
    // Flatground small hops (where the sim never opened the window)
    // never fire here — the lift impulse comes from trickHopSystem
    // but none of the trick FX runs.
    // Launch/landing verdicts — the wave-mastery loop's announce step.
    // Sim already graded the edge + paid the meter (launchGradeSystem);
    // here we flash the chyron, chime a clean landing, and let the
    // tutorial's LAUNCH / LAND beats graduate. Skipped on autopilot —
    // the pilot isn't the player.
    if (!control.isAutoPlay()) {
      const grade = LaunchGradeStore.get(playerEid)
      if (grade?.firedThisTick) {
        launchGradeHud.flash(grade.firedKind, grade.firedQuality)
        if (grade.firedKind === 'landing') {
          tutorialDirector?.notifyLanding(grade.firedQuality)
          // Audio receipt on the landing only (takeoff already has
          // wind + engine); clean landings get the perfect sparkle.
          if (playerSettings.wavePumpIntensity !== 'off' && grade.firedQuality >= 0.4) {
            audio.wavePump(grade.firedQuality, grade.firedQuality >= 0.72)
          }
        } else {
          tutorialDirector?.notifyLaunch(grade.firedQuality)
        }
      }
    }

    if (!control.isAutoPlay() && state.playerSnapshot) {
      const hoverState = HoverStateStore.get(playerEid)
      const intent = ControlIntentStore.get(playerEid)
      const stats = BikeStatsStore.get(playerEid)
      if (hoverState && intent && stats) {
        const trickStateNow = TrickStateStore.get(playerEid)
        const pump = wavePumpObserver.detect(now, {
          trickFiredThisTick: trickStateNow?.trickFiredThisTick === true,
          trickFiredStrength: trickStateNow?.trickFiredStrength ?? 0,
          trickFiredDirection: trickStateNow?.trickFiredDirection ?? 0,
        })
        if (pump) {
          wavePumpHud.pump(pump.strength, true)
          if (playerSettings.wavePumpIntensity !== 'off') {
            audio.wavePump(pump.strength, true)
          }
          tutorialDirector?.notifyPumpEvent()
          applyPumpImpulse(phys, playerEid, stats, pump.strength, 'trick')
          triggerPumpBurst(playerEid, pump.strength, true)
          pumpFx.fire(pump.strength, true)
          // Visual spin — direction picked from the player's input
          // state at press time:
          //   - L1 + R1 both held → barrel roll (Z-axis)
          //   - Stick forward / back (pitch ≠ 0) → front / back flip (X-axis)
          //   - Otherwise → yaw (Y-axis), direction from whichever
          //     trick button fired (L1 = left yaw, R1 = right yaw).
          //
          // Steer input is intentionally ignored as a trick modifier:
          // the player turns the stick to drive, so any "trick +
          // steer" combo was incidental and produced unwanted barrel
          // rolls during normal racing. Left/right intent for tricks
          // is fully expressed by the button choice.
          //
          // `intent.pitch` (left-stick Y on gamepad, E/Q on keyboard)
          // is the directional signal for flip — not `intent.throttle`,
          // which is held continuously while driving and would make
          // every trick a back-flip the moment RT is down.
          //
          // Only one axis component is ever non-zero per trick —
          // render normalises and rotates around it.
          const trickState = TrickStateStore.get(playerEid)
          if (trickState) {
            const DIRECTION_THRESHOLD = 0.3
            const pitchMag = Math.abs(intent.pitch)
            const bothButtons = intent.trickLeft && intent.trickRight
            let ax = 0
            let ay = 0
            let az = 0
            if (bothButtons) {
              // Barrel roll — default to "left" (top of bike rolls
              // left from chase view).
              az = +1
            } else if (pitchMag >= DIRECTION_THRESHOLD) {
              // Flip on X-axis. Sign convention: +X-axis rotation
              // with positive angle moves +Y (top of bike) toward
              // +Z (forward) = front flip. So stick-forward
              // (pitch < 0 = nose-down intent) → +1 = front flip;
              // stick-back (pitch > 0) → -1 = back flip.
              ax = intent.pitch < 0 ? +1 : -1
            } else {
              // Yaw direction follows the STEER stick — right steer
              // (+1) spins clockwise (+Y rotation, bike nose sweeps
              // to player's right), left steer spins CCW. Player
              // intent: "I'm leaning into a right-side trick, the
              // bike should spin right". Falls back to the button
              // label only when the stick is in deadzone — a press
              // with no steer commit defaults to that button's side.
              //
              // Numerical anchor: `quat.setFromAxisAngle(+Y, +angle)`
              // takes bike-fwd +Z → +X (verified). Chase cam looks
              // toward +Z with world +X as screen-right, so ay=+1
              // sweeps the nose visibly right. CW = right = ay=+1.
              if (Math.abs(intent.steer) >= DIRECTION_THRESHOLD) {
                ay = intent.steer > 0 ? +1 : -1
              } else {
                ay = pump.direction === 'left' ? -1 : +1
              }
            }
            trickState.spinPhase = 1
            trickState.spinAxisX = ax
            trickState.spinAxisY = ay
            trickState.spinAxisZ = az
            trickState.spinDurationSec = 0.6
          }
          // Fill the boost meter — two credible tricks ⇒ a full bar.
          // Most of the speed payoff from tricking now flows through
          // the meter rather than the immediate forward kick.
          chargeBoostMeter(playerEid, 0.5)
          state.pumpEventCount = (state.pumpEventCount ?? 0) + 1
          state.lastPumpStrength = pump.strength
          state.lastPumpAt = now
        }

        // Trick-ready prompt — teach the player which jumps are
        // trickable by sight. Under the airborne-gated model the
        // prompt lights up in two cases:
        //   1. An airborne trick window is currently open — the bike
        //      is in the qualifying arc of a real takeoff. Press
        //      anytime before landing to fire.
        //   2. The bike is climbing toward what looks like a
        //      qualifying takeoff — recent `vyPeak ≥ MIN_VY_PEAK`,
        //      speed/throttle gates pass, not in a hop-lockout. This
        //      is the look-ahead case: the prompt fires on the
        //      upslope so the player can commit early; the
        //      pre-input buffer holds the press through to takeoff.
        // The prompt suppresses itself for the rest of the airtime
        // once a trick has fired (the wave-pump chyron already
        // telegraphs the reward).
        const speedFrac =
          stats.topSpeed > 0
            ? Math.max(0, Math.min(1, state.playerSnapshot.speed / stats.topSpeed))
            : 0
        const speedOK = speedFrac >= MIN_SPEED_FRAC
        const throttleOK = Math.max(0, intent.throttle) >= MIN_THROTTLE
        const windowOpen =
          trickStateNow?.trickWindowOpen === true && trickStateNow?.trickFiredThisAirborne !== true
        const climbContext =
          (trickStateNow?.vyPeak ?? 0) >= MIN_VY_PEAK &&
          trickStateNow?.hopLockoutActive !== true &&
          hoverState.isGrounded
        trickPromptHud.setReady(windowOpen || (climbContext && speedOK && throttleOK))
      }
    } else {
      // Auto-play OR no player snapshot — keep the prompt hidden.
      trickPromptHud.setReady(false)
    }

    // Boost-meter FX — the meter system flips `active` on a fresh
    // press while charged; we mirror that transition on the render
    // side: on activation, fire the same FX vocabulary as a credible
    // trick (FOV punch + speedlines + audio + exhaust burst) plus a
    // full-strength forward impulse for the "kick" feel. While active,
    // the sustained-shake mode runs continuously over the chase cam.
    // Deactivation just turns the shake off; the FOV / speedline
    // animations finish their own one-shot lifetimes.
    //
    // Rejection flash: if the player presses boost (rising edge) but
    // the meter didn't engage (insufficient charge), pulse the HUD
    // red so they get a clear "tried, can't yet" cue instead of
    // silent unresponsiveness.
    if (!control.isAutoPlay()) {
      const meter = BoostMeterStore.get(playerEid)
      const stats = BikeStatsStore.get(playerEid)
      const playerIntent = ControlIntentStore.get(playerEid)
      const prevActive = state.boostMeterActive ?? false
      const prevBoostDown = state.boostBtnDown ?? false
      const boostDown = playerIntent?.boost === true
      const boostEdge = boostDown && !prevBoostDown
      const nowActive = meter?.active === true
      if (meter && stats) {
        if (nowActive && !prevActive) {
          wavePumpHud.pump(1, true)
          if (playerSettings.wavePumpIntensity !== 'off') {
            audio.wavePump(1, true)
          }
          applyPumpImpulse(phys, playerEid, stats, 1, 'boost')
          triggerPumpBurst(playerEid, 1, true)
          pumpFx.fire(1, true)
        } else if (boostEdge && !nowActive) {
          // Player pressed boost but the meter didn't engage —
          // either no charge at all or below the activation
          // threshold. Flash the HUD red so the rejection reads.
          boostMeterHud.flashRejected()
        }

        // Boost-pad feel — the sim applies the pad's speed multiplier as a
        // BoostEffect (boost-pad.ts), but that alone is a silent nudge. To
        // make a pad read "as if holding boost," mirror the held-boost FX
        // vocabulary on the render side: a one-shot FOV/speedline/audio/
        // exhaust punch + forward kick when the bike rolls onto a pad, and
        // the sustained chase-cam shake the whole time it's on one. The
        // earned boost meter is deliberately untouched — pads are free.
        const padHandle = RBHandleStore.get(playerEid)
        const padPos = padHandle
          ? phys.world.getRigidBody(padHandle.handle)?.translation()
          : undefined
        const onPad = padPos ? track.boostPads.some((p) => isOverBoostPad(padPos, p)) : false
        if (onPad && !(state.onBoostPad ?? false)) {
          wavePumpHud.pump(1, true)
          if (playerSettings.wavePumpIntensity !== 'off') {
            audio.wavePump(1, true)
          }
          applyPumpImpulse(phys, playerEid, stats, 1, 'boost')
          triggerPumpBurst(playerEid, 1, true)
          pumpFx.fire(1, true)
        }
        state.onBoostPad = onPad

        pumpFx.setSustainedShake(nowActive || onPad)
        boostMeterHud.update(meter.charge, nowActive)
        state.boostMeterActive = nowActive
        state.boostMeterCharge = meter.charge
      }
      state.boostBtnDown = boostDown
    }

    // Tuck meter — surface the otherwise-invisible `tuckFactor` curve so
    // the player can tell a missed sweet spot from a mechanic that isn't
    // firing. Reads the same signals the tuck physics does: nose-down
    // lean (`max(-pitch, 0)`) + the grounded gate. Player-only; hidden
    // during auto-play and when the settings toggle is off.
    if (!playerSettings.tuckMeter || control.isAutoPlay()) {
      tuckHud.hide()
    } else {
      const tuckIntent = ControlIntentStore.get(playerEid)
      const tuckStats = BikeStatsStore.get(playerEid)
      const tuckHover = HoverStateStore.get(playerEid)
      const grounded = tuckHover?.isGrounded === true
      if (tuckIntent && tuckStats) {
        const lean = Math.max(0, -tuckIntent.pitch)
        // Sweet spot slides with the slope under / ahead of the bike — the
        // same signed forward slope the physics grades tuck off. 0 while
        // airborne, so the notch rests at the flat-ground sweet spot.
        const sweet = slopeAwareSweetSpot(-Math.atan(tuckHover?.forwardSlope ?? 0))
        const factor = grounded ? tuckFactor(lean, sweet) : 0
        const capBonusPct = (tuckStats.tuckSpeedBoost - 1) * factor * 100
        tuckHud.update(lean, factor, capBonusPct, grounded && lean > 0.05, sweet)
      } else {
        tuckHud.hide()
      }
    }

    // Player slot transitions: collected (null → X), or fired with a
    // non-spawning effect (boost / shield). Mine and missile fires also
    // empty the slot, but those sounds come from the entity-spawn path
    // below — handling them here would double-fire on the player's
    // firing tick.
    const currentPlayerHeld = getHeldPickup(playerEid)
    if (prevPlayerHeld === null && currentPlayerHeld !== null) {
      audio.pickupCollect()
    } else if (
      prevPlayerHeld !== null &&
      currentPlayerHeld === null &&
      (prevPlayerHeld === 'boost' || prevPlayerHeld === 'shield')
    ) {
      audio.pickupFire(prevPlayerHeld)
    }
    prevPlayerHeld = currentPlayerHeld

    // Combat entity spawns: any new mine/missile/explosion in the world
    // gets a sound (so AI weapons are audible too, not just the player's).
    const mineCount = query(sim, [MineTag]).length
    if (mineCount > prevMineCount) audio.pickupFire('mine')
    prevMineCount = mineCount
    const missileCount = query(sim, [MissileTag]).length
    if (missileCount > prevMissileCount) audio.pickupFire('missile')
    prevMissileCount = missileCount
    const explosionCount = query(sim, [ExplosionTag]).length
    if (explosionCount > prevExplosionCount) audio.explosion()
    prevExplosionCount = explosionCount

    const racer = RacerStore.get(playerEid)
    if (racer) {
      state.raceSnapshot = {
        lap: racer.lap,
        lapsToFinish: track.lapsToFinish,
        nextCheckpoint: racer.nextCheckpoint,
        checkpointsCrossed: racer.checkpointsCrossed,
        totalCheckpoints: track.checkpoints.length,
        finished: racer.finished,
        raceTime: racer.raceTime,
      }
    }

    // Time Trial ghost — drive its Transform from the saved best-lap
    // replay player. Ticks the ghost relative to the player's current
    // lap time so the ghost is a meaningful pacing reference; seeks
    // back to t=0 when the player crosses the start/finish line. Held
    // at start pose while the race is locked (pre-countdown).
    if (ghostRunner) {
      const racerForGhost = RacerStore.get(playerEid)
      const lapTime =
        racerForGhost && racerForGhost.checkpointsCrossed >= 1
          ? racerForGhost.raceTime - lapState.lapStartRaceTime
          : 0
      ghostRunner.tick(dt, lapTime, !raceHud.isLocked())
    }

    waterMesh.tick(gatherBikeImpacts(), { x: camera.position.x, z: camera.position.z })
    // Per-lap weather progression — lerps cloudiness/sun/Beaufort
    // toward the next-lap target over `transitionSeconds`. No-op
    // when the track ships no `lapWeather` schedule, so the cost is
    // a single early-out per frame for non-storm tracks.
    lapWeather.step(dt)
    // Day-night cycle + fog/hemi palette + PMREM env-map bake. The sky
    // system owns the directional-sun follow (shadow-camera centred on the
    // bike) and the water shader's sun-direction uniform. Time is the
    // deterministic wave-field clock so replays and rollbacks line up.
    sky.tick(waveField.time, dt, {
      x: state.playerSnapshot?.position.x ?? 0,
      z: state.playerSnapshot?.position.z ?? 0,
    })
    // Lava-river material's flow-shimmer animation clock. Render-only;
    // uses the deterministic wave-field clock so replays match. No-op
    // for tracks that don't ship a lava strip — the uniform is shared
    // module-scope across the process, and `updateLavaTime` is one
    // assignment regardless of how many lava materials exist.
    updateLavaTime(waveField.time)
    // Foliage sway clock — same deterministic wave-field clock as the
    // water/lava materials so replays match. Materials patched by
    // ``applyFoliageSway`` (palms, banners, scatter-zone foliage) sample
    // ``uSwayTime`` once per draw; this single uniform write covers all.
    updateSwayTime(waveField.time)
    // Keep the distant horizon silhouette wrapped around the chase camera
    // so the player never appears to outrun it. Tracks the camera (not the
    // bike) so look-back / spectator pans don't shift the horizon.
    horizonRing.tick({ x: camera.position.x, z: camera.position.z })
    // Bob any floating checkpoint gates onto the (now-advanced) wave
    // surface. No-op unless the track set `floatGates`.
    trackVisuals.tick(waveField)
    // Camera water clamp + underwater-fog blend share one surface sample.
    const camWaterY = sampleHeight(waveField, camera.position.x, camera.position.z)
    // Keep the chase camera above the surface — the bike rides over crests via
    // the wave-tracking buoyancy (hover.ts), and this is the visual safety net
    // so a tall crest behind the bike can't punch the view underwater.
    // CAMERA_WATER_CLEARANCE keeps the lens just above the waterline without
    // floating obviously high.
    const minCamY = camWaterY + CAMERA_WATER_CLEARANCE
    if (camera.position.y < minCamY) camera.position.y = minCamY
    updateUnderwaterFog(scene, camera.position.y, camWaterY)
    bikeRender()
    riderRender()
    pickupRender(dt)
    combatRender(dt)
    fxTick(dt)
    waveRiderRender?.render()
    animatedProps?.update(dt)
    particleTick(dt)
    // Landmark pendulum animation — render-only, driven off wall-clock
    // seconds since boot so menu pauses don't freeze the visual rhythm.
    // `now` is the rAF timestamp; the system reads
    // `playerSettings.animatedLandmarks` internally and pins arms to
    // rest when off.
    landmarkTick(now / 1000)
    physicsDebug.tick()
    hoverDebug.tick(sim)
    // Sim-surface dot grid (`?wavedots=1`) — centre on the player so the dots
    // bracket the bike; fall back to the camera before the player transform
    // is first written.
    if (simSurfaceProbe) {
      const pt = TransformStore.get(playerEid)
      if (pt) simSurfaceProbe.tick(waveField, pt.x, pt.z)
      else simSurfaceProbe.tick(waveField, camera.position.x, camera.position.z)
    }

    // Race HUD — countdown banner, race/lap timers, gap toast, minimap.
    // Always ticked: while locked, the timers stay at zero and the
    // banner counts 3..2..1..GO.
    // `standings` is also reused by the FPS-sampled status line below so
    // we only call computeStandings once per render frame.
    const standings = computeStandings(sim, track)
    const meStanding = standings.find((s) => s.eid === playerEid)
    {
      const racerForHud = RacerStore.get(playerEid)

      hudBikes.length = 0
      for (const s of standings) {
        // Interpolated render pose (smoothed above) — keeps minimap dots on
        // the same clock as the bikes and skips a per-bike WASM body read.
        const t = TransformStore.get(s.eid)
        if (!t) continue
        let dot = hudBikePool[hudBikes.length]
        if (!dot) {
          dot = { x: 0, z: 0, isPlayer: false, isLeader: false }
          hudBikePool.push(dot)
        }
        dot.x = t.x
        dot.z = t.z
        dot.isPlayer = s.eid === playerEid
        dot.isLeader = s.position === 1 && s.eid !== playerEid
        hudBikes.push(dot)
      }

      const raceTimeForHud = racerForHud?.raceTime ?? 0
      const currentLap =
        racerForHud && racerForHud.checkpointsCrossed >= 1
          ? raceTimeForHud - lapState.lapStartRaceTime
          : 0

      raceHud.tick({
        dt,
        raceTime: raceTimeForHud,
        lap: racerForHud?.lap ?? 1,
        lapsToFinish: track.lapsToFinish,
        finished: racerForHud?.finished ?? false,
        currentLapTime: currentLap,
        lastLapTime: lapState.lastLapTime,
        bestLapTime: lapState.bestLapThisRace ?? lapState.bestLapAllTime,
        bikes: hudBikes,
        playerNextCheckpoint: racerForHud?.nextCheckpoint ?? 0,
        playerPosition: meStanding?.position ?? 1,
        totalRacers: standings.length,
      })
    }

    // Direction arrow points the player to the next checkpoint.
    const racerNow = RacerStore.get(playerEid)
    if (racerNow && !racerNow.finished) {
      const nextCp = track.checkpoints[racerNow.nextCheckpoint]
      if (nextCp) {
        tmpTarget.set(nextCp.position.x, nextCp.position.y, nextCp.position.z)
        dirArrow.tick(camera, tmpPos, tmpTarget, dt)
      } else {
        dirArrow.tick(camera, tmpPos, null, dt)
      }
    } else {
      dirArrow.tick(camera, tmpPos, null, dt)
    }

    // B3 racing-line flow ribbon — the painted wayfinding line on the water.
    // Driven by the deterministic wave-field clock (so freeze-water freezes the
    // flow) + the player's render XZ (the lead fade + off-line warm-shift).
    // Self-hides while its master flag is off, so this is a cheap early-out
    // until a playtest enables it.
    racingLineRibbon?.tick(waveField.time, tmpPos.x, tmpPos.z)

    // Step 8 — frame-rate cap. When `playerSettings.framerateCap > 0`
    // we skip the GPU render + frame counter on rAF ticks that arrive
    // sooner than the cap allows. The fixed-step sim accumulator above
    // already ran; only the render half drops. This keeps determinism
    // independent of the cap and is the Steam Deck path's hot knob
    // (60 fps cap = ~½ the GPU power of uncapped on a 90 Hz panel).
    const renderThisFrame = shouldRenderFrame(now, lastRenderedAt, playerSettings.framerateCap)
    if (renderThisFrame) {
      renderFrame(scene, camera)
      // GPU-time profiler tick — after the render so this frame's timestamps
      // are queued. No-op unless `?gpuprofile=1` enabled it; never throws.
      gpuProfiler.tick()
      lastRenderedAt = now
      state.frame += 1
      framesThisSecond += 1
    }
    if (now - fpsAccumStart >= 500) {
      state.fps = (framesThisSecond * 1000) / (now - fpsAccumStart)
      framesThisSecond = 0
      fpsAccumStart = now
      if (hud.fpsEl) hud.fpsEl.textContent = `fps: ${state.fps.toFixed(0)}`
      // Step 8 — refresh the perf overlay on the same cadence as the FPS
      // pill. We only pay the percentile-sort + renderer.info read when
      // the overlay is actually showing; the cached stats outlive the
      // tick so the row text doesn't churn between visible refreshes.
      if (perfHud.isVisible()) {
        lastPerfStats = perfRecorder.stats()
        perfHud.tick(lastPerfStats, rendererInfo)
      }
      if (hud.audioEl)
        hud.audioEl.textContent = `audio: ${audio.isMuted() ? 'muted (M)' : 'on (M)'}`
      if (hud.inputEl) {
        const i = state.intent
        const speed = state.playerSnapshot?.speed ?? 0
        const held = getHeldPickup(playerEid) ?? '—'
        hud.inputEl.textContent = `${inputSourceLabel()} | thr ${i.throttle.toFixed(2)} steer ${i.steer.toFixed(2)} | ${speed.toFixed(1)} m/s | item: ${held}`
      }
      if (hud.raceEl && state.raceSnapshot) {
        const rs = state.raceSnapshot
        const status = rs.finished
          ? 'FINISHED'
          : `cp ${rs.nextCheckpoint + 1}/${rs.totalCheckpoints}`
        const auto = control.isAutoPlay() ? ' [AUTO]' : ''
        hud.raceEl.textContent = `lap ${rs.lap}/${rs.lapsToFinish} | pos ${meStanding?.position ?? '?'}/${standings.length} | ${status} | ${rs.raceTime.toFixed(1)}s${auto}`

        if (rs.finished && !finishShown && hud.finishEl) {
          finishShown = true
          showFinishScreen({
            rs,
            standings,
            meStandingPosition: meStanding?.position ?? null,
            playerEid,
            aiEids,
            hud,
            track,
            trackId,
            manifest,
            playerVariant,
            roomId,
            cupId,
            recorder,
            bestLapThisRace: lapState.bestLapThisRace,
            bestLapAllTime: lapState.bestLapAllTime,
            timeTrialMode: timeTrialMode === true,
            forfeited: RacerStore.get(playerEid)?.forfeited ?? false,
          })
          onFinish()
        }
      }
    }
    requestAnimationFrame(frame)
  }

  requestAnimationFrame(frame)
}

interface FinishOpts {
  rs: RaceSnapshot
  /** Full finishing order at the moment the player crossed the line —
   *  drives the MK8-style per-race results board (all racers ranked). */
  standings: ReadonlyArray<{
    eid: number
    position: number
    finished: boolean
    raceTime: number
  }>
  meStandingPosition: number | null
  /** Player + AI entity ids, used to map each standing back to its stable
   *  cup-roster identity (name + livery) for the results board + recording. */
  playerEid: number
  aiEids: number[]
  hud: GameLoopHud
  track: Track
  trackId: string
  manifest: AssetManifest
  playerVariant: BikeVariant
  roomId: string | null
  cupId: string | null
  recorder: ReplayRecorder | null
  bestLapThisRace: number | null
  bestLapAllTime: number | null
  timeTrialMode: boolean
  /** Player left the course (crossed the OOB soft wall). Records a DNF and
   *  skips ghost / leaderboard saves — the run no longer counts. */
  forfeited: boolean
}

function showFinishScreen(opts: FinishOpts): void {
  const {
    rs,
    standings,
    meStandingPosition,
    playerEid,
    aiEids,
    hud,
    track,
    trackId,
    manifest,
    playerVariant,
    roomId,
    cupId,
    recorder,
    bestLapThisRace,
    bestLapAllTime,
    timeTrialMode,
    forfeited,
  } = opts
  // A forfeited run is a DNF: no finish position, no ghost, no leaderboard.
  const creditedPosition = forfeited ? null : meStandingPosition

  // Map a racer entity back to its grid slot (0 = player, 1.. = AI in
  // spawn order) — the join key between the live standings and the cup's
  // stable roster.
  const slotForEid = (eid: number): number => (eid === playerEid ? 0 : aiEids.indexOf(eid) + 1)

  // Cup-mode book-keeping. Pull the live cup-progress (if any), record the
  // whole field's finish into it, and re-read so the post-finish NEXT/EXIT
  // routing knows whether more races remain.
  const cup = cupId !== null ? getCupProgressFor(cupId) : null
  let cupAfter = cup
  if (cup && cupId !== null) {
    const finishers: CupFinisher[] = standings.map((s) => {
      const isMe = s.eid === playerEid
      let racerTime: number | null
      if (isMe) racerTime = forfeited ? null : rs.raceTime
      else racerTime = s.finished ? s.raceTime : null
      return {
        slot: slotForEid(s.eid),
        // The player's credited position honours a forfeit (DNF); AI take
        // their standing at the moment the player crossed the line.
        position: isMe ? creditedPosition : s.position,
        raceTime: racerTime,
      }
    })
    cupAfter =
      recordCupRaceFinish({
        cupId,
        trackId,
        position: creditedPosition,
        totalRacers: standings.length,
        raceTime: rs.raceTime,
        finishers,
      }) ?? cup
  }
  const isLastCupRace = cupAfter !== null && nextCupTrackId(cupAfter) === null
  const isCupMode = cupAfter !== null

  // Full-field results board — MK8 / Jet Moto style. Every racer ranked,
  // the player highlighted, with points (cup) or finish time (single
  // race). Hidden in solo Time Trial.
  renderFinishResults({
    standings,
    playerEid,
    aiEids,
    playerVariant,
    trackId,
    cup: cupAfter,
    timeTrialMode,
  })
  hud.finishEl?.classList.add('show')
  const finishRibbon = document.getElementById('finish-ribbon')
  if (hud.finishPos) {
    // TT mode is solo — position is meaningless. Hide the row's value
    // when it's just "1st" against no one. Forfeit reads DNF.
    hud.finishPos.textContent = forfeited
      ? 'DNF'
      : timeTrialMode
        ? '—'
        : meStandingPosition !== null
          ? ordinal(meStandingPosition)
          : '—'
  }
  if (hud.finishTime) hud.finishTime.textContent = formatTime(rs.raceTime)
  const wonRace = !forfeited && meStandingPosition === 1
  if (hud.finishTitle) {
    hud.finishTitle.textContent = forfeited
      ? 'DNF'
      : timeTrialMode
        ? 'TIME TRIAL'
        : wonRace
          ? 'CHAMPION'
          : 'FINAL'
  }
  if (finishRibbon) {
    finishRibbon.textContent = forfeited
      ? 'OUT'
      : timeTrialMode
        ? 'CLOCK'
        : wonRace
          ? 'WINNER'
          : 'FINAL'
  }
  // Prefer the catalogue display name ("Mayday Bay") over the raw slug
  // carried in `track.name` ("sandbar"). Dev / procedural tracks aren't
  // in the ship catalogue → fall back to the raw name.
  const displayTrackName = trackDisplayName(trackId) ?? track.name
  if (hud.finishSub) {
    hud.finishSub.textContent = `${displayTrackName.toUpperCase()} · ${playerVariant.name.toUpperCase()}`
  }
  // Stash a last-race summary for the menu's title-screen recap card.
  // Stored in sessionStorage so it survives the navigation to `?back=1`
  // but doesn't outlive the tab.
  try {
    sessionStorage.setItem(
      'hover-last-race',
      JSON.stringify({
        trackId,
        trackName: displayTrackName,
        bikeId: playerVariant.id,
        bikeName: playerVariant.name,
        position: creditedPosition,
        totalRacers: standings.length,
        time: rs.raceTime,
        bestLap: bestLapThisRace,
        wonRace,
        forfeited,
        finishedAt: Date.now(),
      }),
    )
  } catch {
    /* sessionStorage may be unavailable in privacy modes */
  }
  // Replay buttons. The recorder has been capturing throughout the race;
  // finalize it once, then offer both a one-click WATCH (sessionStorage
  // → ?replay=session navigation, reusing the existing replay-playback
  // boot path) and SAVE (download the .replay file). Hidden if no
  // recorder (replay-playback branch can't reach this code, but guard
  // anyway).
  const watchBtn = document.getElementById('finish-watch-replay') as HTMLButtonElement | null
  const saveBtn = document.getElementById('finish-save-replay') as HTMLButtonElement | null
  let newGhostSaved = false
  let ttBestLapForBoard: number | null = null
  if (recorder) {
    const replay = recorder.finalize({
      finishPosition: creditedPosition,
      finishTime: rs.raceTime,
      bestLap: bestLapThisRace,
    })

    // Time Trial — slice the player's best lap from the recording and
    // persist it as the new ghost iff it beats the stored ghost's
    // best lap (or there's no stored ghost yet). Single-lap looping
    // ghost matches Wave Race / F-Zero TT convention. The leaderboard
    // banner renderer below picks this up via `ttBestLapForBoard` and
    // drives the local-cache write + remote submit lifecycle.
    // A forfeited TT run never becomes a ghost or a submitted lap, even if
    // the raw lap was fast — you left the course.
    if (timeTrialMode && !forfeited) {
      const slice = sliceBestLap(replay, 0)
      if (slice) {
        const existing = getGhostBestLap({ trackId, bikeId: playerVariant.id })
        if (existing === null || slice.bestLap < existing) {
          newGhostSaved = setGhost({ trackId, bikeId: playerVariant.id }, slice.replay)
          if (newGhostSaved) ttBestLapForBoard = slice.bestLap
        }
      }
    }
    if (watchBtn) {
      watchBtn.style.display = 'inline-block'
      watchBtn.disabled = false
      watchBtn.onclick = () => {
        try {
          sessionStorage.setItem('hover-replay-pending', serializeReplay(replay))
        } catch {
          /* fall through — download instead */
          downloadReplay(replay)
          return
        }
        const url = new URL(window.location.href)
        url.search = ''
        url.searchParams.set('replay', 'session')
        window.location.assign(url.toString())
      }
    }
    if (saveBtn) {
      saveBtn.style.display = 'inline-block'
      saveBtn.disabled = false
      saveBtn.textContent = 'SAVE'
      saveBtn.onclick = () => {
        downloadReplay(replay)
        saveBtn.textContent = 'SAVED ✓'
        saveBtn.disabled = true
      }
    }
  }

  // Best-lap / ghost banner + leaderboard submission. The banner owns
  // its own lifecycle: it renders the race / PB / GHOST SAVED pills,
  // and on a TT PB drives the local-cache write + remote submit (with
  // optional inline handle prompt when no handle is set yet).
  if (hud.finishBest) {
    renderLeaderboardFinishBanner({
      host: hud.finishBest,
      trackId,
      bikeId: playerVariant.id,
      bestLapThisRace,
      bestLapAllTime,
      // Banner uses ttBestLapForBoard (the slice's bestLap — what we
      // just persisted to the ghost) when present; bestLapThisRace is
      // identical in practice but keep them threaded distinct so the
      // banner has a clean signal for "this PB is worth submitting".
      ttPbBestLap: timeTrialMode && newGhostSaved ? ttBestLapForBoard : null,
    })
  }
  // Cup mode — append a compact RACE N/M · XX PTS line to the finish
  // stat block so the player sees their championship progress without
  // having to wait for the cup-results overlay at the end.
  if (isCupMode && cupAfter) {
    appendCupStatRow(cupAfter)
  } else {
    removeCupStatRow()
  }

  // Action buttons: NEXT (default), RETRY, EXIT. Cup mode rewrites
  // NEXT to advance through the championship; the last race in a cup
  // pops the cup-results overlay instead of navigating. TT mode hides
  // NEXT entirely because the natural loop is "keep grinding the same
  // track for a better lap" — RETRY becomes the default focus.
  const nextBtn = document.getElementById('finish-next') as HTMLButtonElement | null
  const retryBtn = document.getElementById('finish-retry') as HTMLButtonElement | null
  const exitBtn = document.getElementById('finish-exit') as HTMLButtonElement | null
  if (nextBtn) {
    if (timeTrialMode) {
      nextBtn.style.display = 'none'
    } else {
      nextBtn.style.display = ''
      if (isCupMode && cupAfter !== null && !isLastCupRace) {
        // Mid-cup — advance to the next track in the lineup. Carry the
        // `?cup=<id>` param across so the next race also knows it's
        // part of the championship.
        const nextId = nextCupTrackId(cupAfter)
        const completed = Object.keys(cupAfter.results).length
        const total = cupAfter.races.length
        nextBtn.textContent = `NEXT RACE (${completed}/${total})`
        nextBtn.onclick = () => {
          if (!nextId) return
          window.location.assign(
            buildRaceUrl({ roomId, trackId: nextId, bikeId: playerVariant.id, cupId }),
          )
        }
      } else if (isCupMode && cupAfter !== null && isLastCupRace) {
        // Last race — hand off to the 3D podium ceremony (`?podium=1`),
        // which reads the completed cup from sessionStorage, plays the
        // trophy ceremony, and owns the BACK TO MENU + cup-clear path.
        nextBtn.textContent = 'PODIUM →'
        nextBtn.onclick = () => {
          const url = new URL(window.location.href)
          url.search = ''
          url.searchParams.set('podium', '1')
          window.location.assign(url.toString())
        }
      } else {
        // Single-race mode — original behaviour: rotate to the next
        // catalogue track.
        nextBtn.textContent = 'NEXT RACE'
        nextBtn.onclick = () => {
          const tracksList = buildTrackList(manifest.tracks)
          const nextId = nextTrackId(tracksList, trackId)
          window.location.assign(
            buildRaceUrl({ roomId, trackId: nextId, bikeId: playerVariant.id }),
          )
        }
      }
      nextBtn.focus({ preventScroll: true })
    }
  }
  if (retryBtn) {
    retryBtn.onclick = () => {
      // RETRY in cup mode restarts the current race without dropping
      // cup-progress — the points table preserves the finish that's
      // already been recorded; a better second attempt will overwrite
      // it (see recordCupRaceFinish's by-trackId match). TT mode rides
      // the same path with `tt=1` re-stamped on the URL.
      window.location.assign(
        buildRaceUrl({
          roomId,
          trackId,
          bikeId: playerVariant.id,
          cupId: cupId ?? null,
          timeTrial: timeTrialMode,
        }),
      )
    }
    if (timeTrialMode) retryBtn.focus({ preventScroll: true })
  }
  if (exitBtn) {
    exitBtn.onclick = () => {
      // Exit always abandons any in-progress cup. The sessionStorage
      // key is cleared so the title screen doesn't surface a stale
      // "resume cup" affordance later.
      clearCupProgress()
      const url = new URL(window.location.href)
      url.search = ''
      url.searchParams.set('back', '1')
      window.location.assign(url.toString())
    }
  }
}

type FinishStanding = { eid: number; position: number; finished: boolean; raceTime: number }

type FinishResultsCtx = {
  standings: ReadonlyArray<FinishStanding>
  playerEid: number
  aiEids: number[]
  playerVariant: BikeVariant
  trackId: string
  cup: CupProgress | null
}

/** Resolve a racer entity to its display identity for the results board.
 *  In cup mode the name comes from the championship's stable roster so it
 *  matches the standings + podium; single races fall back to the per-track
 *  AI call-sign. */
function identityForEid(
  eid: number,
  ctx: FinishResultsCtx,
): { slot: number; name: string; isPlayer: boolean; color: number } {
  if (eid === ctx.playerEid) {
    return { slot: 0, name: 'YOU', isPlayer: true, color: ctx.playerVariant.bodyColor }
  }
  const idx = ctx.aiEids.indexOf(eid)
  if (idx < 0) {
    // Not the player and not a known AI grid slot (e.g. a remote peer in a
    // future MP finish) — show a generic rival rather than mislabel slot 0.
    return { slot: -1, name: 'RIVAL', isPlayer: false, color: 0x88aabb }
  }
  const slot = idx + 1
  const rosterName = ctx.cup?.roster.find((r) => r.slot === slot)?.name
  return {
    slot,
    name: rosterName ?? aiCallSign(ctx.trackId, slot),
    isPlayer: false,
    color: variantForAiSlot(slot).bodyColor,
  }
}

function finishHexColor(c: number): string {
  return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`
}

function escapeFinishHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Populate the `#finish-results` board with the full finishing order —
 *  every racer ranked, the player highlighted, with points (cup) or
 *  finish time (single race). Hidden when there's no field to rank
 *  (solo Time Trial). */
function renderFinishResults(ctx: FinishResultsCtx & { timeTrialMode: boolean }): void {
  const host = document.getElementById('finish-results')
  if (!host) return
  if (ctx.timeTrialMode || ctx.standings.length < 2) {
    host.innerHTML = ''
    host.style.display = 'none'
    return
  }
  host.style.display = ''
  const isCup = ctx.cup !== null
  const ordered = [...ctx.standings].sort((a, b) => a.position - b.position)
  const rows: string[] = [
    `<div class="row head"><div class="pos">#</div><div>RACER</div><div class="val">${
      isCup ? 'PTS' : 'TIME'
    }</div></div>`,
  ]
  for (const s of ordered) {
    const id = identityForEid(s.eid, ctx)
    let value: string
    if (isCup) value = String(pointsForPosition(s.position))
    else if (s.finished) value = formatTime(s.raceTime)
    else value = '—'
    rows.push(
      `<div class="row${id.isPlayer ? ' me' : ''}">` +
        `<div class="pos">${ordinal(s.position)}</div>` +
        `<div class="who"><span class="dot" style="background:${finishHexColor(id.color)}"></span>${escapeFinishHtml(
          id.name,
        )}</div>` +
        `<div class="val">${value}</div>` +
        '</div>',
    )
  }
  host.innerHTML = rows.join('')
}

/** Inject (or replace) a compact "RACE N/M · XX PTS" row into the
 *  finish overlay's stat block so the player sees their cup standing
 *  alongside POSITION / RACE TIME / BEST LAP. The row is removed in
 *  single-race mode by the sibling `removeCupStatRow`. */
function appendCupStatRow(progress: CupProgress): void {
  const stat = document.querySelector<HTMLElement>('#finish .stat')
  if (!stat) return
  let row = stat.querySelector<HTMLElement>('.row[data-cup-row="1"]')
  if (!row) {
    row = document.createElement('div')
    row.className = 'row'
    row.dataset.cupRow = '1'
    stat.appendChild(row)
  }
  const completedRaces = Object.keys(progress.results).length
  const totalRaces = progress.races.length
  const total = totalCupPoints(progress)
  const last = progress.results[progress.races[completedRaces - 1] ?? '']
  const lastPoints = pointsForPosition(last?.position ?? null)
  row.innerHTML = `<span class="lbl">CUP STANDING</span><b>RACE ${completedRaces}/${totalRaces} · ${lastPoints} PTS THIS RACE · ${total} TOTAL</b>`
}

function removeCupStatRow(): void {
  const row = document.querySelector<HTMLElement>('#finish .stat .row[data-cup-row="1"]')
  row?.remove()
}

function buildRaceUrl(args: {
  roomId: string | null
  trackId: string
  bikeId: string
  cupId?: string | null
  timeTrial?: boolean
}): string {
  const url = new URL(window.location.href)
  url.search = ''
  if (args.roomId) url.searchParams.set('room', args.roomId)
  url.searchParams.set('race', '1')
  url.searchParams.set('track', args.trackId)
  url.searchParams.set('bike', args.bikeId)
  if (args.cupId) url.searchParams.set('cup', args.cupId)
  if (args.timeTrial) url.searchParams.set('tt', '1')
  return url.toString()
}
