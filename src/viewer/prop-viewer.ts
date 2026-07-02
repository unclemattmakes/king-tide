/**
 * Stand-alone prop viewer — the validation + tuning bench for the painterly-vinyl
 * look. Triggered by `?propviewer=<assetId>` (or `?propviewer=1` for the first
 * catalogue prop). No game boot — one prop on a neutral studio stage with an
 * orbit camera and live material controls (sliders + number inputs). The thing
 * `?track=prop-showcase` (a race spline through a chase cam) can't do. See
 * docs/painterly-vinyl-pipeline.md.
 *
 * Static camera + a `document.body.dataset.propViewerReady` signal so a capture
 * harness (or a screenshot) gets a clean frame. Keys (convenience): V raw/vinyl,
 * W waterline, R turntable, arrow-left/right prev/next prop. Material params are
 * tuned with the on-screen sliders, not hotkeys.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { assetUrl } from '../engine/asset-url'
import {
  buildVinylMaterial,
  ensureNeutralTintAttribute,
  type VinylOptions,
  vinylTintAttribute,
} from '../engine/render/painterly-vinyl-material'
import { createRenderer } from '../engine/render/renderer'
import { cloneLoadedProp, type LoadedProp, loadProp } from '../game/assets/prop-loader'

type ViewerOpts = { propId: string | null }

/** One visual mesh of the mounted prop + its raw and vinyl material twins. */
type MeshMat = { mesh: THREE.Mesh; original: THREE.Material; vinyl: THREE.Material }

type ViewerUI = {
  info: HTMLElement
  chips: HTMLElement
  controls: HTMLElement
  list: HTMLElement
}

/** The curated validation set already lives in this track JSON (cc0/* refs). */
const PROP_SHOWCASE_URL = '/tracks/prop-showcase.json'

/** Recursively collect unique `assetId`s of `type:'asset'` props from a track
 *  JSON, regardless of nesting. */
function collectAssetIds(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const v of node) collectAssetIds(v, out)
    return
  }
  const o = node as Record<string, unknown>
  if (o.type === 'asset' && typeof o.assetId === 'string') out.add(o.assetId)
  for (const k in o) collectAssetIds(o[k], out)
}

