import * as THREE from 'three'
import { DEFAULT_GATE_SPACING_M, resampleByArcLength } from '@/game/tracks/gate-placement'
import type { AntiGravZone, BoostPad, Checkpoint, Track } from '@/game/tracks/types'

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

/**
 * Minimum xz distance from any checkpoint at which we still place a route
 * marker. Keeps the lit checkpoint visually dominant.
 */
const ROUTE_MARKER_MIN_GAP_M = 18

export function createTrackVisuals(track: Track): TrackVisuals {
  const group = new THREE.Group()
  group.name = `track:${track.id}`

  const gateMeshesByIndex = new Map<number, GateMesh>()

  for (const cp of track.checkpoints) {
    const gate = createGateMesh(cp, cp.index === 0)
    gate.root.position.set(cp.position.x, cp.position.y, cp.position.z)
    gate.root.quaternion.set(cp.rotation.x, cp.rotation.y, cp.rotation.z, cp.rotation.w)
    group.add(gate.root)
    gateMeshesByIndex.set(cp.index, gate)
  }

  for (const cp of track.checkpoints) {
    setStateOn(gateMeshesByIndex.get(cp.index)!, cp.index === 0 ? 'next' : 'upcoming')
  }

  // Visual route markers along the main AI spline at `gateSpacing` intervals.
  // These are render-only — they don't trigger lap logic or count toward the
  // checkpoint progression. The point is making the racing line legible so
  // first-time players can see where the course goes at a glance, instead of
  // having to read a direction arrow + minimap and infer the rest. Skipped
  // anywhere within `ROUTE_MARKER_MIN_GAP_M` of a real checkpoint so the
  // lit "next gate" remains the dominant target.
  const routeMarkers = createRouteMarkers(track)
  if (routeMarkers) group.add(routeMarkers.root)

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
    if (routeMarkers) routeMarkers.dispose()
  }

  return { group, setCheckpointState, dispose }
}

/**
 * Cheap "you are on the course" markers — pairs of slender pylons at the
 * left + right shoulder of the racing line at `gateSpacing` intervals,
 * with a soft glowing ribbon spanning them. Built off the main spline +
 * `gateSpacing`, shares one geometry + material across all markers via
 * InstancedMesh so the per-track cost is one draw call regardless of
 * marker count. Skipped when the spline has too few points to sample or
 * when no spline is authored.
 */
