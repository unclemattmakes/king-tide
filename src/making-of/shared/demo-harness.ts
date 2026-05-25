import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

/**
 * Minimal Three.js scene boilerplate shared by every making-of demo.
 *
 * Deliberately plain WebGL (not the game's WebGPU renderer): these demos
 * are embedded inline in an article, need to run everywhere a reader's
 * browser might be, and don't need the full game pipeline. The *sim* code
 * they visualize is imported straight from `src/engine` — that's the part
 * that has to stay honest. The renderer is just glass.
 *
 * The loop pauses itself when the canvas scrolls out of view so a page
 * full of demos doesn't melt a laptop.
 */

export type FrameCallback = (dt: number, elapsed: number) => void

export type DemoHarness = {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  controls: OrbitControls
  /** Register a per-frame callback. Returns an unsubscribe function. */
  onFrame: (cb: FrameCallback) => () => void
  dispose: () => void
}

export type HarnessOptions = {
  cameraPos?: [number, number, number]
  target?: [number, number, number]
  fov?: number
  background?: number
}

export function createDemoHarness(container: HTMLElement, opts: HarnessOptions = {}): DemoHarness {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(opts.background ?? 0x081320)

  const camera = new THREE.PerspectiveCamera(opts.fov ?? 50, 1, 0.1, 1000)
  camera.position.set(...(opts.cameraPos ?? [0, 22, 34]))

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  container.appendChild(renderer.domElement)
  renderer.domElement.classList.add('mo-canvas')

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.target.set(...(opts.target ?? [0, 0, 0]))
  controls.minDistance = 6
  controls.maxDistance = 120

  const callbacks = new Set<FrameCallback>()
  const clock = new THREE.Clock()
  let visible = true
  let running = true
  let rafId = 0

  function resize() {
    const w = container.clientWidth
    const h = container.clientHeight
    if (w === 0 || h === 0) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  const ro = new ResizeObserver(resize)
  ro.observe(container)
  resize()

  // Pause rendering (and clock) when the demo isn't on screen.
  const io = new IntersectionObserver(
    (entries) => {
      const entry = entries[0]
      visible = entry ? entry.isIntersecting : true
      if (visible && !clock.running) clock.start()
      if (!visible && clock.running) clock.stop()
    },
    { threshold: 0.01 },
  )
  io.observe(container)

  function tick() {
    if (!running) return
    rafId = requestAnimationFrame(tick)
    if (!visible) return
    const dt = Math.min(clock.getDelta(), 0.05)
    const elapsed = clock.elapsedTime
    controls.update()
    for (const cb of callbacks) cb(dt, elapsed)
    renderer.render(scene, camera)
  }
  rafId = requestAnimationFrame(tick)

  return {
    scene,
    camera,
    renderer,
    controls,
    onFrame(cb) {
      callbacks.add(cb)
      return () => callbacks.delete(cb)
    },
    dispose() {
      running = false
      cancelAnimationFrame(rafId)
      ro.disconnect()
      io.disconnect()
      controls.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
