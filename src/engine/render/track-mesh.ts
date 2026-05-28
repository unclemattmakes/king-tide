import * as THREE from 'three'
import type { AntiGravZone, BoostPad, Checkpoint, Track } from '@/game/tracks/types'
import { cloneGateProp } from './gate-prop'

export type TrackVisuals = {
  group: THREE.Object3D
  setCheckpointState(index: number, state: CheckpointVisualState): void
  dispose(): void
}

export type CheckpointVisualState = 'upcoming' | 'next' | 'passed'

const COLORS = {
  upcoming: 0x4d6b7a,
  next: 0xff9933,
  passed: 0x44cc88,
}

export type TrackVisualsOptions = {
  /** Pre-loaded `prop_gate_mesh` from `public/assets/props/gate.glb`,
   *  authored in Blender's `tracks-src/props-library.blend`. When
   *  provided, every gate clones this mesh — placement matches what
   *  the Blender N-panel gate-preview gizmo shows because both
   *  surfaces share the same source mesh + the same JSON-driven
   *  position/rotation. When `null` (or the asset failed to load),
   *  gates fall back to the procedural Cylinder + Box geometry so
   *  legacy / fresh-checkout builds still render. */
  gatePropTemplate?: THREE.Object3D | null
}

export function createTrackVisuals(track: Track, options: TrackVisualsOptions = {}): TrackVisuals {
  const group = new THREE.Group()
  group.name = `track:${track.id}`

  const gatePropTemplate = options.gatePropTemplate ?? null
  const gateMeshesByIndex = new Map<number, GateMesh>()

  for (const cp of track.checkpoints) {
    const gate = createGateMesh(cp, cp.index === 0, gatePropTemplate)
    gate.root.position.set(cp.position.x, cp.position.y, cp.position.z)
    gate.root.quaternion.set(cp.rotation.x, cp.rotation.y, cp.rotation.z, cp.rotation.w)
    group.add(gate.root)
    gateMeshesByIndex.set(cp.index, gate)
  }

  for (const cp of track.checkpoints) {
    setStateOn(gateMeshesByIndex.get(cp.index)!, cp.index === 0 ? 'next' : 'upcoming')
  }

  for (const pad of track.boostPads) {
    group.add(createBoostPadMesh(pad))
  }

  for (const zone of track.antiGravZones) {
    group.add(createAntiGravZoneMesh(zone))
  }

  function setCheckpointState(index: number, state: CheckpointVisualState) {
    const gate = gateMeshesByIndex.get(index)
    if (!gate) return
    setStateOn(gate, state)
  }

  function dispose() {
    for (const g of gateMeshesByIndex.values()) g.dispose()
  }

  return { group, setCheckpointState, dispose }
}

type GateMesh = {
  root: THREE.Object3D
  recolorables: THREE.Mesh[]
  dispose(): void
}

