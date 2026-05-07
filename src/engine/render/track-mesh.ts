import * as THREE from 'three'
import type { Checkpoint, Track } from '@/game/tracks/types'

/**
 * Visual representation of track-level objects: checkpoint gates, start line,
 * and (later) surface meshes. Returns a group that the caller adds to the scene.
 *
 * Each gate exposes its index and current state (passed/active/upcoming) via
 * `setCheckpointState(index, state)` so the race system can highlight progress.
 */
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
    const gate = createGateMesh(cp)
    gate.root.position.set(cp.position.x, cp.position.y, cp.position.z)
    gate.root.quaternion.set(cp.rotation.x, cp.rotation.y, cp.rotation.z, cp.rotation.w)
    group.add(gate.root)
    gateMeshesByIndex.set(cp.index, gate)
  }

  // Initial state: cp 0 is "next", rest are "upcoming".
  for (const cp of track.checkpoints) {
    setStateOn(gateMeshesByIndex.get(cp.index)!, cp.index === 0 ? 'next' : 'upcoming')
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
  /** Pillars + crossbar — anything we re-color on state change. */
  recolorables: THREE.Mesh[]
  dispose(): void
}

function createGateMesh(cp: Checkpoint): GateMesh {
  const root = new THREE.Group()
  root.name = `gate:${cp.index}`

  const recolorables: THREE.Mesh[] = []

  const pillarGeom = new THREE.CylinderGeometry(0.4, 0.4, cp.height, 12)
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x4d6b7a, emissive: 0x000000 })

  const left = new THREE.Mesh(pillarGeom, pillarMat.clone())
  left.position.set(-cp.halfWidth, cp.height / 2, 0)
  root.add(left)
  recolorables.push(left)

  const right = new THREE.Mesh(pillarGeom, pillarMat.clone())
  right.position.set(cp.halfWidth, cp.height / 2, 0)
  root.add(right)
  recolorables.push(right)

  // Crossbar — banner at the top
  const barGeom = new THREE.BoxGeometry(cp.halfWidth * 2, 0.8, 0.4)
  const bar = new THREE.Mesh(barGeom, pillarMat.clone())
  bar.position.set(0, cp.height + 0.4, 0)
  root.add(bar)
  recolorables.push(bar)

  function dispose() {
    pillarGeom.dispose()
    barGeom.dispose()
    for (const m of recolorables) (m.material as THREE.Material).dispose()
  }

  return { root, recolorables, dispose }
}

function setStateOn(gate: GateMesh, state: CheckpointVisualState): void {
  const color = COLORS[state]
  for (const m of gate.recolorables) {
    const mat = m.material as THREE.MeshStandardMaterial
    mat.color.setHex(color)
    mat.emissive.setHex(state === 'next' ? color : 0x000000)
    mat.emissiveIntensity = state === 'next' ? 0.4 : 0
  }
}
