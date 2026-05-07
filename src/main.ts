import * as THREE from 'three'
import { installDebugApi, type PlayerSnapshot } from './debug'
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
import { createSimWorld } from './engine/sim/ecs/world'
import { createPhysicsWorld } from './engine/sim/physics/rapier'
import { vecHorizontalLength } from './engine/sim/physics/vec'
import { HoverStateStore, RBHandleStore } from './game/components'
import { createBike, createGround } from './game/entities/bike'
import { hoverSystem } from './game/systems/hover'
import { applyPlayerIntent } from './game/systems/input-apply'
import { syncFromPhysics } from './game/systems/sync-from-physics'

async function boot() {
  const appEl = document.getElementById('app')
  if (!appEl) throw new Error('#app not found')

  const fpsEl = document.getElementById('hud-fps')
  const backendEl = document.getElementById('hud-backend')
  const inputEl = document.getElementById('hud-input')

  installInput()

  const { renderer, backend } = await createRenderer(appEl)
  const { scene, camera } = createScene()
  const phys = await createPhysicsWorld()
  const sim = createSimWorld()
  const chase = createChaseCamera(camera)

  createGround(phys)
  const playerEid = createBike(sim, phys, {
    position: { x: 0, y: 2, z: 0 },
    isPlayer: true,
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
      applyPlayerIntent(sim, state.intent)
      hoverSystem(sim, phys)
      phys.step()
      syncFromPhysics(sim, phys)
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
