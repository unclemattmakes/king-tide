import * as THREE from 'three'
import { trackToJson } from '@/game/tracks/json-loader'
import type { Track } from '@/game/tracks/types'

/**
 * In-app track editor (Phase 1 — the JSON authoring loop).
 *
 * Workflow:
 *   1. User opens `?track=<id>&edit=1` (or hits "Edit" in the future garage
 *      menu).
 *   2. Sim is paused; this module owns the canvas. It renders the existing
 *      Track's gameplay entities (gates, pickups, boost pads, AI spline)
 *      against a water plane / optional environment .glb.
 *   3. Tool palette in the side panel: Select / +Gate / +Pickup / +Pad /
 *      +Spline Point.
 *   4. Click on the world to place. Click on an existing entity to select.
 *      Drag a selected entity in the xz plane to move it.
 *   5. "Save" POSTs to the dev-only `/__editor/save-track` endpoint, which
 *      writes `public/tracks/<id>.json`.
 *   6. "Play" reloads the page without `?edit=1` so the user can drive
 *      their changes immediately.
 *
 * What's intentionally *not* here yet:
 *   - Yaw/rotation editing of gates (they get yaw 0; we'll add a rotation
 *     handle in phase 2).
 *   - Importing the env .glb into the editor's view — phase 2.
 *   - Undo. Phase 2.
 */

export type EditorOptions = {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer | { render(s: THREE.Scene, c: THREE.Camera): void }
  domEl: HTMLElement
  track: Track
}

export type EditorHandle = {
  tick(): void
  dispose(): void
}

type Tool = 'select' | 'gate' | 'pickup' | 'pad' | 'spline'

type EntitySel =
  | { kind: 'gate'; index: number }
  | { kind: 'pickup'; index: number }
  | { kind: 'pad'; index: number }
  | { kind: 'spline'; splineIndex: number; pointIndex: number }
  | null

