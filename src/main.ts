import * as THREE from 'three'
import { installDebugApi, type PlayerSnapshot, type RaceSnapshot } from './debug'
import {
  emptyIntent,
  type Intent,
  inputSourceLabel,
  installInput,
  readPlayerIntent,
} from './engine/input'
import { createChaseCamera } from './engine/render/camera'
import { createPickupRenderSystem } from './engine/render/pickup-render'
import { createBikeRenderSystem } from './engine/render/render-systems'
import { createRenderer } from './engine/render/renderer'
import { createScene } from './engine/render/scene'
import { createTrackVisuals } from './engine/render/track-mesh'
import { createWaterMesh } from './engine/render/water'
import { createSimWorld } from './engine/sim/ecs/world'
import { createPhysicsWorld } from './engine/sim/physics/rapier'
import { vecHorizontalLength } from './engine/sim/physics/vec'
import { advanceWaveField, createWaveField, defaultWaves } from './engine/sim/water/wave-field'
import { HoverStateStore, RBHandleStore } from './game/components'
import { RacerStore } from './game/components/race'
import { createArena } from './game/entities/arena'
import { createBike } from './game/entities/bike'
import { createPickupSpawn } from './game/entities/pickup-spawn'
import { addComponent, hasComponent, removeComponent } from 'bitecs'
import { AIController, AIControllerStore, AITag, defaultAIController } from './game/components/ai'
import { aiControlSystem } from './game/systems/ai-control'
import { hoverSystem } from './game/systems/hover'
import { applyPlayerIntent } from './game/systems/input-apply'
import {
  boostTickSystem,
  getHeldPickup,
  pickupSystem,
  pickupUseSystem,
} from './game/systems/pickup'
import { createRaceSystem } from './game/systems/race'
import { rubberBandSystem } from './game/systems/rubber-band'
import { computeStandings } from './game/systems/standings'
import { syncFromPhysics } from './game/systems/sync-from-physics'
import { createLagoonLoop } from './game/tracks/lagoon-loop'

const NUM_AI = 4

