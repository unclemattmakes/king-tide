import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { playerSettings } from '@/engine/player-settings'
import { detectSteamDeck } from '@/engine/steam-deck'
import {
  QUALITY_PRESETS,
  type QualityPreset,
  resolveQuality,
  setActiveQuality,
} from './quality-preset'

export type RenderBackend = 'webgpu' | 'webgl2'

export type RendererBundle = {
  renderer: THREE.WebGLRenderer
  backend: RenderBackend
  canvas: HTMLCanvasElement
  /**
   * True when the renderer was constructed with GPU timestamp tracking
   * enabled (`?gpuprofile=1` on a WebGPU backend whose adapter advertises
   * the `timestamp-query` feature). Boot code uses this to decide whether to
   * spin up the GPU-time profiler. False on the WebGL2 fallback, when the
   * feature is absent, or when the flag wasn't requested.
   */
  gpuTimestampsTracked: boolean
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

  const params = new URLSearchParams(window.location.search)

  // `?backend=webgl2|webgpu|auto` overrides the adapter probe so the desktop
  // build can be poked at WebGL2 / WebGPU on a single deployed depot — useful
  // when the only iteration loop is "push to Steam, launch on device." The
  // electron wrapper bridges `HOVERBIKE_BACKEND=…` from Steam launch options
  // into this same query string. `auto` (the default) takes the probe path.
  const backendOverride = params.get('backend')
  const wantWebGpu = backendOverride !== 'webgl2'
  const forceWebGpu = backendOverride === 'webgpu'

  let hasWebGpu = false
  let hasTimestampQuery = false
  let adapterInfo: GPUAdapterInfo | null = null
  if (wantWebGpu && 'gpu' in navigator) {
    try {
      const adapter = await navigator.gpu!.requestAdapter()
      hasWebGpu = adapter !== null
      if (adapter) {
        // `timestamp-query` is the optional WebGPU feature that backs the
        // GPU-time profiler. Only probe it here; we only *request* it (via
        // `trackTimestamp`) when `?gpuprofile=1` is set, to avoid asking for
        // a feature the device might charge for on every boot.
        hasTimestampQuery = adapter.features.has('timestamp-query')
        // GPUAdapter.info is the current spec; older Chromium exposes
        // requestAdapterInfo(). Try both, ignore errors — we only use this
        // for the boot log, not for any code path.
        type LegacyAdapter = GPUAdapter & { requestAdapterInfo?(): Promise<GPUAdapterInfo> }
        const a = adapter as LegacyAdapter
        adapterInfo = a.info ?? (a.requestAdapterInfo ? await a.requestAdapterInfo() : null)
      }
    } catch (e) {
      console.warn('[render] requestAdapter threw:', e)
      hasWebGpu = false
    }
  }
  if (forceWebGpu && !hasWebGpu) {
    console.warn(
      '[render] ?backend=webgpu requested but no adapter available — falling back to webgl2',
    )
  }

  // Resolve the quality tier NOW — this is the first place the real backend
  // is known, and the later-constructed systems (scene shadow map, sky post,
  // water) read the published knobs. `?quality=<tier>` overrides the
  // persisted preset for a single boot (testing + the ablation kit); `auto`
  // picks a tier from backend + Deck detection (see quality-preset.ts).
  const tierBackend: RenderBackend = hasWebGpu ? 'webgpu' : 'webgl2'
  const quretParam = params.get('quality')
  const preset: QualityPreset = QUALITY_PRESETS.includes(quretParam as QualityPreset)
    ? (quretParam as QualityPreset)
    : playerSettings.qualityPreset
  const { tier, knobs } = resolveQuality(preset, {
    backend: tierBackend,
    isDeck: detectSteamDeck().isLikelyDeck,
  })
  setActiveQuality(tier, knobs)
  console.info(`[render] quality: ${preset}${preset === 'auto' ? ` → ${tier}` : ''}`)

  // MSAA — a multisampled colour attachment on WebGPU, 2–4× main-pass
  // bandwidth. `?aa=off|on` forces it (ablation + debug shots); otherwise
  // the resolved tier decides (off below High).
  const antialias = params.has('aa') ? params.get('aa') !== 'off' : knobs.msaa

  // `?gpuprofile=1` opts into per-frame GPU timestamp tracking so the
  // GPU-time profiler (gpu-profiler.ts) can read `renderer.info.*.timestamp`.
  // Only honoured on a real WebGPU backend whose adapter supports
  // `timestamp-query`; otherwise it's a silent no-op and we leave tracking
  // off. Passing `trackTimestamp: true` makes recent three request the
  // device feature itself when it initialises the backend.
  const gpuProfileRequested = params.get('gpuprofile') === '1'
  const gpuTimestampsTracked = gpuProfileRequested && hasWebGpu && hasTimestampQuery
  if (gpuProfileRequested && !gpuTimestampsTracked) {
    console.warn(
      '[render] ?gpuprofile=1 requested but GPU timestamps unavailable ' +
        `(webgpu=${hasWebGpu} timestamp-query=${hasTimestampQuery}) — profiler disabled`,
    )
  }

  const r = new WebGPURenderer({
    canvas,
    antialias,
    forceWebGL: !hasWebGpu,
    trackTimestamp: gpuTimestampsTracked,
  })
  await r.init()

  // WebGPURenderer is API-compatible with WebGLRenderer for our usage
  // (setSize, setPixelRatio, render, dispose). The cast keeps the existing
  // type signature stable for the rest of the engine.
  const renderer = r as unknown as THREE.WebGLRenderer
  const backend: RenderBackend = hasWebGpu ? 'webgpu' : 'webgl2'
  // Surface the active backend in the console so it's visible in logs when
  // there's no on-screen HUD pill (e.g. diagnosing the desktop/Steam build).
  const reason = backendOverride ? ` (override=${backendOverride})` : ''
  console.info(`[render] backend: ${backend}${reason}`)
  if (hasWebGpu && adapterInfo) {
    // Vendor / architecture / device strings let an on-device log distinguish
    // a native Chromium WebGPU adapter from a translation layer (e.g.
    // VKD3D-Proton presenting D3D12 over host Vulkan). Both fields are
    // optional per spec, so log whichever the runtime fills in.
    console.info(
      `[render] adapter: vendor=${adapterInfo.vendor || '?'} ` +
        `architecture=${adapterInfo.architecture || '?'} ` +
        `device=${adapterInfo.device || '?'} ` +
        `description=${adapterInfo.description || '?'}`,
    )
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight, false)

  // Soft directional-sun shadows. Casters/receivers are flagged on each
  // mesh by the systems that build them (bike clones, props, terrain).
  // Water is intentionally excluded — its node-material shader drives its
  // own lighting and we don't want the surface mottled by shadow maps.
  // `?shadows=0|1` forces the whole shadow pass (sun depth render + PCF
  // taps) — the frame-ablation axis; otherwise the resolved tier decides
  // (off on Low — the measured +19–27 fps lever).
  renderer.shadowMap.enabled = params.has('shadows') ? params.get('shadows') !== '0' : knobs.shadows
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

  return { renderer, backend, canvas, gpuTimestampsTracked, resize, dispose }
}

/**
 * One-shot probe of the unmasked GPU renderer string via a throwaway WebGL2
 * context. Surfaces what the driver actually is so the perf HUD can tell
 * hardware from software: "AMD Custom GPU … (RADV …)" is the Deck's real GPU,
 * whereas "llvmpipe" / "softpipe" means software rasterisation — the perf
 * cliff to watch for when WebKitGTK can't reach the hardware EGL path.
 *
 * Returns 'unknown' with no context, 'masked' when the debug extension is
 * blocked. Loses the context immediately so we don't leak a GL slot.
 */
export function probeGpuRenderer(): string {
  if (typeof document === 'undefined') return 'unknown'
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return 'unknown'
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const value = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return value || 'masked'
  } catch {
    return 'unknown'
  }
}