export function installTrackEditor(opts: EditorOptions): EditorHandle {
  const { scene, camera, renderer, domEl, track } = opts
  const draft: Track = JSON.parse(JSON.stringify(track)) as Track

  // Top-down orbit camera. Aim at scene origin; angle tilted toward perspective.
  camera.position.set(0, 80, 60)
  camera.lookAt(0, 0, 0)

  const helperGroup = new THREE.Group()
  helperGroup.name = 'editor:helpers'
  scene.add(helperGroup)

  // Invisible click-target plane at y=0 for raycasts.
  const clickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()
  const tmpHit = new THREE.Vector3()

  let tool: Tool = 'select'
  let sel: EntitySel = null
  let dragging = false
  let panEnabled = false
  const panOrigin = new THREE.Vector2()
  const camTarget = new THREE.Vector3(0, 0, 0)
  let camDistance = camera.position.distanceTo(camTarget)
  let camYaw = Math.atan2(camera.position.x - camTarget.x, camera.position.z - camTarget.z)
  let camPitch = Math.atan2(
    camera.position.y - camTarget.y,
    Math.hypot(camera.position.x - camTarget.x, camera.position.z - camTarget.z),
  )

  function applyCam() {
    camera.position.set(
      camTarget.x + camDistance * Math.cos(camPitch) * Math.sin(camYaw),
      camTarget.y + camDistance * Math.sin(camPitch),
      camTarget.z + camDistance * Math.cos(camPitch) * Math.cos(camYaw),
    )
    camera.lookAt(camTarget)
  }
  applyCam()

  // ── DOM panel ───────────────────────────────────────────────────────────
  const panel = document.createElement('div')
  panel.id = 'editor-panel'
  panel.style.cssText = [
    'position: fixed',
    'top: 10px',
    'left: 10px',
    'background: rgba(20,24,30,0.92)',
    'color: #d8e6f0',
    'font: 12px ui-monospace, Menlo, Consolas, monospace',
    'padding: 10px 12px',
    'border: 1px solid #2a3a4a',
    'border-radius: 6px',
    'min-width: 220px',
    'z-index: 30',
    'pointer-events: auto',
  ].join(';')
  panel.innerHTML = renderPanel()
  document.body.appendChild(panel)

  function renderPanel(): string {
    const sCount = draft.aiSplines[0]?.points.length ?? 0
    const selDesc = describeSel(sel, draft)
    return [
      `<div style="font-weight:bold;margin-bottom:6px;color:#7fc7ff">EDITOR · ${draft.id}</div>`,
      '<div style="margin-bottom:6px">Tool</div>',
      `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">
        ${toolBtn('select', 'Select', tool)}
        ${toolBtn('gate', '+ Gate', tool)}
        ${toolBtn('pickup', '+ Pickup', tool)}
        ${toolBtn('pad', '+ Boost', tool)}
        ${toolBtn('spline', '+ Spline pt', tool)}
      </div>`,
      `<div style="margin-bottom:4px;color:#9bb">Counts</div>`,
      `<div style="margin-bottom:8px">
        gates ${draft.checkpoints.length} ·
        pickups ${draft.pickupSpawns.length} ·
        pads ${draft.boostPads.length} ·
        spline ${sCount}
      </div>`,
      `<div style="margin-bottom:4px;color:#9bb">Selected</div>`,
      `<div style="margin-bottom:8px;min-height:14px">${selDesc}</div>`,
      sel
        ? `<button type="button" id="ed-delete" style="margin-bottom:8px;background:#642;color:#fdd;border:1px solid #844;padding:4px 8px;border-radius:3px;cursor:pointer">Delete</button>`
        : '',
      `<div style="display:flex;gap:6px">
        <button type="button" id="ed-save" style="flex:1;background:#284;color:#dfd;border:1px solid #4a6;padding:6px 10px;border-radius:3px;cursor:pointer">Save</button>
        <button type="button" id="ed-play" style="flex:1;background:#246;color:#dde;border:1px solid #468;padding:6px 10px;border-radius:3px;cursor:pointer">Play</button>
      </div>`,
      `<div id="ed-status" style="margin-top:8px;color:#7a8;min-height:14px;font-size:11px"></div>`,
      `<div style="margin-top:6px;color:#778;font-size:11px">
        L-click: place/select · drag selected: move<br/>
        R-drag: orbit · M-drag: pan · wheel: zoom
      </div>`,
    ].join('')
  }

  function rerender() {
    panel.innerHTML = renderPanel()
    redrawHelpers()
  }

  panel.addEventListener('click', (e) => {
    const el = e.target as HTMLElement
    const t = el.dataset.tool as Tool | undefined
    if (t) {
      tool = t
      sel = null
      rerender()
      return
    }
    if (el.id === 'ed-delete' && sel) {
      deleteSelected()
      return
    }
    if (el.id === 'ed-save') {
      void save()
      return
    }
    if (el.id === 'ed-play') {
      const url = new URL(window.location.href)
      url.searchParams.delete('edit')
      window.location.href = url.toString()
      return
    }
  })

  // ── Helper meshes ───────────────────────────────────────────────────────
  function redrawHelpers() {
    while (helperGroup.children.length > 0) {
      const c = helperGroup.children[0]!
      helperGroup.remove(c)
      disposeObj(c)
    }
    for (let i = 0; i < draft.checkpoints.length; i++) {
      helperGroup.add(makeGateHelper(draft.checkpoints[i]!, isSel({ kind: 'gate', index: i })))
    }
    for (let i = 0; i < draft.pickupSpawns.length; i++) {
      helperGroup.add(makePickupHelper(draft.pickupSpawns[i]!, isSel({ kind: 'pickup', index: i })))
    }
    for (let i = 0; i < draft.boostPads.length; i++) {
      helperGroup.add(makePadHelper(draft.boostPads[i]!, isSel({ kind: 'pad', index: i })))
    }
    const main = draft.aiSplines.find((s) => s.id === 'main')
    if (main) {
      helperGroup.add(makeSplineHelper(main.points, sel))
    }
  }
  redrawHelpers()

  // ── Pointer handling ────────────────────────────────────────────────────
  function setMouseFromEvent(e: PointerEvent | MouseEvent) {
    const r = (renderer as THREE.WebGLRenderer).domElement?.getBoundingClientRect?.()
    const rect = r ?? domEl.getBoundingClientRect()
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  }

  function rayHitGround(): THREE.Vector3 | null {
    raycaster.setFromCamera(mouse, camera)
    const ok = raycaster.ray.intersectPlane(clickPlane, tmpHit)
    return ok ? tmpHit.clone() : null
  }

  domEl.addEventListener('pointerdown', (e) => {
    if (e.button === 2) {
      // right-button orbit
      e.preventDefault()
      panEnabled = false
      panOrigin.set(e.clientX, e.clientY)
      domEl.setPointerCapture(e.pointerId)
      ;(domEl as unknown as { _orbiting?: boolean })._orbiting = true
      return
    }
    if (e.button === 1) {
      // middle-button pan
      e.preventDefault()
      panEnabled = true
      panOrigin.set(e.clientX, e.clientY)
      domEl.setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return
    setMouseFromEvent(e)
    const hit = rayHitGround()
    if (!hit) return

    if (tool === 'select') {
      sel = pickClosest(hit, draft)
      if (sel) dragging = true
      rerender()
      return
    }
    // Placement tools.
    if (tool === 'gate') {
      const idx = draft.checkpoints.length
      draft.checkpoints.push({
        index: idx,
        position: { x: hit.x, y: 1.5, z: hit.z },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 8,
        height: 4,
      })
      sel = { kind: 'gate', index: idx }
    } else if (tool === 'pickup') {
      draft.pickupSpawns.push({ x: hit.x, y: 1.2, z: hit.z })
      sel = { kind: 'pickup', index: draft.pickupSpawns.length - 1 }
    } else if (tool === 'pad') {
      draft.boostPads.push({
        position: { x: hit.x, y: 0.05, z: hit.z },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        halfWidth: 3,
        halfDepth: 6,
        strength: 1.5,
      })
      sel = { kind: 'pad', index: draft.boostPads.length - 1 }
    } else if (tool === 'spline') {
      const main = draft.aiSplines.find((s) => s.id === 'main')
      if (main) {
        main.points.push({ x: hit.x, y: 0.5, z: hit.z })
        sel = { kind: 'spline', splineIndex: 0, pointIndex: main.points.length - 1 }
      }
    }
    rerender()
  })

  domEl.addEventListener('pointermove', (e) => {
    if ((domEl as unknown as { _orbiting?: boolean })._orbiting) {
      const dx = e.clientX - panOrigin.x
      const dy = e.clientY - panOrigin.y
      panOrigin.set(e.clientX, e.clientY)
      camYaw -= dx * 0.005
      camPitch = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, camPitch + dy * 0.005))
      applyCam()
      return
    }
    if (panEnabled) {
      const dx = e.clientX - panOrigin.x
      const dy = e.clientY - panOrigin.y
      panOrigin.set(e.clientX, e.clientY)
      // Pan in camera plane; project into world xz at the look-target's depth.
      const right = new THREE.Vector3()
      camera.getWorldDirection(right)
      right.cross(camera.up).normalize()
      const fwd = new THREE.Vector3().crossVectors(camera.up, right).normalize()
      const k = camDistance * 0.0015
      camTarget.addScaledVector(right, -dx * k)
      camTarget.addScaledVector(fwd, dy * k)
      applyCam()
      return
    }
    if (!dragging || !sel) return
    setMouseFromEvent(e)
    const hit = rayHitGround()
    if (!hit) return
    moveSelected(hit)
    redrawHelpers()
  })

  domEl.addEventListener('pointerup', (e) => {
    dragging = false
    panEnabled = false
    ;(domEl as unknown as { _orbiting?: boolean })._orbiting = false
    if (domEl.hasPointerCapture(e.pointerId)) domEl.releasePointerCapture(e.pointerId)
  })

  domEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      camDistance = Math.max(10, Math.min(400, camDistance * (1 + e.deltaY * 0.001)))
      applyCam()
    },
    { passive: false },
  )

  domEl.addEventListener('contextmenu', (e) => e.preventDefault())

  window.addEventListener('keydown', onKey)
  function onKey(e: KeyboardEvent) {
    if (e.target && (e.target as HTMLElement).tagName === 'INPUT') return
    if (e.code === 'Delete' || e.code === 'Backspace') {
      if (sel) {
        deleteSelected()
        e.preventDefault()
      }
    } else if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void save()
    } else if (e.code === 'Digit1') tool = 'select'
    else if (e.code === 'Digit2') tool = 'gate'
    else if (e.code === 'Digit3') tool = 'pickup'
    else if (e.code === 'Digit4') tool = 'pad'
    else if (e.code === 'Digit5') tool = 'spline'
    rerender()
  }

  function moveSelected(hit: THREE.Vector3) {
    if (!sel) return
    if (sel.kind === 'gate') {
      const cp = draft.checkpoints[sel.index]
      if (cp) {
        cp.position.x = hit.x
        cp.position.z = hit.z
      }
    } else if (sel.kind === 'pickup') {
      const p = draft.pickupSpawns[sel.index]
      if (p) {
        p.x = hit.x
        p.z = hit.z
      }
    } else if (sel.kind === 'pad') {
      const p = draft.boostPads[sel.index]
      if (p) {
        p.position.x = hit.x
        p.position.z = hit.z
      }
    } else if (sel.kind === 'spline') {
      const s = draft.aiSplines[sel.splineIndex]
      const p = s?.points[sel.pointIndex]
      if (p) {
        p.x = hit.x
        p.z = hit.z
      }
    }
  }

  function deleteSelected() {
    if (!sel) return
    if (sel.kind === 'gate') {
      draft.checkpoints.splice(sel.index, 1)
      // Re-index so contiguous from 0.
      for (let i = 0; i < draft.checkpoints.length; i++) draft.checkpoints[i]!.index = i
    } else if (sel.kind === 'pickup') {
      draft.pickupSpawns.splice(sel.index, 1)
    } else if (sel.kind === 'pad') {
      draft.boostPads.splice(sel.index, 1)
    } else if (sel.kind === 'spline') {
      const s = draft.aiSplines[sel.splineIndex]
      if (s && s.points.length > 2) s.points.splice(sel.pointIndex, 1)
    }
    sel = null
    rerender()
  }

  function isSel(target: EntitySel): boolean {
    if (!sel || !target) return false
    if (sel.kind !== target.kind) return false
    if (sel.kind === 'spline' && target.kind === 'spline') {
      return sel.pointIndex === target.pointIndex && sel.splineIndex === target.splineIndex
    }
    return (sel as { index: number }).index === (target as { index: number }).index
  }

  async function save() {
    const status = document.getElementById('ed-status')
    if (status) status.textContent = 'Saving…'
    try {
      const res = await fetch('/__editor/save-track', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: draft.id, json: trackToJson(draft) }),
      })
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(`${res.status}: ${txt}`)
      }
      const body = (await res.json()) as { path?: string }
      if (status) status.textContent = `Saved → ${body.path ?? 'public/tracks/'}`
    } catch (e) {
      if (status) {
        status.textContent = `Save failed: ${(e as Error).message}`
        status.style.color = '#f88'
      }
    }
  }

  function tick() {
    renderer.render(scene, camera)
  }

  function dispose() {
    window.removeEventListener('keydown', onKey)
    panel.remove()
    while (helperGroup.children.length > 0) {
      const c = helperGroup.children[0]!
      helperGroup.remove(c)
      disposeObj(c)
    }
    scene.remove(helperGroup)
  }

  return { tick, dispose }
}

