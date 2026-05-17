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
import { formatLap } from '@/engine/garage'
import { type Intent, inputSourceLabel, readPlayerIntent } from '@/engine/input'
import { tickCameraLook } from '@/engine/input/camera-look'
import { buildTrackList, nextTrackId } from '@/engine/menus/catalog'
import {
  decodeInputFrameFrom,
  encodeInputFrameInto,
  INPUT_FRAME_WIRE_BYTES,
} from '@/engine/net/input-frame'
import type { ChaseCamera } from '@/engine/render/camera'
import type { DirectionArrow } from '@/engine/render/direction-arrow'
import type { HorizonRing } from '@/engine/render/horizon-ring'
import type { RaceHud } from '@/engine/render/race-hud'
import type { SkySystem } from '@/engine/render/sky'
import type { TrackVisuals } from '@/engine/render/track-mesh'
import { type BikeImpact, updateUnderwaterFog } from '@/engine/render/water'
import { serializeReplay } from '@/engine/replay/format'
import type { ReplayRecorder } from '@/engine/replay/recorder'
import type { SimWorld } from '@/engine/sim/ecs/world'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import { vecHorizontalLength } from '@/engine/sim/physics/vec'
import type { WaveFieldState } from '@/engine/sim/water/wave-field'
import type { AssetManifest } from '@/game/assets/manifest'
import type { BikeVariant } from '@/game/bikes/variants'
import { HoverStateStore, RBHandleStore } from '@/game/components'
import { ExplosionTag, MineTag, MissileTag } from '@/game/components/combat'
import type { PickupType } from '@/game/components/pickup'
import { RacerStore } from '@/game/components/race'
import type { RaceTick } from '@/game/sim-step'
import { simulateStep } from '@/game/sim-step'
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
  /** Replay recorder — null in replay playback mode. */
  recorder: ReplayRecorder | null
  recorderStart: number
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
    recorder,
    recorderStart,
    lapState,
    control,
    hud,
    onFinish,
  } = opts

  let finishShown = false

  // Per-frame audio dispatch needs to remember "what was true last tick" so
  // it can fire one-shots on transitions. Player slot for collect/fire
  // events; sim entity counts for any-bike weapon spawns.
  let prevPlayerHeld: PickupType | null = null
  let prevMineCount = 0
  let prevMissileCount = 0
  let prevExplosionCount = 0

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
            recorder,
            bestLapThisRace: lapState.bestLapThisRace,
            bestLapAllTime: lapState.bestLapAllTime,
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
  recorder: ReplayRecorder | null
  bestLapThisRace: number | null
  bestLapAllTime: number | null
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
    recorder,
    bestLapThisRace,
    bestLapAllTime,
  } = opts
  hud.finishEl?.classList.add('show')
  const finishRibbon = document.getElementById('finish-ribbon')
  if (hud.finishPos && meStandingPosition !== null) {
    hud.finishPos.textContent = ordinal(meStandingPosition)
  }
  if (hud.finishTime) hud.finishTime.textContent = formatTime(rs.raceTime)
  const wonRace = meStandingPosition === 1
  if (hud.finishTitle) hud.finishTitle.textContent = wonRace ? 'CHAMPION' : 'FINAL'
  if (finishRibbon) finishRibbon.textContent = wonRace ? 'WINNER' : 'FINAL'
  if (hud.finishSub) {
    hud.finishSub.textContent = `${track.name.toUpperCase()} · ${playerVariant.name.toUpperCase()}`
  }
  if (hud.finishBest) {
    const parts: string[] = []
    if (bestLapThisRace !== null) {
      parts.push(`${formatLap(bestLapThisRace)} (race)`)
    }
    if (bestLapAllTime !== null) {
      parts.push(`<span class="best">${formatLap(bestLapAllTime)} (PB)</span>`)
    }
    hud.finishBest.innerHTML = parts.length ? parts.join(' · ') : '—'
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
  if (recorder) {
    const replay = recorder.finalize({
      finishPosition: meStandingPosition,
      finishTime: rs.raceTime,
      bestLap: bestLapThisRace,
    })
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

  // Action buttons: NEXT (default), RETRY, EXIT.
  const nextBtn = document.getElementById('finish-next') as HTMLButtonElement | null
  const retryBtn = document.getElementById('finish-retry') as HTMLButtonElement | null
  const exitBtn = document.getElementById('finish-exit') as HTMLButtonElement | null
  if (nextBtn) {
    nextBtn.onclick = () => {
      const tracksList = buildTrackList(manifest.tracks)
      const nextId = nextTrackId(tracksList, trackId)
      window.location.assign(buildRaceUrl({ roomId, trackId: nextId, bikeId: playerVariant.id }))
    }
    nextBtn.focus({ preventScroll: true })
  }
  if (retryBtn) {
    retryBtn.onclick = () => {
      window.location.assign(buildRaceUrl({ roomId, trackId, bikeId: playerVariant.id }))
    }
  }
  if (exitBtn) {
    exitBtn.onclick = () => {
      const url = new URL(window.location.href)
      url.search = ''
      url.searchParams.set('back', '1')
      window.location.assign(url.toString())
    }
  }
}

function buildRaceUrl(args: { roomId: string | null; trackId: string; bikeId: string }): string {
  const url = new URL(window.location.href)
  url.search = ''
  if (args.roomId) url.searchParams.set('room', args.roomId)
  url.searchParams.set('race', '1')
  url.searchParams.set('track', args.trackId)
  url.searchParams.set('bike', args.bikeId)
  return url.toString()
}
