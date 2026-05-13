/**
 * Stand-alone bike viewer for kit-vs-build verification.
 *
 * Triggered by `?viewer=<bikeId>` (or `?viewer=1` for the manifest's
 * first entry). Skips the entire game boot — no track, no physics, no
 * AI, no audio. Just renders one bike on a turntable so authors can
 * eyeball it against `tools/blender/lib/bike_parts.blend`.
 *
 * What's intentionally **not** stripped (unlike normal gameplay
 * rendering): sockets and collider proxies stay visible so the viewer
 * doubles as a "where do attach points actually land?" inspector.
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createRenderer } from '../engine/render/renderer'
import { type LoadedBike, loadBike } from '../game/assets/bike-loader'
import { type AssetManifest, type BikeManifestEntry, loadManifest } from '../game/assets/manifest'

type ViewerOpts = {
  /** Bike id from the manifest, or null to use the first manifest entry. */
  bikeId: string | null
}

type Refs = {
  manifest: AssetManifest
  current: BikeManifestEntry
  loaded: LoadedBike
  hud: HTMLElement
  bikeNode: THREE.Object3D
  axesGroup: THREE.Group
  scene: THREE.Scene
}

export async function bootBikeViewer(parent: HTMLElement, opts: ViewerOpts): Promise<void> {
  const manifest = await loadManifest()
  // Empty-check + a local that the compiler tracks as defined (the
  // length check alone doesn't narrow ``manifest.bikes[0]`` under
  // ``noUncheckedIndexedAccess``).
  const firstBike = manifest.bikes[0]
  if (!firstBike) {
    parent.innerHTML =
      '<div style="padding:24px;color:#fff;font-family:system-ui">No bikes in the manifest. ' +
      'Run <code>pnpm gen:bikes</code> first.</div>'
    return
  }

  const initialId = opts.bikeId ?? firstBike.id
  const current: BikeManifestEntry = manifest.bikes.find((b) => b.id === initialId) ?? firstBike

  // ── Scene + renderer ─────────────────────────────────────────────────────
  const { renderer, backend, canvas, resize } = await createRenderer(parent)

  // Iframe-hosted previews (and some headless browsers) report
  // ``window.innerWidth/Height`` as 0 inside ``createRenderer``'s
  // synchronous setSize call; re-poll after the next frame so the
  // canvas picks up real dimensions before render starts.
  requestAnimationFrame(resize)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x1a1d22)

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 200)
  camera.position.set(2.5, 1.4, 2.5)
  camera.lookAt(0, 0.3, 0)

  // Soft studio lighting — neutral so livery colors read correctly.
  scene.add(new THREE.HemisphereLight(0xc0d0e0, 0x202028, 0.9))
  const key = new THREE.DirectionalLight(0xffffff, 1.2)
  key.position.set(3, 5, 4)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0x8090a0, 0.4)
  fill.position.set(-4, 2, -2)
  scene.add(fill)

  // Reference grid + axes. Grid lives at y = 0 (chassis bottom), axes
  // at origin. Helps eyeball "is this the right pose?" / "is the
  // chassis where the spec says it should be?".
  const grid = new THREE.GridHelper(10, 20, 0x4488cc, 0x223344)
  grid.position.y = 0
  scene.add(grid)
  const axes = new THREE.AxesHelper(0.6)
  scene.add(axes)

  // Container for the bike + the per-bike axes (shown at bike root).
  const axesGroup = new THREE.Group()

  const orbit = new OrbitControls(camera, canvas)
  orbit.target.set(0, 0.3, 0)
  orbit.enableDamping = true
  orbit.dampingFactor = 0.08
  orbit.minDistance = 0.5
  orbit.maxDistance = 20

  // ── HUD ──────────────────────────────────────────────────────────────────
  const hud = document.createElement('div')
  hud.style.cssText = [
    'position:fixed',
    'left:12px',
    'top:12px',
    'padding:14px 18px',
    'background:rgba(20,24,32,0.85)',
    'color:#e0e6ee',
    'font:13px/1.4 system-ui,sans-serif',
    'border-radius:8px',
    'min-width:240px',
    'z-index:10',
    'user-select:text',
  ].join(';')
  parent.appendChild(hud)

  const helpHud = document.createElement('div')
  helpHud.style.cssText = [
    'position:fixed',
    'right:12px',
    'bottom:12px',
    'padding:8px 12px',
    'background:rgba(20,24,32,0.7)',
    'color:#9aa6b6',
    'font:11px/1.5 system-ui,sans-serif',
    'border-radius:6px',
    'z-index:10',
  ].join(';')
  helpHud.innerHTML =
    'orbit: drag · pan: shift+drag · zoom: scroll · backend: <b>' + backend + '</b>'
  parent.appendChild(helpHud)

  // Initial load.
  const loaded = await loadBike(current.url)
  const bikeNode = mountBike(scene, axesGroup, loaded)
  scene.add(axesGroup)

  const refs: Refs = { manifest, current, loaded, hud, bikeNode, axesGroup, scene }
  renderHud(refs, (id) => switchBike(refs, id))

  // ── Render loop ──────────────────────────────────────────────────────────
  const tick = () => {
    orbit.update()
    renderer.render(scene, camera)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
  })
}