// ── helpers ───────────────────────────────────────────────────────────────

function toolBtn(t: Tool, label: string, active: Tool): string {
  const on = t === active
  return `<button type="button" data-tool="${t}" style="background:${on ? '#356' : '#234'};color:#dde;border:1px solid ${on ? '#7af' : '#456'};padding:4px 6px;border-radius:3px;cursor:pointer;font:inherit">${label}</button>`
}

function describeSel(sel: EntitySel, t: Track): string {
  if (!sel) return '<span style="color:#677">(none)</span>'
  if (sel.kind === 'gate') {
    const cp = t.checkpoints[sel.index]
    if (!cp) return '(missing)'
    return `gate cp_${String(cp.index).padStart(2, '0')} @ (${cp.position.x.toFixed(1)}, ${cp.position.z.toFixed(1)})`
  }
  if (sel.kind === 'pickup') {
    const p = t.pickupSpawns[sel.index]
    if (!p) return '(missing)'
    return `pickup ${sel.index} @ (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`
  }
  if (sel.kind === 'pad') {
    const p = t.boostPads[sel.index]
    if (!p) return '(missing)'
    return `pad ${sel.index} @ (${p.position.x.toFixed(1)}, ${p.position.z.toFixed(1)})`
  }
  const s = t.aiSplines[sel.splineIndex]
  const p = s?.points[sel.pointIndex]
  if (!p) return '(missing)'
  return `spline pt ${sel.pointIndex} @ (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`
}