async function boot() {
  const appEl = document.getElementById('app')
  if (!appEl) throw new Error('#app not found')

  const fpsEl = document.getElementById('hud-fps')
  const backendEl = document.getElementById('hud-backend')
  const inputEl = document.getElementById('hud-input')
  const raceEl = document.getElementById('hud-race')
  const finishEl = document.getElementById('finish')
  const finishTitle = document.getElementById('finish-title')
  const finishSub = document.getElementById('finish-sub')
  const finishPos = document.getElementById('finish-pos')
  const finishTime = document.getElementById('finish-time')

  installInput()

  const { renderer, backend } = await createRenderer(appEl)
  const { scene, camera } = createScene()
  const phys = await createPhysicsWorld()
  const sim = createSimWorld()
  const chase = createChaseCamera(camera)

  const waveField = createWaveField(defaultWaves())
  const waterMesh = createWaterMesh(waveField, { size: 800, subdivisions: 96 })
  scene.add(waterMesh.mesh)

  createArena(phys)

  const track = createLagoonLoop()
  const trackVisuals = createTrackVisuals(track)
  scene.add(trackVisuals.group)

  // Pickup spawns from track.
  for (let i = 0; i < track.pickupSpawns.length; i++) {
    createPickupSpawn(sim, track.pickupSpawns[i]!, i)
  }

  const startPos = track.start.position
  const playerEid = createBike(sim, phys, {
    position: startPos,
    yaw: track.start.yaw,
    isPlayer: true,
    asRacer: true,
  })

  const aiEids: number[] = []
  for (let i = 0; i < NUM_AI; i++) {
    // Stagger 2 rows of 2 BEHIND the player so initial physics jostling doesn't
    // push the player off the line.
    const row = Math.floor(i / 2)
    const col = i % 2
    const offsetX = (col === 0 ? -1 : 1) * 3
    const offsetZ = -(row + 1) * 4 - 4 // 4..12m behind, increasing per row
    const aiEid = createBike(sim, phys, {
      position: { x: startPos.x + offsetX, y: startPos.y, z: startPos.z + offsetZ },
      yaw: track.start.yaw,
      asRacer: true,
      ai: { splineId: 'main' },
    })
    aiEids.push(aiEid)
  }

  const raceTick = createRaceSystem(track, {
    onCheckpoint: (eid, idx) => {
      if (eid !== playerEid) return
      const r = RacerStore.get(eid)
      if (!r) return
      for (const cp of track.checkpoints) {
        if (cp.index === r.nextCheckpoint) trackVisuals.setCheckpointState(cp.index, 'next')
        else if (idx >= cp.index && r.lap === 1) {
          trackVisuals.setCheckpointState(cp.index, 'passed')
        } else {
          trackVisuals.setCheckpointState(cp.index, 'upcoming')
        }
      }
    },
  })

  const bikeRender = createBikeRenderSystem(scene, sim)
  const pickupRender = createPickupRenderSystem(scene, sim)

  const state = {
    ready: false,
    backend,
    fps: 0,
    frame: 0,
    intent: emptyIntent() as Intent,
    intentOverride: null as Intent | null,
    playerSnapshot: null as PlayerSnapshot | null,
    raceSnapshot: null as RaceSnapshot | null,
  }

  installDebugApi(state, {
    sim: () => sim,
    phys: () => phys,
    track: () => track,
    playerEid: () => playerEid,
    toggleAutoPlay: () => {
      setAutoPlay(!autoPlay)
      return autoPlay
    },
    isAutoPlay: () => autoPlay,
  })
  if (backendEl) backendEl.textContent = `backend: ${backend}`
  if (finishSub) finishSub.textContent = track.name

  let finishShown = false
  let autoPlay = false

  /** Attach/detach AITag on the player. When attached, ai-control-system
   *  drives the player's ControlIntent (overwriting applyPlayerIntent's write
   *  because aiControlSystem runs after it). */
  function setAutoPlay(on: boolean) {
    autoPlay = on
    if (on) {
      if (!hasComponent(sim, playerEid, AITag)) {
        addComponent(sim, playerEid, AITag)
        addComponent(sim, playerEid, AIController)
        AIControllerStore.set(playerEid, defaultAIController('main'))
      }
    } else if (hasComponent(sim, playerEid, AITag)) {
      removeComponent(sim, playerEid, AITag)
    }
  }

  // Keys: R to restart after finish; T (or F1) to toggle auto-play.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && finishShown) {
      window.location.reload()
    } else if (e.code === 'KeyT' || e.code === 'F1') {
      setAutoPlay(!autoPlay)
    }
  })

  const tmpPos = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()

  let last = performance.now()
  let physAccum = 0
  let framesThisSecond = 0
  let fpsAccumStart = last

  function frame(now: number) {
    const dt = Math.min((now - last) / 1000, 1 / 15)
    last = now

    state.intent = state.intentOverride ?? readPlayerIntent()

    physAccum += dt
    while (physAccum >= phys.fixedDt) {
      advanceWaveField(waveField, phys.fixedDt)
      // Player intent first; AI runs after and overwrites for entities tagged
      // AITag (which now includes the player while auto-play is on).
      if (!autoPlay) applyPlayerIntent(sim, state.intent)
      aiControlSystem(sim, phys, track)
      hoverSystem(sim, phys, waveField)
      phys.step()
      syncFromPhysics(sim, phys)
      raceTick(sim, phys, phys.fixedDt)
      pickupSystem(sim, phys, phys.fixedDt)
      pickupUseSystem(sim, phys)
      boostTickSystem(sim, phys.fixedDt)
      rubberBandSystem(sim, track)
      physAccum -= phys.fixedDt
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

    waterMesh.tick()
    bikeRender()
    pickupRender(dt)
    renderer.render(scene, camera)

    state.frame += 1
    framesThisSecond += 1
    if (now - fpsAccumStart >= 500) {
      state.fps = (framesThisSecond * 1000) / (now - fpsAccumStart)
      framesThisSecond = 0
      fpsAccumStart = now
      if (fpsEl) fpsEl.textContent = `fps: ${state.fps.toFixed(0)}`
      if (inputEl) {
        const i = state.intent
        const speed = state.playerSnapshot?.speed ?? 0
        const held = getHeldPickup(playerEid) ?? '—'
        inputEl.textContent = `${inputSourceLabel()} | thr ${i.throttle.toFixed(2)} steer ${i.steer.toFixed(2)} | ${speed.toFixed(1)} m/s | item: ${held}`
      }
      if (raceEl && state.raceSnapshot) {
        const rs = state.raceSnapshot
        const standings = computeStandings(sim, track)
        const me = standings.find((s) => s.eid === playerEid)
        const status = rs.finished
          ? 'FINISHED'
          : `cp ${rs.nextCheckpoint + 1}/${rs.totalCheckpoints}`
        const auto = autoPlay ? ' [AUTO]' : ''
        raceEl.textContent = `lap ${rs.lap}/${rs.lapsToFinish} | pos ${me?.position ?? '?'}/${standings.length} | ${status} | ${rs.raceTime.toFixed(1)}s${auto}`

        if (rs.finished && !finishShown && finishEl) {
          finishShown = true
          finishEl.classList.add('show')
          if (finishPos && me) finishPos.textContent = ordinal(me.position)
          if (finishTime) finishTime.textContent = formatTime(rs.raceTime)
          if (finishTitle) finishTitle.textContent = me?.position === 1 ? 'WINNER' : 'FINISH'
        }
      }
    }
    requestAnimationFrame(frame)
  }

  state.ready = true
  requestAnimationFrame(frame)
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return m > 0 ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${s.toFixed(2)}s`
}

boot().catch((err) => {
  console.error('[boot] fatal', err)
  const el = document.getElementById('hud-backend')
  if (el) el.textContent = `boot failed: ${String(err)}`
})