/** Add bike root to scene, surface sockets + colliders, return the
 * cloned root so it can be replaced on switch. */
function mountBike(scene: THREE.Scene, axesGroup: THREE.Group, loaded: LoadedBike): THREE.Object3D {
  const node = loaded.root.clone(true)

  // Counter the build's yup-export so the kit's Blender axes match the
  // viewer's reference grid (Blender +Y / +Z conventions). The runtime
  // game does its own per-frame transform, so this is viewer-only.
  // Without this the bike sits with its Blender +Z (in-game forward)
  // pointing at the camera, which is fine — keep it as authored.

  // Make sockets and collider proxies VISIBLE so authors can see
  // attach points. The default bike-loader path hides them; we want
  // them on screen here.
  node.traverse((obj) => {
    obj.visible = true
  })

  // Visualize sockets as small spheres + a label-friendly axes helper
  // each. Walk the tree once; sockets are tagged via userData.kind.
  const socketGeo = new THREE.SphereGeometry(0.04, 12, 8)
  const socketMat = new THREE.MeshBasicMaterial({ color: 0x66ff99 })
  const colliderEdgeMat = new THREE.LineBasicMaterial({ color: 0xffaa33 })
  node.traverse((obj) => {
    if (obj.userData?.kind === 'socket') {
      const dot = new THREE.Mesh(socketGeo, socketMat)
      obj.add(dot)
    } else if (obj.userData?.kind === 'collider') {
      // Wireframe of the half-extents box if shape=box.
      const he = obj.userData?.half_extents
      if (Array.isArray(he) && he.length === 3) {
        // half_extents are in three.js axes (right, up, forward) per
        // the bike pipeline contract. They live on a node that's a
        // sibling of bike_body in Blender axes — the GLTFLoader has
        // already converted the node's transform, but the extras
        // payload is still in three's axes, so use directly.
        const box = new THREE.Box3(
          new THREE.Vector3(-he[0], -he[1], -he[2]),
          new THREE.Vector3(he[0], he[1], he[2]),
        )
        const helper = new THREE.Box3Helper(box, 0xffaa33)
        helper.material = colliderEdgeMat
        obj.add(helper)
      }
    }
  })

  scene.add(node)

  // Per-bike axes at the root so it's easy to see if the model is at
  // origin / oriented as expected.
  axesGroup.clear()
  const rootAxes = new THREE.AxesHelper(0.4)
  axesGroup.add(rootAxes)

  return node
}

