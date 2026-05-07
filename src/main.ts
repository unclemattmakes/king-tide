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
import { hoverSystem } from './game/systems/hover'
import { applyPlayerIntent } from './game/systems/input-apply'
import { createRaceSystem } from './game/systems/race'
import { syncFromPhysics } from './game/systems/sync-from-physics'
import { createLagoonLoop } from './game/tracks/lagoon-loop'

async function boot() {
  const appEl = document.getElementById('app')
  if (!appEl) throw new Error('#app not found')

  const fpsEl = document.getElementById('hud-fps')
  const backendEl = document.getElementById('hud-backend')
  const inputEl = document.getElementById('hud-input')
  const raceEl = document.getElementById('hud-race')

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

  const playerEid = createBike(sim, phys, {
    position: track.start.position,
    yaw: track.start.yaw,
    isPlayer: true,
    asRacer: true,
  })

  const raceTick = createRaceSystem(track, {
    onCheckpoint: (eid, idx) => {
      // Repaint gate visuals based on the new "next" pointer.
      const r = RacerStore.get(eid)
      if (!r) return
      for (const cp of track.checkpoints) {
        if (cp.index === r.nextCheckpoint) trackVisuals.setCheckpointState(cp.index, 'next')
        else if (idx >= cp.index && r.lap === 1) {
          // Crude rule: in lap 1, anything before next is "passed".
          trackVisuals.setCheckpointState(cp.index, 'passed')
        } else {
          trackVisuals.setCheckpointState(cp.index, 'upcoming')
        }
      }
    },
  })

  const bikeRender = createBikeRenderSystem(scene, sim)

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

  installDebugApi(state)
  if (backendEl) backendEl.textContent = `backend: ${backend}`

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
      applyPlayerIntent(sim, state.intent)
      hoverSystem(sim, phys, waveField)
      phys.step()
      syncFromPhysics(sim, phys)
      raceTick(sim, phys, phys.fixedDt)
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
        inputEl.textContent = `${inputSourceLabel()} | thr ${i.throttle.toFixed(2)} steer ${i.steer.toFixed(2)} | ${speed.toFixed(1)} m/s`
      }
      if (raceEl && state.raceSnapshot) {
        const rs = state.raceSnapshot
        const status = rs.finished
          ? 'FINISHED'
          : `cp ${rs.nextCheckpoint + 1}/${rs.totalCheckpoints}`
        raceEl.textContent = `lap ${rs.lap}/${rs.lapsToFinish} | ${status} | ${rs.raceTime.toFixed(1)}s`
      }
    }
    requestAnimationFrame(frame)
  }

  state.ready = true
  requestAnimationFrame(frame)
}

boot().catch((err) => {
  console.error('[boot] fatal', err)
  const el = document.getElementById('hud-backend')
  if (el) el.textContent = `boot failed: ${String(err)}`
})
