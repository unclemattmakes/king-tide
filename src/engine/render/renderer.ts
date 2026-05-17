import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'

export type RenderBackend = 'webgpu' | 'webgl2'

export type RendererBundle = {
  renderer: THREE.WebGLRenderer
  backend: RenderBackend
  canvas: HTMLCanvasElement
  resize(): void
  dispose(): void
}

/**
 * Always uses Three.js's `WebGPURenderer`, which auto-falls-back to a WebGL2
 * backend internally when WebGPU is unavailable. We probe `navigator.gpu`
 * first so we can report the *actual* backend in the HUD instead of waiting
 * for the silent fallback.
 *
 * Going through WebGPURenderer (rather than the legacy WebGLRenderer) is
 * load-bearing for the GPU water shader: only the new node-material pipeline
 * (TSL) supports the unified backend abstraction. The water mesh wires its
 * Gerstner displacement + per-fragment lighting through TSL nodes that
 * compile to WGSL on WebGPU and GLSL on the WebGL2 fallback.
 */
export async function createRenderer(parent: HTMLElement): Promise<RendererBundle> {
  const canvas = document.createElement('canvas')
  parent.appendChild(canvas)

  let hasWebGpu = false
  if ('gpu' in navigator) {
    try {
      const adapter = await navigator.gpu!.requestAdapter()
      hasWebGpu = adapter !== null
    } catch {
      hasWebGpu = false
    }
  }

  // `?aa=off` disables MSAA — on WebGPU that's a multisampled colour
  // attachment, costing 2–4× bandwidth on the main pass. Default stays
  // on (current shipping behaviour); the toggle is for low-end hardware
  // and FFT-foam debug shots where the multisample buffer adds nothing
  // visible at racing speed but eats budget on integrated GPUs.
  const aaParam = new URLSearchParams(window.location.search).get('aa')
  const antialias = aaParam !== 'off'

  const r = new WebGPURenderer({
    canvas,
    antialias,
    forceWebGL: !hasWebGpu,
  })
  await r.init()

  // WebGPURenderer is API-compatible with WebGLRenderer for our usage
  // (setSize, setPixelRatio, render, dispose). The cast keeps the existing
  // type signature stable for the rest of the engine.
  const renderer = r as unknown as THREE.WebGLRenderer
  const backend: RenderBackend = hasWebGpu ? 'webgpu' : 'webgl2'

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight, false)

  // Soft directional-sun shadows. Casters/receivers are flagged on each
  // mesh by the systems that build them (bike clones, props, terrain).
  // Water is intentionally excluded — its node-material shader drives its
  // own lighting and we don't want the surface mottled by shadow maps.
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false)
  }
  window.addEventListener('resize', resize)

  const dispose = () => {
    window.removeEventListener('resize', resize)
    renderer.dispose()
    canvas.remove()
  }

  return { renderer, backend, canvas, resize, dispose }
}