export async function bootPropViewer(parent: HTMLElement, opts: ViewerOpts): Promise<void> {
  // `?thumb=1` strips the studio grid + the whole HUD so a capture harness
  // (`pnpm gen:prop-sheets`) gets a clean, chrome-free tile — same convention
  // the bike viewer uses for `pnpm gen:bike-thumbs`. Nobody hand-types it.
  const thumbMode = new URLSearchParams(window.location.search).get('thumb') === '1'

  // ── Catalogue ──────────────────────────────────────────────────────────────
  const ids = new Set<string>()
  try {
    const data = await fetch(PROP_SHOWCASE_URL).then((r) => r.json())
    collectAssetIds(data, ids)
  } catch {
    /* fall through to whatever propId we were handed */
  }
  if (opts.propId) ids.add(opts.propId)
  const catalogue = [...ids].sort()
  if (catalogue.length === 0) {
    parent.innerHTML =
      '<div style="padding:24px;color:#fff;font-family:system-ui">No props found — expected ' +
      '<code>cc0/*</code> assets in <code>public/tracks/prop-showcase.json</code>.</div>'
    return
  }
  let index = Math.max(0, opts.propId ? catalogue.indexOf(opts.propId) : 0)

  // ── Scene + renderer (real WebGPU pipeline, same as the bike viewer) ─────────
  const { renderer, backend, canvas, resize } = await createRenderer(parent)
  requestAnimationFrame(resize)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x555a61) // neutral studio grey

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 500)
  camera.position.set(6, 4, 6)

  // Neutral studio lighting — true-ish white key + cool fill + a back-rim.
  scene.add(new THREE.HemisphereLight(0xc8d4e2, 0x35302a, 1.0))
  const keyLight = new THREE.DirectionalLight(0xfff2e0, 1.5)
  keyLight.position.set(4, 6, 3)
  scene.add(keyLight)
  const fillLight = new THREE.DirectionalLight(0x90a0b8, 0.5)
  fillLight.position.set(-5, 2, -3)
  scene.add(fillLight)
  const backLight = new THREE.DirectionalLight(0xfff0d8, 0.6)
  backLight.position.set(-2, 3, -6)
  scene.add(backLight)

  if (!thumbMode) scene.add(new THREE.GridHelper(40, 40, 0x4a86c4, 0x2a3340))

  const orbit = new OrbitControls(camera, canvas)
  orbit.enableDamping = true
  orbit.dampingFactor = 0.08
  orbit.minDistance = 0.4
  orbit.maxDistance = 200

  // ── State ────────────────────────────────────────────────────────────────────
  let node: THREE.Object3D | null = null
  let meshMats: MeshMat[] = []
  let mode: 'raw' | 'vinyl' = 'vinyl'
  let turntable = false
  let waterline = false
  let waterPlane: THREE.Mesh | null = null
  let category = ''
  const vinylOpts: VinylOptions = {
    rimStrength: 0.5,
    weathering: 0.12,
    brush: 0.7,
    brushScale: 0.12,
    waterline: 0,
    waterLevel: 0,
    waterlineTide: 0.4,
    waterlineAlgae: 0.5,
    propSize: 4,
    edgeWear: 0.66,
  }

  const ui = makeUI(parent, backend, thumbMode)

  // ── Material handling ──────────────────────────────────────────────────────
  /** Vinyl twin for one source material, honouring the dedupe tool's
   *  tint-canonical marker — a marked material's albedo lives in a baked
   *  per-vertex attribute (the flat colour is white), so the twin must read
   *  it or the prop renders white (see painterly-vinyl-material.ts). Spreads
   *  `vinylOpts` at call time so the live sliders keep applying. */
  function buildVinylFor(original: THREE.Material): THREE.Material {
    const tintAttr = vinylTintAttribute(original)
    return buildVinylMaterial(
      original,
      tintAttr ? { ...vinylOpts, tintAttribute: tintAttr } : vinylOpts,
    )
  }

  function applyMode(): void {
    for (const mm of meshMats) mm.mesh.material = mode === 'vinyl' ? mm.vinyl : mm.original
  }

  function rebuildVinyl(): void {
    for (const mm of meshMats) {
      mm.vinyl.dispose()
      mm.vinyl = buildVinylFor(mm.original)
    }
    applyMode()
  }

  function disposeNode(): void {
    if (!node) return
    scene.remove(node)
    // Dispose only the vinyl twins we created — `cloneLoadedProp` shares the
    // ORIGINAL materials by reference with the cached LoadedProp.
    for (const mm of meshMats) mm.vinyl.dispose()
    meshMats = []
    node = null
  }

  function frameNode(): void {
    if (!node) return
    node.updateMatrixWorld(true)
    const bbox = new THREE.Box3().setFromObject(node)
    const size = new THREE.Vector3()
    bbox.getSize(size)
    const center = new THREE.Vector3()
    bbox.getCenter(center)
    const radius = Math.max(size.x, size.y, size.z, 0.5) * 0.5
    orbit.target.copy(center)
    // Thumb mode (capture harness) frames tighter so the prop fills ~70% of the
    // tile; interactive mode keeps the roomier studio view for socket eyeballing.
    const dist = thumbMode ? radius * 2.2 : radius * 3.2 + 1
    camera.position.set(center.x + dist, center.y + dist * 0.55, center.z + dist)
    camera.near = Math.max(0.01, radius * 0.04)
    camera.far = radius * 60 + 100
    camera.updateProjectionMatrix()
    orbit.update()
    // Park the waterline across the lower third of the prop for validation.
    vinylOpts.waterLevel = bbox.min.y + size.y * 0.35
    // Scale brush strokes + waterline band to this prop's real size (propSize).
    vinylOpts.propSize = Math.max(size.x, size.y, size.z, 0.05)
  }

  function syncWaterline(): void {
    if (waterPlane) {
      scene.remove(waterPlane)
      waterPlane.geometry.dispose()
      ;(waterPlane.material as THREE.Material).dispose()
      waterPlane = null
    }
    vinylOpts.waterline = waterline ? 1.0 : 0
    if (waterline && node) {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(80, 80),
        new THREE.MeshBasicMaterial({ color: 0x2aa9c0, transparent: true, opacity: 0.18 }),
      )
      plane.rotation.x = -Math.PI / 2
      plane.position.y = vinylOpts.waterLevel ?? 0
      scene.add(plane)
      waterPlane = plane
    }
    rebuildVinyl()
  }

  async function show(id: string): Promise<void> {
    disposeNode()
    let loaded: LoadedProp
    try {
      loaded = await loadProp(assetUrl(`/assets/props/${id}.glb`))
    } catch (e) {
      ui.info.innerHTML = `<b>${id}</b><br><span style="color:#ff8a7a">load failed: ${(e as Error).message}</span>`
      return
    }
    category = loaded.extras.category
    node = cloneLoadedProp(loaded)
    meshMats = []
    node.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh || !mesh.geometry) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const original = mats[0] as THREE.Material
      if (!original) return
      // Guard the tint lane: an absent baked attribute reads 0 (black) — the
      // GLB guarantees it, this covers geometry assembled outside the tool.
      const tintAttr = vinylTintAttribute(original)
      if (tintAttr) ensureNeutralTintAttribute(mesh.geometry as THREE.BufferGeometry, tintAttr)
      meshMats.push({ mesh, original, vinyl: buildVinylFor(original) })
    })
    scene.add(node)
    frameNode()
    syncWaterline() // applies waterline strength + rebuilds vinyl + applies mode
    // Publish the prop's measured bbox so a capture harness can label each
    // sheet cell without re-parsing the GLB (consumed by gen-prop-sheets).
    if (node) {
      const b = new THREE.Box3().setFromObject(node)
      const s = new THREE.Vector3()
      b.getSize(s)
      document.body.dataset.propBbox = `${s.x.toFixed(2)}×${s.y.toFixed(2)}×${s.z.toFixed(2)}`
      document.body.dataset.propCategory = category
    }
    renderInfo()
    const url = new URL(window.location.href)
    url.searchParams.set('propviewer', id)
    window.history.replaceState({}, '', url.toString())
  }

  function step(delta: number): void {
    index = (index + delta + catalogue.length) % catalogue.length
    void show(catalogue[index]!)
  }

  // ── Header / chips / prop-list (re-rendered; the sliders are persistent) ─────
  function renderInfo(): void {
    const id = catalogue[index] ?? '—'
    let bboxStr = '—'
    if (node) {
      const b = new THREE.Box3().setFromObject(node)
      const s = new THREE.Vector3()
      b.getSize(s)
      bboxStr = `${s.x.toFixed(2)} × ${s.y.toFixed(2)} × ${s.z.toFixed(2)} m`
    }
    ui.info.innerHTML = `
      <div style="font-size:14px;font-weight:600;margin-bottom:6px">${id} <span style="color:#7a8696;font-weight:400">· ${index + 1}/${catalogue.length}</span></div>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;color:#bcc7d4">
        <div>category</div><div>${category || '—'}</div>
        <div>bbox</div><div>${bboxStr}</div>
      </div>`

    ui.chips.replaceChildren()
    const chip = (label: string, on: boolean, onClick: () => void) => {
      const b = document.createElement('button')
      b.textContent = label
      b.style.cssText = [
        'padding:3px 9px',
        'border-radius:4px',
        'cursor:pointer',
        'font:12px system-ui,sans-serif',
        `border:1px solid ${on ? '#5cf2ff' : '#2a3340'}`,
        `background:${on ? '#16242c' : '#1a2028'}`,
        `color:${on ? '#dff7ff' : '#8a96a6'}`,
      ].join(';')
      b.addEventListener('click', onClick)
      ui.chips.appendChild(b)
    }
    chip(mode === 'vinyl' ? 'VINYL' : 'RAW', true, () => {
      mode = mode === 'vinyl' ? 'raw' : 'vinyl'
      applyMode()
      renderInfo()
    })
    chip('waterline', waterline, () => {
      waterline = !waterline
      syncWaterline()
      renderInfo()
    })
    chip('turntable', turntable, () => {
      turntable = !turntable
      renderInfo()
    })

    ui.list.replaceChildren()
    catalogue.forEach((cid, i) => {
      const btn = document.createElement('button')
      btn.textContent = cid.replace(/^cc0\//, '')
      btn.style.cssText = [
        'padding:3px 7px',
        `border:1px solid ${i === index ? '#5cf2ff' : '#2a3340'}`,
        `background:${i === index ? '#16242c' : '#1a2028'}`,
        'color:#dde6ee',
        'border-radius:4px',
        'cursor:pointer',
        'font:11px system-ui,sans-serif',
      ].join(';')
      btn.addEventListener('click', () => {
        index = i
        void show(cid)
      })
      ui.list.appendChild(btn)
    })
  }

  // ── Material sliders (built once; live-rebuild on input) ─────────────────────
  sliderRow(
    ui.controls,
    'rim',
    0,
    1,
    0.02,
    () => vinylOpts.rimStrength ?? 0,
    (v) => {
      vinylOpts.rimStrength = v
      rebuildVinyl()
    },
  )
  sliderRow(
    ui.controls,
    'weather',
    0,
    1,
    0.02,
    () => vinylOpts.weathering ?? 0,
    (v) => {
      vinylOpts.weathering = v
      rebuildVinyl()
    },
  )
  sliderRow(
    ui.controls,
    'brush',
    0,
    1,
    0.02,
    () => vinylOpts.brush ?? 0,
    (v) => {
      vinylOpts.brush = v
      rebuildVinyl()
    },
  )
  sliderRow(
    ui.controls,
    'stroke',
    0.02,
    1,
    0.01,
    () => vinylOpts.brushScale ?? 0.12,
    (v) => {
      vinylOpts.brushScale = v
      rebuildVinyl()
    },
  )
  sliderRow(
    ui.controls,
    'tide',
    0.2,
    10,
    0.1,
    () => vinylOpts.waterlineTide ?? 3,
    (v) => {
      vinylOpts.waterlineTide = v
      rebuildVinyl()
    },
  )
  sliderRow(
    ui.controls,
    'algae',
    0,
    1,
    0.02,
    () => vinylOpts.waterlineAlgae ?? 0.5,
    (v) => {
      vinylOpts.waterlineAlgae = v
      rebuildVinyl()
    },
  )
  sliderRow(
    ui.controls,
    'edge',
    0,
    1,
    0.02,
    () => vinylOpts.edgeWear ?? 0,
    (v) => {
      vinylOpts.edgeWear = v
      rebuildVinyl()
    },
  )

  // ── Input (toggles + prop nav only; params are sliders now) ──────────────────
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return // let number fields take typing
    switch (e.key) {
      case 'v':
      case 'V':
        mode = mode === 'vinyl' ? 'raw' : 'vinyl'
        applyMode()
        renderInfo()
        break
      case 'w':
      case 'W':
        waterline = !waterline
        syncWaterline()
        renderInfo()
        break
      case 'r':
      case 'R':
        turntable = !turntable
        renderInfo()
        break
      case 'ArrowRight':
        step(1)
        break
      case 'ArrowLeft':
        step(-1)
        break
    }
  })

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
  })

  // ── Render loop ──────────────────────────────────────────────────────────────
  const clock = new THREE.Clock()
  let frames = 0
  const tick = (): void => {
    const dt = Math.min(clock.getDelta(), 0.05)
    if (turntable && node) node.rotation.y += dt * 0.5
    orbit.update()
    renderer.render(scene, camera)
    frames++
    if (frames >= 2 && node) document.body.dataset.propViewerReady = '1'
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  await show(catalogue[index]!)
}