function createGateMesh(
  cp: Checkpoint,
  isFinishLine: boolean,
  gatePropTemplate: THREE.Object3D | null,
): GateMesh {
  const root = new THREE.Group()
  root.name = `gate:${cp.index}`

  const recolorables: THREE.Mesh[] = []
  // Geometries owned by this gate (procedural fallback only). The
  // prop-template path shares geometries across instances via
  // `clone(true)`; only materials are cloned per-gate.
  const ownedGeoms: THREE.BufferGeometry[] = []

  if (gatePropTemplate) {
    // Library-mesh path: clone `prop_gate_mesh` and scale to the
    // checkpoint's authored dimensions. Same mesh the Blender N-panel
    // gate-preview gizmo shows — placement parity is automatic
    // because both sides read `cp.position` / `cp.rotation` /
    // `cp.halfWidth` / `cp.height` from the same JSON.
    const clone = cloneGateProp(gatePropTemplate, cp.halfWidth, cp.height)
    root.add(clone.root)
    for (const mesh of clone.recolorables) recolorables.push(mesh)
  } else {
    // Procedural fallback — runs when `public/assets/props/gate.glb`
    // hasn't been generated yet (e.g. fresh checkout, CI before
    // `pnpm gen:prop-gate`). Same primitives the runtime used pre-
    // 2026-05-19; kept as a defense-in-depth path so the gate
    // visual is never missing.
    const pillarGeom = new THREE.CylinderGeometry(0.4, 0.4, cp.height, 12)
    ownedGeoms.push(pillarGeom)
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x4d6b7a, emissive: 0x000000 })

    const left = new THREE.Mesh(pillarGeom, pillarMat.clone())
    left.position.set(-cp.halfWidth, cp.height / 2, 0)
    left.castShadow = true
    left.receiveShadow = true
    root.add(left)
    recolorables.push(left)

    const right = new THREE.Mesh(pillarGeom, pillarMat.clone())
    right.position.set(cp.halfWidth, cp.height / 2, 0)
    right.castShadow = true
    right.receiveShadow = true
    root.add(right)
    recolorables.push(right)

    const barGeom = new THREE.BoxGeometry(cp.halfWidth * 2, 0.8, 0.4)
    ownedGeoms.push(barGeom)
    const bar = new THREE.Mesh(barGeom, pillarMat.clone())
    bar.position.set(0, cp.height + 0.4, 0)
    bar.castShadow = true
    bar.receiveShadow = true
    root.add(bar)
    recolorables.push(bar)
  }

  // The start/finish gate gets a checkered banner under the cross-bar
  // and a checkered strip stamped on the ground between the pillars,
  // so it reads as the "finish line" from any approach angle. This is
  // purely visual — gate behaviour (lap completion on cp 0) is identical
  // to any other checkpoint.
  if (isFinishLine) {
    const checker = makeCheckerTexture(16, 4)
    const bannerHeight = 1.6
    const bannerGeom = new THREE.PlaneGeometry(cp.halfWidth * 2, bannerHeight)
    const bannerMat = new THREE.MeshBasicMaterial({
      map: checker,
      side: THREE.DoubleSide,
    })
    const bannerFront = new THREE.Mesh(bannerGeom, bannerMat)
    bannerFront.position.set(0, cp.height - bannerHeight / 2 - 0.4, 0)
    root.add(bannerFront)

    const stripeGeom = new THREE.PlaneGeometry(cp.halfWidth * 2, 1.6)
    stripeGeom.rotateX(-Math.PI / 2)
    const stripeMat = new THREE.MeshBasicMaterial({
      map: checker,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    })
    const stripe = new THREE.Mesh(stripeGeom, stripeMat)
    // Sit just above the gate's local ground plane so it doesn't
    // z-fight with the water/track beneath.
    stripe.position.set(0, -cp.position.y + 0.05, 0)
    stripe.renderOrder = 1
    root.add(stripe)

    const finishLabelMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
    const finishLabel = new THREE.Mesh(
      new THREE.BoxGeometry(cp.halfWidth * 0.6, 0.6, 0.1),
      finishLabelMat,
    )
    finishLabel.position.set(0, cp.height + 1.4, 0)
    root.add(finishLabel)
  }

  // Note: the "next" gate used to also wear a tall glowing beacon column,
  // but the recolor + on-screen direction arrow already make the target
  // gate unmistakable — the beacon was visual noise.

  function dispose() {
    // Geometries are only owned by the procedural-fallback path; the
    // library-mesh path shares geometries across all instances of the
    // gate template, so disposing them here would yank them out from
    // under sibling gates. Materials are cloned per-instance for both
    // paths and need to be released.
    for (const g of ownedGeoms) g.dispose()
    for (const m of recolorables) {
      if (Array.isArray(m.material)) {
        for (const mat of m.material) mat.dispose()
      } else if (m.material) {
        ;(m.material as THREE.Material).dispose()
      }
    }
  }

  return { root, recolorables, dispose }
}

