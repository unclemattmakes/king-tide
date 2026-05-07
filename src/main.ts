import { installDebugApi } from './debug'
import {
  emptyIntent,
  type Intent,
  inputSourceLabel,
  installInput,
  readPlayerIntent,
} from './engine/input'
import { createRenderer } from './engine/render/renderer'
import { createPlaceholderScene } from './engine/render/scene'
import { createSimWorld } from './engine/sim/ecs/world'

async function boot() {
  const appEl = document.getElementById('app')
  if (!appEl) throw new Error('#app not found')

  const fpsEl = document.getElementById('hud-fps')
  const backendEl = document.getElementById('hud-backend')
  const inputEl = document.getElementById('hud-input')

  installInput()

  const { renderer, backend } = await createRenderer(appEl)
  const { scene, camera, tick } = createPlaceholderScene()

  // Sim world (M0: empty — exists to prove the seam works)
  const _world = createSimWorld()

  const state = {
    ready: false,
    backend,
    fps: 0,
    frame: 0,
    intent: emptyIntent() as Intent,
    intentOverride: null as Intent | null,
  }

  installDebugApi(state)
  if (backendEl) backendEl.textContent = `backend: ${backend}`

  let last = performance.now()
  let framesThisSecond = 0
  let fpsAccumStart = last

  function frame(now: number) {
    const dt = Math.min((now - last) / 1000, 1 / 30) // clamp huge stalls
    last = now

    state.intent = state.intentOverride ?? readPlayerIntent()
    tick(dt)
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
        inputEl.textContent = `${inputSourceLabel()} | thr ${i.throttle.toFixed(2)} steer ${i.steer.toFixed(2)}`
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