/** Build the persistent HUD scaffold (info + chips + controls + prop list) and
 *  the bottom-right help card. In `thumbMode` the scaffold is still built (so
 *  the rest of the viewer's wiring is unchanged) but both cards are hidden, so
 *  a capture tile is just the prop on the studio background. */
function makeUI(parent: HTMLElement, backend: string, thumbMode = false): ViewerUI {
  const hud = document.createElement('div')
  hud.style.cssText = [
    'position:fixed',
    'left:12px',
    'top:12px',
    'width:286px',
    'max-height:calc(100vh - 24px)',
    'overflow:auto',
    'padding:14px 16px',
    'background:rgba(20,24,32,0.9)',
    'color:#e0e6ee',
    'font:13px/1.4 system-ui,sans-serif',
    'border-radius:8px',
    'z-index:10',
  ].join(';')

  const info = document.createElement('div')
  const chips = document.createElement('div')
  chips.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:10px 0'
  const ctrlTitle = document.createElement('div')
  ctrlTitle.textContent = 'material'
  ctrlTitle.style.cssText = 'color:#7a8696;border-top:1px solid #2a3340;padding-top:8px'
  const controls = document.createElement('div')
  controls.style.cssText = 'margin:4px 0'
  const listTitle = document.createElement('div')
  listTitle.textContent = 'props'
  listTitle.style.cssText =
    'color:#7a8696;border-top:1px solid #2a3340;padding-top:8px;margin-top:4px'
  const list = document.createElement('div')
  list.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:4px'

  hud.append(info, chips, ctrlTitle, controls, listTitle, list)
  parent.appendChild(hud)

  const help = document.createElement('div')
  help.style.cssText = [
    'position:fixed',
    'right:12px',
    'bottom:12px',
    'padding:8px 12px',
    'background:rgba(20,24,32,0.7)',
    'color:#9aa6b6',
    'font:11px/1.6 system-ui,sans-serif',
    'border-radius:6px',
    'z-index:10',
  ].join(';')
  help.innerHTML =
    'orbit: drag · zoom: scroll · sliders to tune<br>' +
    '<b>V</b> raw/vinyl · <b>W</b> waterline · <b>R</b> turntable · <b>&larr;/&rarr;</b> prop<br>' +
    `backend: <b>${backend}</b>`
  parent.appendChild(help)

  if (thumbMode) {
    hud.style.display = 'none'
    help.style.display = 'none'
  }

  return { info, chips, controls, list }
}