function pickClosest(hit: THREE.Vector3, t: Track): EntitySel {
  let best: { sel: EntitySel; d: number } = { sel: null, d: 8 } // 8m pick radius
  function consider(x: number, z: number, s: EntitySel) {
    const d = Math.hypot(hit.x - x, hit.z - z)
    if (d < best.d) best = { sel: s, d }
  }
  for (let i = 0; i < t.checkpoints.length; i++) {
    const cp = t.checkpoints[i]!
    consider(cp.position.x, cp.position.z, { kind: 'gate', index: i })
  }
  for (let i = 0; i < t.pickupSpawns.length; i++) {
    const p = t.pickupSpawns[i]!
    consider(p.x, p.z, { kind: 'pickup', index: i })
  }
  for (let i = 0; i < t.boostPads.length; i++) {
    const p = t.boostPads[i]!
    consider(p.position.x, p.position.z, { kind: 'pad', index: i })
  }
  for (let si = 0; si < t.aiSplines.length; si++) {
    const sp = t.aiSplines[si]!
    for (let pi = 0; pi < sp.points.length; pi++) {
      const p = sp.points[pi]!
      consider(p.x, p.z, { kind: 'spline', splineIndex: si, pointIndex: pi })
    }
  }
  return best.sel
}

function makeGateHelper(cp: import('@/game/tracks/types').Checkpoint, selected: boolean) {
  const g = new THREE.Group()
  g.position.set(cp.position.x, cp.position.y, cp.position.z)
  g.quaternion.set(cp.rotation.x, cp.rotation.y, cp.rotation.z, cp.rotation.w)
  const color = selected ? 0xffaa33 : 0xff7733
  const pillarMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 })
  const pillarGeom = new THREE.CylinderGeometry(0.5, 0.5, cp.height, 8)
  const left = new THREE.Mesh(pillarGeom, pillarMat)
  left.position.set(-cp.halfWidth, cp.height / 2, 0)
  g.add(left)
  const right = new THREE.Mesh(pillarGeom, pillarMat.clone())
  right.position.set(cp.halfWidth, cp.height / 2, 0)
  g.add(right)
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(cp.halfWidth * 2, 0.5, 0.4),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }),
  )
  bar.position.set(0, cp.height + 0.25, 0)
  g.add(bar)
  // Index label as a tiny cone pointing to gate
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.6),
    new THREE.MeshBasicMaterial({ color: selected ? 0xffff00 : 0xffffff }),
  )
  dot.position.set(0, 0.5, 0)
  g.add(dot)
  return g
}

