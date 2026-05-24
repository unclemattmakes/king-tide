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
  type CupProgress,
  clearCupProgress,
  getCupProgressFor,
  nextCupTrackId,
  pointsForPosition,
  recordCupRaceFinish,
  totalCupPoints,
} from '@/engine/cup-progress'
import { type Intent, inputSourceLabel, readPlayerIntent } from '@/engine/input'
import { tickCameraLook } from '@/engine/input/camera-look'
import { buildTrackList, nextTrackId } from '@/engine/menus/catalog'
import {
  decodeInputFrameFrom,
  encodeInputFrameInto,
  INPUT_FRAME_WIRE_BYTES,
} from '@/engine/net/input-frame'
import { createPerfRecorder, type PerfStats } from '@/engine/perf-recorder'
import {
  ANTI_GRAV_CAMERA_SCALAR,
  markTutorialCompleted,
  playerSettings,
} from '@/engine/player-settings'
import { createAntiGravHud } from '@/engine/render/anti-grav-hud'
import { createBoostMeterHud } from '@/engine/render/boost-meter-hud'
import type { ChaseCamera } from '@/engine/render/camera'
import { showCupResultsOverlay } from '@/engine/render/cup-results-screen'
import type { DirectionArrow } from '@/engine/render/direction-arrow'
import { createDriftTierHud } from '@/engine/render/drift-tier-hud'
import { updateSwayTime, updateWind } from '@/engine/render/foliage-sway'
import { shouldRenderFrame } from '@/engine/render/frame-cap'
import type { HorizonRing } from '@/engine/render/horizon-ring'
import { updateLavaTime } from '@/engine/render/lava-river-material'
import { renderLeaderboardFinishBanner } from '@/engine/render/leaderboard-finish-banner'
import { createPerfHud, type RenderInfoLite } from '@/engine/render/perf-hud'
import { createPumpFx } from '@/engine/render/pump-fx'
import type { RaceHud } from '@/engine/render/race-hud'
import type { RaceIntro } from '@/engine/render/race-intro'
import type { RaceIntroUi } from '@/engine/render/race-intro-ui'
import { renderFrame } from '@/engine/render/renderer-service'
import type { SkySystem } from '@/engine/render/sky'
import type { TrackVisuals } from '@/engine/render/track-mesh'
import { createTrickPromptHud } from '@/engine/render/trick-prompt-hud'
import { createTutorialHud } from '@/engine/render/tutorial-hud'
import { type BikeImpact, updateUnderwaterFog } from '@/engine/render/water'
import { createWavePumpHud } from '@/engine/render/wave-pump-hud'
import type { WaveRiderRenderSystem } from '@/engine/render/wave-rider-render'
import { sliceBestLap } from '@/engine/replay/best-lap-slice'
import { serializeReplay } from '@/engine/replay/format'
import { getGhostBestLap, setGhost } from '@/engine/replay/ghost-state'
import type { ReplayRecorder } from '@/engine/replay/recorder'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { vecHorizontalLength } from '@/engine/sim/physics/vec'
import { sampleHeight, type WaveFieldState } from '@/engine/sim/water/wave-field'
import { createTutorialDirector } from '@/engine/tutorial/tutorial-director'
import { DEFAULT_TUTORIAL_SCRIPT } from '@/engine/tutorial/tutorial-script'
import {
  createWavePumpObserver,
  MIN_SPEED_FRAC,
  MIN_THROTTLE,
  MIN_VY_PEAK,
} from '@/engine/wave-pump-observer'
import type { AssetManifest } from '@/game/assets/manifest'
import type { BikeVariant } from '@/game/bikes/variants'
import {
  AntiGravOverrideStore,
  BikeStatsStore,
  BoostMeterStore,
  ControlIntentStore,
  DriftStateStore,
  HoverStateStore,
  RBHandleStore,
  TrickStateStore,
} from '@/game/components'
import { ExplosionTag, MineTag, MissileTag } from '@/game/components/combat'
import type { PickupType } from '@/game/components/pickup'
import { RacerStore } from '@/game/components/race'
import type { RaceTick } from '@/game/sim-step'
import { simulateStep } from '@/game/sim-step'
import { chargeBoostMeter } from '@/game/systems/boost-meter'
import type { GhostRunner } from '@/game/systems/ghost-runner'
import { getHeldPickup } from '@/game/systems/pickup'
import { tickRemoteInterp } from '@/game/systems/remote-interp'
import { computeStandings } from '@/game/systems/standings'
import type { WaveRiderSystem } from '@/game/systems/wave-rider'
import type { Track } from '@/game/tracks/types'
import type { MultiplayerHandle } from './multiplayer'
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
  audio: AudioEngine
  chase: ChaseCamera
  waveField: WaveFieldState
  waterMesh: {
    tick: (impacts: readonly BikeImpact[], focus: { x: number; z: number }) => void
    debug: { getTimeScale: () => number }
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
    audio,
    chase,
    waveField,
    waterMesh,
    sky,
    lapWeather,
    horizonRing,
    trackVisuals: _trackVisuals,
    raceHud,
    raceIntro,
    raceIntroUi,
    raceTick,
    dirArrow,
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
  } = opts

  let finishShown = false

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
  const trickPromptHud = createTrickPromptHud()

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
        onBeatCleared: (beat) => {
          tutorialHud?.flashCleared(beat.clearMessage ?? 'OK')
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

  // Reused per-frame buffer for the GPU water shader's bike impact array.
  // Sourced from `waveField.wakes`, which `wakeUpdateSystem` populated in
  // the physics loop above. Single source of truth: the displacement the
  // shader draws is the same displacement buoyancy reads.
  const bikeImpacts: BikeImpact[] = []
  function gatherBikeImpacts(): readonly BikeImpact[] {
    bikeImpacts.length = 0
    for (const w of waveField.wakes) {
      bikeImpacts.push({ x: w.x, z: w.z, vx: w.vx, vz: w.vz, weight: w.weight })
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
  const rendererInfo = (renderer as unknown as { info: RenderInfoLite }).info
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
    isHudOn: () => perfHud.isVisible(),
    toggleHud: () => {
      perfHud.setVisible(!perfHud.isVisible())
      return perfHud.isVisible()
    },
  })

  // M10.4 — wire-encoded input round-trip. simTick is the monotonic count
  // of fixed-step sim ticks driven by simulateStep; it lines up across
  // peers in lockstep multiplayer because both sides advance one tick per
  // delivered InputFrame batch. The DataView is reused per tick to avoid
  // a per-frame allocation. LOCAL_PEER_ID is the slot in a future room;
  // in single-player there is exactly one peer (slot 0).
  const LOCAL_PEER_ID = 0
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
  const replayFlat = new Float64Array(replaySlots.length * 7)

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

    // Step 8 — feed the rolling-window recorder. Allocation-free hot path
    // (writes a single Float32Array slot + advances the head index). The
    // expensive parts (sort, percentiles, render-info read) only run when
    // the HUD is visible AND the 500ms cadence ticks below.
    perfRecorder.sample(now)

    state.intent = state.intentOverride ?? readPlayerIntent(dt)

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
    while (physAccum >= phys.fixedDt) {
      if (!control.isDeterminismPaused()) {
        // M10.4 — drive the sim from a wire-encoded InputFrame even in
        // single-player. The round-trip is cheap (~10 bytes / one alloc)
        // and ensures the same quantization is applied locally as remotely,
        // so any feel changes from the wire format are visible day one.
        // When connected to a room, stamp the frame with the assigned
        // peerId (falls back to LOCAL_PEER_ID otherwise) and ship it to
        // the relay BEFORE stepping locally — that ordering means a
        // future lockstep gate could pause here waiting on remote frames
        // without changing the encode/decode contract.
        const myPeerId = net?.ready ? net.peerId : LOCAL_PEER_ID
        const localFrame = {
          tick: simTick,
          peerId: myPeerId,
          intent: state.intent,
        }
        encodeInputFrameInto(inputFrameView, 0, localFrame)
        net?.sendFrame(localFrame)
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
          ...(waveRiderSys ? { waveRiders: waveRiderSys } : {}),
        })
        // M10.11 — broadcast at 20 Hz. The send is gated on `net.ready &&
        // remotePeers > 0` inside the multiplayer handle, so this no-ops
        // outside a room.
        if (simTick % SNAPSHOT_TICKS === 0) multiplayer.buildAndSendSnapshot(simTick, iAmHost)
        simTick++
      }
      physAccum -= phys.fixedDt
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
          const o = i * 7
          if (!rb) {
            replayFlat[o] = 0
            replayFlat[o + 1] = 0
            replayFlat[o + 2] = 0
            replayFlat[o + 3] = 0
            replayFlat[o + 4] = 0
            replayFlat[o + 5] = 0
            replayFlat[o + 6] = 1
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
        }
        recorder.sample(elapsed, replayFlat)
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
      // First frame after the director reports done: arm the
      // countdown so the 3/2/1/GO ticks (which drive the start-lights
      // overlay) start playing. Tear down the skip prompt so it
      // doesn't linger past the GO! moment. Multiplayer compositions
      // also call `armCountdown` from the lobby clear path; both
      // call sites are idempotent because `armCountdown` early-outs
      // if the countdown is already running.
      raceHud.armCountdown()
      teardownIntroSkipUi()
      raceIntroUi?.hide()
      introArmed = true
    }

    let lastLookMagnitude = 0
    const rbHandle = RBHandleStore.get(playerEid)
    const hover = HoverStateStore.get(playerEid)
    if (rbHandle && hover) {
      const playerRb = phys.world.getRigidBody(rbHandle.handle)
      if (playerRb) {
        const t = playerRb.translation()
        const v = playerRb.linvel()
        const q = playerRb.rotation()
        tmpPos.set(t.x, t.y, t.z)
        tmpQuat.set(q.x, q.y, q.z, q.w)
        if (!introActive) {
          // Chase camera + camera-look only while the intro isn't
          // owning the camera. Letting them run during the intro
          // would lerp the chase pose against the director's pose
          // every frame and produce a fight; suppressing them keeps
          // the cinematic shots clean.
          const look = tickCameraLook(dt)
          lastLookMagnitude = Math.abs(look.yaw) + Math.abs(look.pitch)
          chase.setOrbit(look.yaw, look.pitch)
          chase.tick(tmpPos, tmpQuat, dt)
        }
        // Pump FX overlays — FOV punch + screen shake. Must run after
        // `chase.tick` so the shake offset doesn't get baked into the
        // chase camera's interpolated position before it's read.
        pumpFx.tick(dt)
        state.playerSnapshot = {
          eid: playerEid,
          position: { x: t.x, y: t.y, z: t.z },
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
      if (drift?.releasedThisTick && drift.releasedTier > 0 && intensity !== 'off') {
        audio.driftBoost(drift.releasedTier)
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
        pumpFx.setSustainedShake(nowActive)
        boostMeterHud.update(meter.charge, nowActive)
        state.boostMeterActive = nowActive
        state.boostMeterCharge = meter.charge
      }
      state.boostBtnDown = boostDown
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
    updateUnderwaterFog(
      scene,
      camera.position.y,
      sampleHeight(waveField, camera.position.x, camera.position.z),
    )
    bikeRender()
    riderRender()
    pickupRender(dt)
    combatRender(dt)
    fxTick(dt)
    waveRiderRender?.render()
    particleTick(dt)
    // Landmark pendulum animation — render-only, driven off wall-clock
    // seconds since boot so menu pauses don't freeze the visual rhythm.
    // `now` is the rAF timestamp; the system reads
    // `playerSettings.animatedLandmarks` internally and pins arms to
    // rest when off.
    landmarkTick(now / 1000)
    physicsDebug.tick()
    hoverDebug.tick(sim)

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
        const handle = RBHandleStore.get(s.eid)
        if (!handle) continue
        const rb = phys.world.getRigidBody(handle.handle)
        if (!rb) continue
        const t = rb.translation()
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

    // Step 8 — frame-rate cap. When `playerSettings.framerateCap > 0`
    // we skip the GPU render + frame counter on rAF ticks that arrive
    // sooner than the cap allows. The fixed-step sim accumulator above
    // already ran; only the render half drops. This keeps determinism
    // independent of the cap and is the Steam Deck path's hot knob
    // (60 fps cap = ~½ the GPU power of uncapped on a 90 Hz panel).
    const renderThisFrame = shouldRenderFrame(now, lastRenderedAt, playerSettings.framerateCap)
    if (renderThisFrame) {
      renderFrame(scene, camera)
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
  standings: ReadonlyArray<{ eid: number; position: number }>
  meStandingPosition: number | null
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
}

function showFinishScreen(opts: FinishOpts): void {
  const {
    rs,
    standings,
    meStandingPosition,
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
  } = opts

  // Cup-mode book-keeping. Pull the live cup-progress (if any), record
  // this race's finish position into it, and re-read so the post-finish
  // NEXT/EXIT routing knows whether more races remain.
  const cup = cupId !== null ? getCupProgressFor(cupId) : null
  let cupAfter = cup
  if (cup && cupId !== null) {
    cupAfter =
      recordCupRaceFinish({
        cupId,
        trackId,
        position: meStandingPosition,
        totalRacers: standings.length,
        raceTime: rs.raceTime,
      }) ?? cup
  }
  const isLastCupRace = cupAfter !== null && nextCupTrackId(cupAfter) === null
  const isCupMode = cupAfter !== null
  hud.finishEl?.classList.add('show')
  const finishRibbon = document.getElementById('finish-ribbon')
  if (hud.finishPos) {
    // TT mode is solo — position is meaningless. Hide the row's value
    // when it's just "1st" against no one.
    hud.finishPos.textContent = timeTrialMode
      ? '—'
      : meStandingPosition !== null
        ? ordinal(meStandingPosition)
        : '—'
  }
  if (hud.finishTime) hud.finishTime.textContent = formatTime(rs.raceTime)
  const wonRace = meStandingPosition === 1
  if (hud.finishTitle) {
    hud.finishTitle.textContent = timeTrialMode ? 'TIME TRIAL' : wonRace ? 'CHAMPION' : 'FINAL'
  }
  if (finishRibbon) {
    finishRibbon.textContent = timeTrialMode ? 'CLOCK' : wonRace ? 'WINNER' : 'FINAL'
  }
  if (hud.finishSub) {
    hud.finishSub.textContent = `${track.name.toUpperCase()} · ${playerVariant.name.toUpperCase()}`
  }
  // Stash a last-race summary for the menu's title-screen recap card.
  // Stored in sessionStorage so it survives the navigation to `?back=1`
  // but doesn't outlive the tab.
  try {
    sessionStorage.setItem(
      'hover-last-race',
      JSON.stringify({
        trackId,
        trackName: track.name,
        bikeId: playerVariant.id,
        bikeName: playerVariant.name,
        position: meStandingPosition,
        totalRacers: standings.length,
        time: rs.raceTime,
        bestLap: bestLapThisRace,
        wonRace,
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
      finishPosition: meStandingPosition,
      finishTime: rs.raceTime,
      bestLap: bestLapThisRace,
    })

    // Time Trial — slice the player's best lap from the recording and
    // persist it as the new ghost iff it beats the stored ghost's
    // best lap (or there's no stored ghost yet). Single-lap looping
    // ghost matches Wave Race / F-Zero TT convention. The leaderboard
    // banner renderer below picks this up via `ttBestLapForBoard` and
    // drives the local-cache write + remote submit lifecycle.
    if (timeTrialMode) {
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
        // Last race — open the cup-results overlay over the finish
        // screen, then leave it to its BACK TO MENU button to clear
        // cup-progress and navigate.
        nextBtn.textContent = 'CUP RESULTS →'
        nextBtn.onclick = () => {
          showCupResultsOverlay({
            progress: cupAfter,
            onBackToMenu: () => {
              clearCupProgress()
              const url = new URL(window.location.href)
              url.search = ''
              url.searchParams.set('back', '1')
              window.location.assign(url.toString())
            },
          })
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
