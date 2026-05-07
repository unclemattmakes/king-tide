import * as THREE from 'three'

export type RenderBackend = 'webgpu' | 'webgl2'

export type RendererBundle = {
  renderer: THREE.WebGLRenderer
  backend: RenderBackend
  canvas: HTMLCanvasElement
  resize(): void
  dispose(): void
}

/**
 * Try WebGPURenderer first; fall back to WebGLRenderer on failure or unsupported browser.
 *
 * Note: Three.js's WebGPURenderer extends the same public surface as WebGLRenderer
 * for most code paths (scene + camera + render). We type the return as WebGLRenderer
 * which is structurally compatible for our usage.
 */
export async function createRenderer(parent: HTMLElement): Promise<RendererBundle> {
  const canvas = document.createElement('canvas')
  parent.appendChild(canvas)

  let renderer: THREE.WebGLRenderer
  let backend: RenderBackend

  // Probe for a real WebGPU adapter first — Three.js's WebGPURenderer will
  // silently fall back to WebGL2 internally if it can't get one, which makes
  // backend reporting misleading. Probing avoids that.
  let hasWebGpu = false
  if ('gpu' in navigator) {
    try {
      const adapter = await navigator.gpu!.requestAdapter()
      hasWebGpu = adapter !== null
    } catch {
      hasWebGpu = false
    }
  }

  if (hasWebGpu) {
    try {
      const webgpuMod = await import('three/webgpu')
      const r = new webgpuMod.WebGPURenderer({ canvas, antialias: true })
      await r.init()
      renderer = r as unknown as THREE.WebGLRenderer
      backend = 'webgpu'
    } catch (err) {
      console.warn('[renderer] WebGPU init failed, falling back to WebGL2', err)
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
      backend = 'webgl2'
    }
  } else {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    backend = 'webgl2'
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight, false)

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