async function switchBike(refs: Refs, bikeId: string): Promise<void> {
  const next = refs.manifest.bikes.find((b) => b.id === bikeId)
  if (!next) return
  refs.current = next
  refs.scene.remove(refs.bikeNode)
  // Best-effort dispose of cloned materials/geometries from the
  // outgoing node so a long browser session doesn't accumulate them.
  refs.bikeNode.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh) {
      mesh.geometry?.dispose?.()
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : mesh.material
          ? [mesh.material]
          : []
      for (const m of mats) (m as THREE.Material).dispose?.()
    }
  })

  refs.loaded = await loadBike(next.url)
  refs.bikeNode = mountBike(refs.scene, refs.axesGroup, refs.loaded)
  // Update URL so refresh keeps the same selection.
  const url = new URL(window.location.href)
  url.searchParams.set('viewer', next.id)
  window.history.replaceState({}, '', url.toString())
  renderHud(refs, (id) => switchBike(refs, id))
}

function renderHud(refs: Refs, onSwitch: (bikeId: string) => void): void {
  const { manifest, current, loaded, hud } = refs
  const root = loaded.root

  // Compute world-space bbox of the cloned root.
  const node = refs.bikeNode
  node.updateMatrixWorld(true)
  const bbox = new THREE.Box3().setFromObject(node)
  const size = new THREE.Vector3()
  bbox.getSize(size)

  const ext = root.userData
  const liveryHex = current.appearance?.liveryColor ?? '—'
  const metalHex = current.appearance?.metalColor ?? '—'
  const glowHex = current.appearance?.glowColor ?? '—'

  const sockets = Object.keys(loaded.socketNames).sort()
  const colliders = loaded.colliders.length
  const meta = ext as Record<string, unknown>
  const massKg = typeof meta.mass_kg === 'number' ? meta.mass_kg : '—'
  const topSpeed = typeof meta.top_speed_mps === 'number' ? meta.top_speed_mps : '—'
  const hoverHeight = typeof meta.hover_height === 'number' ? meta.hover_height : '—'

  const fmt = (n: number, d = 2) => n.toFixed(d)
  hud.innerHTML = `
    <div style="font-size:14px;font-weight:600;margin-bottom:6px">${current.displayName} <span style="color:#7a8696;font-weight:400">/ ${current.id}</span></div>
    <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;color:#bcc7d4">
      <div>spec</div><div><a href="https://github.com/occ-matt/hoverbike/blob/main/${current.specPath}" target="_blank" rel="noreferrer" style="color:#9bd1ff;text-decoration:none">${current.specPath}</a></div>
      <div>mass</div><div>${massKg} kg</div>
      <div>top speed</div><div>${topSpeed} m/s</div>
      <div>hover h</div><div>${hoverHeight} m</div>
      <div>bbox</div><div>${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} m (xyz / right·up·forward)</div>
      <div>livery</div><div><span style="display:inline-block;width:10px;height:10px;background:${liveryHex};border:1px solid #555;vertical-align:middle;margin-right:4px"></span>${liveryHex}</div>
      <div>metal</div><div><span style="display:inline-block;width:10px;height:10px;background:${metalHex};border:1px solid #555;vertical-align:middle;margin-right:4px"></span>${metalHex}</div>
      <div>glow</div><div><span style="display:inline-block;width:10px;height:10px;background:${glowHex};border:1px solid #555;vertical-align:middle;margin-right:4px"></span>${glowHex}</div>
      <div>sockets</div><div>${sockets.join(', ') || '—'}</div>
      <div>colliders</div><div>${colliders}</div>
    </div>
    <div style="margin-top:10px;border-top:1px solid #2a3340;padding-top:8px">
      <div style="color:#7a8696;margin-bottom:4px">switch:</div>
      <div id="viewer-bike-list" style="display:flex;flex-wrap:wrap;gap:4px"></div>
    </div>
  `
  const list = hud.querySelector('#viewer-bike-list') as HTMLElement
  for (const b of manifest.bikes) {
    const btn = document.createElement('button')
    btn.textContent = b.displayName
    btn.style.cssText = [
      'padding:4px 8px',
      'border:1px solid ' + (b.id === current.id ? '#5cf2ff' : '#2a3340'),
      'background:' + (b.id === current.id ? '#16242c' : '#1a2028'),
      'color:#dde6ee',
      'border-radius:4px',
      'cursor:pointer',
      'font:12px system-ui,sans-serif',
    ].join(';')
    btn.addEventListener('click', () => onSwitch(b.id))
    list.appendChild(btn)
  }
}
