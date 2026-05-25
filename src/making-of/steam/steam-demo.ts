import * as THREE from 'three'
import {
  advanceWaveField,
  createWaveField,
  defaultWaves,
  sampleSurface,
} from '@/engine/sim/water/wave-field'
import { createDemoHarness } from '../shared/demo-harness'
import { buildWaterGrid } from '../shared/scene-bits'
import { el, panel, readout, toggle } from '../shared/ui'

/**
 * Chapter 06 demo: "what is your machine running?" A live capability probe
 * — WebGPU adapter, secure context, the WebGL2 GPU string — over a live
 * water backdrop. It's the exact set of checks the port turned on: the
 * Tauri/WebKitGTK shell on the Deck failed the secure-context + WebGPU
 * ones and silently fell back to WebGL2; Electron's bundled Chromium
 * passes them.
 *
 * The backdrop renders on WebGL2 (the demo's renderer), with a toggle that
 * swaps a richer look for a flat one — an *impression* of the fidelity the
 * fallback cost, not a real WebGPU/WebGL2 A/B.
 */

type GpuNavigator = Navigator & {
  gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string } } | null> }
}

export function mountSteamDemo(stage: HTMLElement, controlsHost: HTMLElement): () => void {
  const harness = createDemoHarness(stage, {
    cameraPos: [0, 14, 26],
    target: [0, 0, 0],
    fov: 52,
    background: 0x081320,
  })
  const { scene } = harness

  scene.add(new THREE.HemisphereLight(0x9fc8ff, 0x0a2030, 0.85))
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.6)
  sun.position.set(-16, 14, 20)
  scene.add(sun)

  // Calm water backdrop, driven by the real wave sampler.
  const field = createWaveField(
    defaultWaves().map((w) => ({ ...w, amplitude: w.amplitude * 0.55 })),
    { baseY: 0 },
  )
  const seg = window.matchMedia('(max-width: 720px)').matches ? 72 : 120
  const geo = buildWaterGrid(seg, 64)
  const richMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.3,
    metalness: 0.05,
  })
  const flatMat = new THREE.MeshStandardMaterial({
    color: 0x18506a,
    roughness: 0.85,
    flatShading: true,
  })
  const water = new THREE.Mesh(geo, richMat)
  scene.add(water)
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute
  const normAttr = geo.getAttribute('normal') as THREE.BufferAttribute
  const colAttr = geo.getAttribute('color') as THREE.BufferAttribute
  const baseXZ = (geo.userData.baseXZ as Float32Array) ?? new Float32Array()
  const vertCount = posAttr.count
  const deep = new THREE.Color(0x05303f)
  const crest = new THREE.Color(0x66e8ff)
  const scratch = new THREE.Color()

  // Stage badge naming the active render path.
  const badge = el('div', { class: 'mo-badge' }, ['Rendering on WebGL2'])
  stage.append(badge)

  // ── Capability probe panel ────────────────────────────────────────────
  const webgpuOut = readout('WebGPU')
  const secureOut = readout('Secure context')
  const glOut = readout('WebGL2 GPU')
  const deckOut = readout('SteamDeck UA token')

  controlsHost.append(
    panel('What your browser reports', [
      webgpuOut.node,
      secureOut.node,
      glOut.node,
      deckOut.node,
      el('p', { class: 'mo-ctrl-hint' }, [
        'These are the checks the port turned on. On the Deck, Tauri/WebKitGTK failed the WebGPU one and fell back to WebGL2; Electron passes it.',
      ]),
    ]),
    panel('The fidelity the fallback cost', [
      toggle({
        label: 'Show the lean fallback look',
        value: false,
        onChange: (v) => {
          water.material = v ? flatMat : richMat
        },
      }),
      el('p', { class: 'mo-ctrl-hint' }, [
        'An impression, not a real A/B — the demo always renders on WebGL2. But losing the modern GPU path means losing the lighting and detail the water was authored for.',
      ]),
    ]),
  )

  // Secure context + WebGL2 string are synchronous.
  secureOut.set(window.isSecureContext ? 'yes ✓' : 'no')
  glOut.set(readGl2Renderer())
  deckOut.set(/\bSteamDeck\b/.test(navigator.userAgent) ? 'present' : 'absent (normal browser)')

  // WebGPU adapter is async; report once it resolves.
  webgpuOut.set('checking…')
  let disposed = false
  const nav = navigator as GpuNavigator
  if (!nav.gpu) {
    webgpuOut.set('not available')
  } else {
    nav.gpu
      .requestAdapter()
      .then((adapter) => {
        if (disposed) return
        if (!adapter) {
          webgpuOut.set('navigator.gpu present, no adapter')
          return
        }
        const v = adapter.info?.vendor
        webgpuOut.set(v ? `available ✓ (${v})` : 'available ✓')
      })
      .catch(() => {
        if (!disposed) webgpuOut.set('probe failed')
      })
  }

  const unsub = harness.onFrame((dt) => {
    advanceWaveField(field, dt)
    for (let i = 0; i < vertCount; i++) {
      const x = baseXZ[i * 2] ?? 0
      const z = baseXZ[i * 2 + 1] ?? 0
      const s = sampleSurface(field, x, z)
      posAttr.setY(i, s.y)
      normAttr.setXYZ(i, s.nx, s.ny, s.nz)
      const t = THREE.MathUtils.clamp(0.5 + s.y / 1.6, 0, 1)
      scratch.copy(deep).lerp(crest, t)
      colAttr.setXYZ(i, scratch.r, scratch.g, scratch.b)
    }
    posAttr.needsUpdate = true
    normAttr.needsUpdate = true
    colAttr.needsUpdate = true
  })

  return () => {
    disposed = true
    unsub()
    harness.dispose()
    geo.dispose()
    richMat.dispose()
    flatMat.dispose()
    badge.remove()
  }
}

function readGl2Renderer(): string {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2')
  if (!gl) return 'WebGL2 unavailable'
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  const raw = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  const s = typeof raw === 'string' ? raw : 'unknown'
  return s.length > 38 ? `${s.slice(0, 36)}…` : s
}