/** A labelled slider + number input bound to a getter/setter. The setter runs on
 *  every change (live material rebuild); the two inputs stay in sync. */
function sliderRow(
  parent: HTMLElement,
  label: string,
  min: number,
  max: number,
  step: number,
  get: () => number,
  set: (v: number) => void,
): void {
  const row = document.createElement('div')
  row.style.cssText =
    'display:grid;grid-template-columns:54px 1fr 50px;gap:6px;align-items:center;margin:5px 0'

  const lab = document.createElement('span')
  lab.textContent = label
  lab.style.cssText = 'color:#9aa6b6;font-size:12px'

  const range = document.createElement('input')
  range.type = 'range'
  range.min = `${min}`
  range.max = `${max}`
  range.step = `${step}`
  range.value = `${get()}`
  range.style.width = '100%'

  const num = document.createElement('input')
  num.type = 'number'
  num.min = `${min}`
  num.max = `${max}`
  num.step = `${step}`
  num.value = `${get()}`
  num.style.cssText =
    'width:46px;background:#11161c;border:1px solid #2a3340;color:#dde6ee;border-radius:4px;font:11px system-ui;padding:2px 4px'

  const apply = (raw: number) => {
    if (Number.isNaN(raw)) return
    const v = Math.min(max, Math.max(min, raw))
    set(v)
    range.value = `${v}`
    num.value = `${v}`
  }
  range.addEventListener('input', () => apply(parseFloat(range.value)))
  num.addEventListener('change', () => apply(parseFloat(num.value)))

  row.append(lab, range, num)
  parent.appendChild(row)
}
