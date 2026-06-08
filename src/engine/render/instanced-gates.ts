/**
 * Instanced checkpoint gates.
 *
 * Every gate clones the same `prop_gate_mesh` (one geometry, one material),
 * differing only in per-checkpoint SCALE (halfWidth/height) and per-state COLOUR
 * (upcoming / next / passed, with the "next" gate emissive). The old path cloned
 * the mesh per checkpoint — N gates = N draws ×passes. This draws the whole gate
 * set through one `InstancedMesh` per sub-mesh on the shared painterly-vinyl
 * material, with the state colour driven by a per-instance `aTint` attribute and
 * the next-gate glow by a SEPARATE per-instance `aGlow` emissive attribute (so
 * exactly one gate lights up from one shared material). Per-checkpoint scale folds
 * into the instance matrix; floating gates update their Y per frame.
 *
 * The start/finish gate's checkered banner + ground stripe stay as their own
 * meshes (one gate, unique) — see track-mesh.ts.
 */
import * as THREE from 'three'
import type { Checkpoint } from '@/game/tracks/types'
import { stampConvexityColor0 } from './edge-wear-convexity'
import { PROP_GATE_AUTHOR_HALF_WIDTH, PROP_GATE_AUTHOR_HEIGHT } from './gate-prop'
import { buildVinylMaterial } from './painterly-vinyl-material'

const TINT_ATTR = 'aTint'
const GLOW_ATTR = 'aGlow'

export type GateVisualState = 'upcoming' | 'next' | 'passed'

const STATE_COLOR: Record<GateVisualState, number> = {
  upcoming: 0x4d6b7a,
  next: 0xff9933,
  passed: 0x44cc88,
}
/** Emissive strength on the "next" gate — matches the old per-material setup
 *  (emissive = stateColour × 0.6 for next, 0 otherwise). */
const NEXT_GLOW = 0.6
/** Painterly brush on the gate — a touch under the prop default. */
const GATE_BRUSH = 0.55

type GateSub = {
  inst: THREE.InstancedMesh
  rel: THREE.Matrix4
  tint: THREE.InstancedBufferAttribute
  glow: THREE.InstancedBufferAttribute
}

export type InstancedGates = {
  group: THREE.Group
  /** Recolor the gate for checkpoint `cpIndex` to a state. */
  setState(cpIndex: number, state: GateVisualState): void
  /** Set the gate for checkpoint `cpIndex` to world-Y `y` (floating gates bob). */
  setY(cpIndex: number, y: number): void
  dispose(): void
}

export function createInstancedGates(
  checkpoints: readonly Checkpoint[],
  template: THREE.Object3D,
): InstancedGates {
  const group = new THREE.Group()
  group.name = 'gates:instanced'
  const n = checkpoints.length
  const slotOf = new Map<number, number>()
  checkpoints.forEach((cp, i) => {
    slotOf.set(cp.index, i)
  })

  template.updateWorldMatrix(true, true)
  const rootInv = new THREE.Matrix4().copy(template.matrixWorld).invert()

  const subs: GateSub[] = []
  // Share one vinyl material per source material across every gate sub-mesh.
  const matCache = new Map<THREE.Material, THREE.Material>()
  template.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const srcMat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
      | THREE.Material
      | undefined
    if (!srcMat) return

    // Clone the geometry so the per-instance attributes + convexity stamp don't
    // touch the shared template geometry.
    const geom = (mesh.geometry as THREE.BufferGeometry).clone()
    stampConvexityColor0(geom) // valid COLOR_0 so the vinyl AO read isn't 0
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3)
    tint.setUsage(THREE.DynamicDrawUsage)
    const glow = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3) // 0 → dark
    glow.setUsage(THREE.DynamicDrawUsage)
    geom.setAttribute(TINT_ATTR, tint)
    geom.setAttribute(GLOW_ATTR, glow)

    let vinyl = matCache.get(srcMat)
    if (!vinyl) {
      vinyl = buildVinylMaterial(srcMat, {
        brush: GATE_BRUSH,
        tintAttribute: TINT_ATTR,
        emissiveAttribute: GLOW_ATTR,
      })
      matCache.set(srcMat, vinyl)
    }

    const inst = new THREE.InstancedMesh(geom, vinyl, n)
    inst.name = 'gate'
    inst.castShadow = true
    inst.receiveShadow = true
    inst.frustumCulled = false
    inst.count = n
    inst.userData.kind = 'gate'
    subs.push({
      inst,
      rel: new THREE.Matrix4().multiplyMatrices(rootInv, mesh.matrixWorld),
      tint,
      glow,
    })
    group.add(inst)
  })

  // Per-gate base placement, kept so setY can recompose with a new Y.
  const pos = checkpoints.map(
    (cp) => new THREE.Vector3(cp.position.x, cp.position.y, cp.position.z),
  )
  const quat = checkpoints.map(
    (cp) => new THREE.Quaternion(cp.rotation.x, cp.rotation.y, cp.rotation.z, cp.rotation.w),
  )
  const scale = checkpoints.map(
    (cp) =>
      new THREE.Vector3(
        cp.halfWidth / PROP_GATE_AUTHOR_HALF_WIDTH,
        cp.height / PROP_GATE_AUTHOR_HEIGHT,
        1,
      ),
  )
  const placement = new THREE.Matrix4()
  const instM = new THREE.Matrix4()
  const tmpColor = new THREE.Color()

  function writeMatrix(slot: number): void {
    placement.compose(
      pos[slot] as THREE.Vector3,
      quat[slot] as THREE.Quaternion,
      scale[slot] as THREE.Vector3,
    )
    for (const s of subs) {
      instM.multiplyMatrices(placement, s.rel)
      s.inst.setMatrixAt(slot, instM)
      s.inst.instanceMatrix.needsUpdate = true
    }
  }
  for (let i = 0; i < n; i++) writeMatrix(i)

  return {
    group,
    setState(cpIndex, state) {
      const slot = slotOf.get(cpIndex)
      if (slot === undefined) return
      tmpColor.setHex(STATE_COLOR[state])
      const glow = state === 'next' ? NEXT_GLOW : 0
      for (const s of subs) {
        s.tint.setXYZ(slot, tmpColor.r, tmpColor.g, tmpColor.b)
        s.tint.needsUpdate = true
        s.glow.setXYZ(slot, tmpColor.r * glow, tmpColor.g * glow, tmpColor.b * glow)
        s.glow.needsUpdate = true
      }
    },
    setY(cpIndex, y) {
      const slot = slotOf.get(cpIndex)
      if (slot === undefined) return
      ;(pos[slot] as THREE.Vector3).y = y
      writeMatrix(slot)
    },
    dispose() {
      for (const s of subs) {
        s.inst.geometry.dispose()
        group.remove(s.inst)
        s.inst.dispose()
      }
    },
  }
}