/**
 * Boost pad placeholder visual — a flat cyan rectangle with directional
 * chevrons. The boost behaviour itself is not yet wired into the sim;
 * this is the editor's placement-confirmation rendering.
 */
function createBoostPadMesh(pad: BoostPad): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'boost_pad'
  root.position.set(pad.position.x, pad.position.y, pad.position.z)
  root.quaternion.set(pad.rotation.x, pad.rotation.y, pad.rotation.z, pad.rotation.w)

  const w = pad.halfWidth * 2
  const h = pad.halfHeight * 2
  const d = pad.halfDepth * 2

  // Wireframe box matching the trigger volume. Faint cyan fill so it
  // reads as a glowing volume head-on but doesn't drown the track when
  // viewed at a glancing angle.
  const boxGeom = new THREE.BoxGeometry(w, h, d)
  const fillMat = new THREE.MeshBasicMaterial({
    color: 0x33ddff,
    transparent: true,
    opacity: 0.08,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  root.add(new THREE.Mesh(boxGeom, fillMat))

  const wireMat = new THREE.LineBasicMaterial({
    color: 0x33ddff,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  })
  root.add(new THREE.LineSegments(new THREE.WireframeGeometry(boxGeom), wireMat))

  // Chevron arrow on the bottom interior face, pointing +Z (boost
  // direction). Slightly inset from the bottom so it doesn't z-fight
  // with anything resting under the box.
  const chevGeom = new THREE.PlaneGeometry(w * 0.6, d * 0.18)
  chevGeom.rotateX(-Math.PI / 2)
  const chevMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const chevY = -pad.halfHeight + 0.05
  for (const offsetZ of [-d * 0.3, 0, d * 0.3]) {
    const c = new THREE.Mesh(chevGeom, chevMat)
    c.position.set(0, chevY, offsetZ)
    root.add(c)
  }
  return root
}

/**
 * Anti-gravity zone visual — translucent purple box wireframe so drivers
 * can see the section boundary at race time. The actual gravity flip is
 * applied by `antiGravSystem` whenever the bike's center is inside. Kept
 * subtle (low fill opacity) so it doesn't drown out the road geometry.
 */
function createAntiGravZoneMesh(zone: AntiGravZone): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'anti_grav_zone'
  root.position.set(zone.position.x, zone.position.y, zone.position.z)
  root.quaternion.set(zone.rotation.x, zone.rotation.y, zone.rotation.z, zone.rotation.w)

  const w = zone.halfWidth * 2
  const h = zone.halfHeight * 2
  const d = zone.halfDepth * 2

  const fillGeom = new THREE.BoxGeometry(w, h, d)
  const fillMat = new THREE.MeshBasicMaterial({
    color: 0xa066ff,
    transparent: true,
    opacity: 0.08,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  root.add(new THREE.Mesh(fillGeom, fillMat))

  const wireMat = new THREE.LineBasicMaterial({
    color: 0xc8a0ff,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  })
  root.add(new THREE.LineSegments(new THREE.WireframeGeometry(fillGeom), wireMat))

  return root
}

/**
 * Procedural black/white checker texture used on the start/finish gate's
 * banner and ground stripe. Built once per gate; cheap (16×16 canvas).
 */
function makeCheckerTexture(repeats: number, rows: number): THREE.Texture {
  const cellSize = 16
  const width = repeats * cellSize
  const height = rows * cellSize
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < repeats; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#ffffff' : '#111111'
        ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize)
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

function setStateOn(gate: GateMesh, state: CheckpointVisualState): void {
  const color = COLORS[state]
  for (const m of gate.recolorables) {
    const mat = m.material as THREE.MeshStandardMaterial
    mat.color.setHex(color)
    mat.emissive.setHex(state === 'next' ? color : 0x000000)
    mat.emissiveIntensity = state === 'next' ? 0.6 : 0
  }
}
