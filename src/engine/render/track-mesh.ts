import * as THREE from 'three'
import type { BoostPad, Checkpoint, Track } from '@/game/tracks/types'

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

  for (const pad of track.boostPads) {
    group.add(createBoostPadMesh(pad))
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
  beacon: THREE.Mesh
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

  // Beacon — a tall, glowing column above the gate, visible from anywhere on
  // the map. Only shown when the gate is the "next" target so the player can
  // always see where to go.
  const beaconHeight = 80
  const beaconMat = new THREE.MeshBasicMaterial({
    color: COLORS.next,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  })
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.9, beaconHeight, 8, 1, true),
    beaconMat,
  )
  beacon.position.set(0, beaconHeight / 2, 0)
  beacon.visible = false
  beacon.renderOrder = 2
  root.add(beacon)

  function dispose() {
    pillarGeom.dispose()
    barGeom.dispose()
    beaconMat.dispose()
    beacon.geometry.dispose()
    for (const m of recolorables) (m.material as THREE.Material).dispose()
  }

  return { root, recolorables, beacon, dispose }
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
  gate.beacon.visible = state === 'next'
}
