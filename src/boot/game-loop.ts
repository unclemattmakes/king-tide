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
import { formatLap } from '@/engine/garage'
import { type Intent, inputSourceLabel, readPlayerIntent } from '@/engine/input'
import { tickCameraLook } from '@/engine/input/camera-look'
import {
  type SubmitResult,
  submitEntry as submitLeaderboardEntry,
} from '@/engine/leaderboard-state'
import { buildTrackList, nextTrackId } from '@/engine/menus/catalog'
import {
  decodeInputFrameFrom,
  encodeInputFrameInto,
  INPUT_FRAME_WIRE_BYTES,
} from '@/engine/net/input-frame'
import {
  ANTI_GRAV_CAMERA_SCALAR,
  markTutorialCompleted,
  playerSettings,
} from '@/engine/player-settings'
import { createAntiGravHud } from '@/engine/render/anti-grav-hud'
import type { ChaseCamera } from '@/engine/render/camera'
import { showCupResultsOverlay } from '@/engine/render/cup-results-screen'
import type { DirectionArrow } from '@/engine/render/direction-arrow'
import type { HorizonRing } from '@/engine/render/horizon-ring'
import type { RaceHud } from '@/engine/render/race-hud'
import type { SkySystem } from '@/engine/render/sky'
import type { TrackVisuals } from '@/engine/render/track-mesh'
import { createTutorialHud } from '@/engine/render/tutorial-hud'
import { type BikeImpact, updateUnderwaterFog } from '@/engine/render/water'
import { createWavePumpHud } from '@/engine/render/wave-pump-hud'
import { sliceBestLap } from '@/engine/replay/best-lap-slice'
import { serializeReplay } from '@/engine/replay/format'
import { getGhostBestLap, setGhost } from '@/engine/replay/ghost-state'
import type { ReplayRecorder } from '@/engine/replay/recorder'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { vecHorizontalLength } from '@/engine/sim/physics/vec'
import type { WaveFieldState } from '@/engine/sim/water/wave-field'
import { createTutorialDirector } from '@/engine/tutorial/tutorial-director'
import { DEFAULT_TUTORIAL_SCRIPT } from '@/engine/tutorial/tutorial-script'
import { createWavePumpObserver } from '@/engine/wave-pump-observer'
import type { AssetManifest } from '@/game/assets/manifest'
import type { BikeVariant } from '@/game/bikes/variants'
import {
  AntiGravOverrideStore,
  BikeStatsStore,
  ControlIntentStore,
  HoverStateStore,
  RBHandleStore,
} from '@/game/components'
import { ExplosionTag, MineTag, MissileTag } from '@/game/components/combat'
import type { PickupType } from '@/game/components/pickup'
import { RacerStore } from '@/game/components/race'
import type { RaceTick } from '@/game/sim-step'
import { simulateStep } from '@/game/sim-step'
import type { GhostRunner } from '@/game/systems/ghost-runner'
import { getHeldPickup } from '@/game/systems/pickup'
import { tickRemoteInterp } from '@/game/systems/remote-interp'
import { computeStandings } from '@/game/systems/standings'
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
  horizonRing: HorizonRing
  trackVisuals: TrackVisuals
  raceHud: RaceHud
  raceTick: RaceTick
  dirArrow: DirectionArrow
  physicsDebug: { tick: () => void }
  bikeRender: () => void
  riderRender: () => void
  pickupRender: (dt: number) => void
  combatRender: (dt: number) => void
  fxTick: (dt: number) => void
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
    horizonRing,
    trackVisuals: _trackVisuals,
    raceHud,
    raceTick,
    dirArrow,
    physicsDebug,
    bikeRender,
    riderRender,
    pickupRender,
    combatRender,
    fxTick,
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
  } = opts

  let finishShown = false

  // Per-frame audio dispatch needs to remember "what was true last tick" so
  // it can fire one-shots on transitions. Player slot for collect/fire
  // events; sim entity counts for any-bike weapon spawns.
  let prevPlayerHeld: PickupType | null = null
  let prevMineCount = 0
  let prevMissileCount = 0
  let prevExplosionCount = 0

  // Wave-pump signal — detects clean crest launches on the player bike
  // each render frame and fires the HUD widget + audio cue. Lives on
  // the render side (not in simulateStep) because pump events are
  // pure feedback — no determinism dependency, no replay obligations.
  const wavePumpObserver = createWavePumpObserver()
  const wavePumpHud = createWavePumpHud()

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

  const tmpPos = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()
  const tmpTarget = new THREE.Vector3()

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

  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 1 / 15)
    last = now

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
        const look = tickCameraLook(dt)
        lastLookMagnitude = Math.abs(look.yaw) + Math.abs(look.pitch)
        chase.setOrbit(look.yaw, look.pitch)
        chase.tick(tmpPos, tmpQuat, dt)
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

    // Wave-pump signal — observer reads the player's hover + velocity
    // + throttle state and fires on a clean crest launch. Skipped while
    // auto-play is on (we're driving for the rider, not pumping). The
    // observer enforces its own cooldown so the per-frame call is
    // cheap (~one struct comparison + a few number checks).
    if (!control.isAutoPlay() && state.playerSnapshot) {
      const hoverState = HoverStateStore.get(playerEid)
      const intent = ControlIntentStore.get(playerEid)
      const stats = BikeStatsStore.get(playerEid)
      if (hoverState && intent && stats) {
        const pump = wavePumpObserver.detect(now, {
          surfaceIsWater: hoverState.surfaceIsWater,
          isGrounded: hoverState.isGrounded,
          vy: state.playerSnapshot.velocity.y,
          forwardSpeed: state.playerSnapshot.speed,
          topSpeed: stats.topSpeed,
          throttle: Math.max(0, intent.throttle),
        })
        if (pump) {
          wavePumpHud.pump(pump.strength)
          if (playerSettings.wavePumpIntensity !== 'off') {
            audio.wavePump(pump.strength)
          }
          tutorialDirector?.notifyPumpEvent()
        }
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
    // Day-night cycle + fog/hemi palette + PMREM env-map bake. The sky
    // system owns the directional-sun follow (shadow-camera centred on the
    // bike) and the water shader's sun-direction uniform. Time is the
    // deterministic wave-field clock so replays and rollbacks line up.
    sky.tick(waveField.time, dt, {
      x: state.playerSnapshot?.position.x ?? 0,
      z: state.playerSnapshot?.position.z ?? 0,
    })
    // Keep the distant horizon silhouette wrapped around the chase camera
    // so the player never appears to outrun it. Tracks the camera (not the
    // bike) so look-back / spectator pans don't shift the horizon.
    horizonRing.tick({ x: camera.position.x, z: camera.position.z })
    updateUnderwaterFog(scene, camera.position.y)
    bikeRender()
    riderRender()
    pickupRender(dt)
    combatRender(dt)
    fxTick(dt)
    physicsDebug.tick()

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

    renderer.render(scene, camera)

    state.frame += 1
    framesThisSecond += 1
    if (now - fpsAccumStart >= 500) {
      state.fps = (framesThisSecond * 1000) / (now - fpsAccumStart)
      framesThisSecond = 0
      fpsAccumStart = now
      if (hud.fpsEl) hud.fpsEl.textContent = `fps: ${state.fps.toFixed(0)}`
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
  let leaderboardResult: SubmitResult | null = null
  if (recorder) {
    const replay = recorder.finalize({
      finishPosition: meStandingPosition,
      finishTime: rs.raceTime,
      bestLap: bestLapThisRace,
    })

    // Time Trial — slice the player's best lap from the recording and
    // persist it as the new ghost iff it beats the stored ghost's
    // best lap (or there's no stored ghost yet). Single-lap looping
    // ghost matches Wave Race / F-Zero TT convention.
    if (timeTrialMode) {
      const slice = sliceBestLap(replay, 0)
      if (slice) {
        const existing = getGhostBestLap({ trackId, bikeId: playerVariant.id })
        if (existing === null || slice.bestLap < existing) {
          newGhostSaved = setGhost({ trackId, bikeId: playerVariant.id }, slice.replay)
          // Local leaderboard submission piggybacks on the PB ghost
          // save. Gated on the player's "Submit times" toggle so the
          // off state is a true silence (no entry written). Handle
          // falls back to 'YOU' inside the writer when the player
          // hasn't set one — the rank still shows up on finish, and
          // the player can rename in Settings later (existing slot
          // by handle, so a rename creates a new row rather than
          // moving the old one).
          if (newGhostSaved && playerSettings.leaderboardSubmit) {
            leaderboardResult = submitLeaderboardEntry({
              trackId,
              handle: playerSettings.leaderboardHandle,
              bikeId: playerVariant.id,
              bestLap: slice.bestLap,
            })
          }
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

  // Best-lap / ghost banner. Rendered after the ghost slicer so we can
  // surface "GHOST SAVED" alongside "NEW BEST" when the player set a
  // fresh PB in TT mode.
  if (hud.finishBest) {
    const parts: string[] = []
    if (bestLapThisRace !== null) {
      parts.push(`${formatLap(bestLapThisRace)} (race)`)
    }
    if (bestLapAllTime !== null) {
      parts.push(`<span class="best">${formatLap(bestLapAllTime)} (PB)</span>`)
    }
    if (timeTrialMode && newGhostSaved) {
      parts.push('<span class="best">★ GHOST SAVED</span>')
    }
    if (timeTrialMode && leaderboardResult?.improved && leaderboardResult.rank !== null) {
      // Handle is pre-normalized to [A-Z0-9_-] by `normalizeHandle`, so
      // it's safe to inline without further escaping.
      const handleLabel = (playerSettings.leaderboardHandle || 'YOU').toUpperCase()
      parts.push(
        `<span class="best">#${leaderboardResult.rank} ON BOARD &middot; ${handleLabel}</span>`,
      )
    }
    hud.finishBest.innerHTML = parts.length ? parts.join(' · ') : '—'
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