function makePickupHelper(p: { x: number; y: number; z: number }, selected: boolean) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(1.0, 16, 12),
    new THREE.MeshBasicMaterial({
      color: selected ? 0xffff00 : 0xffaa00,
      transparent: true,
      opacity: 0.9,
    }),
  )
  m.position.set(p.x, p.y, p.z)
  return m
}

function makePadHelper(pad: import('@/game/tracks/types').BoostPad, selected: boolean) {
  const g = new THREE.Group()
  g.position.set(pad.position.x, pad.position.y + 0.1, pad.position.z)
  g.quaternion.set(pad.rotation.x, pad.rotation.y, pad.rotation.z, pad.rotation.w)
  const w = pad.halfWidth * 2
  const d = pad.halfDepth * 2
  const slab = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({
      color: selected ? 0x66ffff : 0x33ddff,
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
    }),
  )
  slab.rotation.x = -Math.PI / 2
  g.add(slab)
  return g
}

function makeSplineHelper(points: { x: number; y: number; z: number }[], sel: EntitySel) {
  const g = new THREE.Group()
  if (points.length < 2) return g
  // Polyline.
  const geom = new THREE.BufferGeometry()
  const arr = new Float32Array((points.length + 1) * 3)
  for (let i = 0; i < points.length; i++) {
    arr[i * 3] = points[i]!.x
    arr[i * 3 + 1] = points[i]!.y + 0.2
    arr[i * 3 + 2] = points[i]!.z
  }
  // close loop
  arr[points.length * 3] = points[0]!.x
  arr[points.length * 3 + 1] = points[0]!.y + 0.2
  arr[points.length * 3 + 2] = points[0]!.z
  geom.setAttribute('position', new THREE.BufferAttribute(arr, 3))
  const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x88ccff }))
  g.add(line)
  // Per-point dots.
  for (let i = 0; i < points.length; i++) {
    const isSelPt = sel?.kind === 'spline' && sel.splineIndex === 0 && sel.pointIndex === i
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 8, 6),
      new THREE.MeshBasicMaterial({ color: isSelPt ? 0xffff00 : 0x88ccff }),
    )
    dot.position.set(points[i]!.x, points[i]!.y + 0.2, points[i]!.z)
    g.add(dot)
  }
  return g
}

function disposeObj(o: THREE.Object3D) {
  o.traverse((c) => {
    if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose()
    const m = (c as THREE.Mesh).material
    if (m) {
      if (Array.isArray(m)) {
        for (const mm of m) mm.dispose()
      } else {
        m.dispose()
      }
    }
  })
}