function createRouteMarkers(track: Track): { root: THREE.Object3D; dispose(): void } | null {
  const spline = track.aiSplines.find((s) => s.id === 'main') ?? track.aiSplines[0]
  if (!spline || spline.points.length < 2) return null
  const spacing = track.gateSpacing ?? DEFAULT_GATE_SPACING_M
  const placements = resampleByArcLength(spline.points, spacing)
  if (placements.length < 2) return null

  // Per-track gate dimensions: borrow the median checkpoint half-width as
  // the route-marker shoulder distance so wide-track tracks (Aqualand
  // concourse) get wide pylon spacing without authoring.
  const cpHalfWidth = medianHalfWidth(track.checkpoints) ?? 14
  const halfW = Math.max(8, cpHalfWidth * 0.85)
  const pylonHeight = 4.2

  const root = new THREE.Group()
  root.name = 'route_markers'

  const pylonGeom = new THREE.CylinderGeometry(0.18, 0.22, pylonHeight, 8)
  pylonGeom.translate(0, pylonHeight / 2, 0)
  const pylonMat = new THREE.MeshStandardMaterial({
    color: 0xa7c8ff,
    emissive: 0x335c99,
    emissiveIntensity: 0.45,
    roughness: 0.55,
    metalness: 0.1,
  })

  const ribbonGeom = new THREE.PlaneGeometry(1, 1)
  ribbonGeom.translate(0, 0.5, 0)
  const ribbonMat = new THREE.MeshBasicMaterial({
    color: 0xa7c8ff,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    side: THREE.DoubleSide,
  })

  const keep: typeof placements = []
  const cps = track.checkpoints
  for (const p of placements) {
    let nearCp = false
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i]!
      const dx = cp.position.x - p.position.x
      const dz = cp.position.z - p.position.z
      if (dx * dx + dz * dz < ROUTE_MARKER_MIN_GAP_M * ROUTE_MARKER_MIN_GAP_M) {
        nearCp = true
        break
      }
    }
    if (!nearCp) keep.push(p)
  }
  if (keep.length === 0) return null

  const pylons = new THREE.InstancedMesh(pylonGeom, pylonMat, keep.length * 2)
  pylons.name = 'route_pylons'
  pylons.castShadow = false
  pylons.receiveShadow = false
  pylons.frustumCulled = false

  const ribbons = new THREE.InstancedMesh(ribbonGeom, ribbonMat, keep.length)
  ribbons.name = 'route_ribbons'
  ribbons.frustumCulled = false
  ribbons.renderOrder = 0

  const scratch = new THREE.Matrix4()
  const scratchQuat = new THREE.Quaternion()
  const scratchScale = new THREE.Vector3(1, 1, 1)
  const scratchPos = new THREE.Vector3()

  for (let i = 0; i < keep.length; i++) {
    const p = keep[i]!
    const yaw = Math.atan2(p.tangent.x, p.tangent.z)
    // Perpendicular vector in xz (right-hand-side of travel).
    const px = Math.cos(yaw)
    const pz = -Math.sin(yaw)
    const lift = 0.2
    const baseY = p.position.y + lift

    // Left pylon (i * 2).
    scratchQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    scratchPos.set(p.position.x - px * halfW, baseY, p.position.z - pz * halfW)
    scratch.compose(scratchPos, scratchQuat, scratchScale)
    pylons.setMatrixAt(i * 2, scratch)

    // Right pylon (i * 2 + 1).
    scratchPos.set(p.position.x + px * halfW, baseY, p.position.z + pz * halfW)
    scratch.compose(scratchPos, scratchQuat, scratchScale)
    pylons.setMatrixAt(i * 2 + 1, scratch)

    // Ribbon: thin horizontal panel across the road, height 0.3, opacity
    // soft. Stacked at the top of the pylons so it reads as a banner.
    const ribbonY = baseY + pylonHeight - 0.4
    scratchPos.set(p.position.x, ribbonY, p.position.z)
    scratchQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + Math.PI / 2)
    scratchScale.set(halfW * 2, 0.3, 1)
    scratch.compose(scratchPos, scratchQuat, scratchScale)
    ribbons.setMatrixAt(i, scratch)
    scratchScale.set(1, 1, 1)
  }
  pylons.instanceMatrix.needsUpdate = true
  ribbons.instanceMatrix.needsUpdate = true

  root.add(pylons)
  root.add(ribbons)

  return {
    root,
    dispose() {
      pylonGeom.dispose()
      pylonMat.dispose()
      ribbonGeom.dispose()
      ribbonMat.dispose()
    },
  }
}

function medianHalfWidth(cps: readonly Checkpoint[]): number | null {
  if (cps.length === 0) return null
  const w = cps.map((c) => c.halfWidth).sort((a, b) => a - b)
  return w[Math.floor(w.length / 2)]!
}

type GateMesh = {
  root: THREE.Object3D
  recolorables: THREE.Mesh[]
  dispose(): void
}

function createGateMesh(cp: Checkpoint, isFinishLine: boolean): GateMesh {
  const root = new THREE.Group()
  root.name = `gate:${cp.index}`

  const recolorables: THREE.Mesh[] = []

  const pillarGeom = new THREE.CylinderGeometry(0.4, 0.4, cp.height, 12)
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
  const bar = new THREE.Mesh(barGeom, pillarMat.clone())
  bar.position.set(0, cp.height + 0.4, 0)
  bar.castShadow = true
  bar.receiveShadow = true
  root.add(bar)
  recolorables.push(bar)

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
    pillarGeom.dispose()
    barGeom.dispose()
    for (const m of recolorables) (m.material as THREE.Material).dispose()
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
  root.position.set(pad.position.x, pad.position.y + 0.05, pad.position.z)
  root.quaternion.set(pad.rotation.x, pad.rotation.y, pad.rotation.z, pad.rotation.w)

  const w = pad.halfWidth * 2
  const d = pad.halfDepth * 2
  const slabGeom = new THREE.PlaneGeometry(w, d)
  slabGeom.rotateX(-Math.PI / 2)
  const slabMat = new THREE.MeshBasicMaterial({
    color: 0x33ddff,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const slab = new THREE.Mesh(slabGeom, slabMat)
  root.add(slab)

  const chevGeom = new THREE.PlaneGeometry(w * 0.6, d * 0.18)
  chevGeom.rotateX(-Math.PI / 2)
  const chevMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  for (const offsetZ of [-d * 0.3, 0, d * 0.3]) {
    const c = new THREE.Mesh(chevGeom, chevMat)
    c.position.set(0, 0.02, offsetZ)
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
