import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import { type LoadedProp, pickAnimationClip } from '@/game/assets/prop-loader'

/**
 * Procedural great-white for the out-of-bounds AirJaws breach. Stylised "clean
 * toy" register (docs/art-direction.md) — built from primitives so it ships
 * without an asset, recognisable by silhouette (torpedo body + dorsal fin +
 * gaping jaw). The fallback when the rigged GLB shark (`createGlbShark`) hasn't
 * loaded yet.
 *
 * Local forward is +Z; the breach sequence orients the group along its travel
 * direction. Render-only.
 */
export type Shark = {
  group: THREE.Group
  /** World position of the mouth opening — used to carry the bike "in its
   *  mouth" as the shark plunges back down. */
  mouthWorldPosition(target: THREE.Vector3): THREE.Vector3
  /** 0 = jaw shut, 1 = jaw gaping. */
  setJawOpen(t: number): void
  /** Subtle tail sway. */
  update(dt: number): void
  dispose(): void
}

const GREY = 0x59687a
const PALE = 0xc2ccd2
const MOUTH = 0x3a1c22
const TOOTH = 0xf2f0e6
const EYE = 0x0a0a0c

function mat(color: number, roughness = 0.72): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.04 })
}

/** A thin triangular fin (a flattened pyramid). */
function fin(height: number, depth: number, thickness: number, color: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.ConeGeometry(depth, height, 4), mat(color))
  m.scale.set(thickness, 1, 1)
  return m
}

/** A row of small tooth cones across width `span`, apex pointing `dir` (±1 in Y). */
function toothRow(count: number, span: number, dir: number, len: number): THREE.Group {
  const g = new THREE.Group()
  const toothMat = mat(TOOTH, 0.5)
  for (let i = 0; i < count; i++) {
    const t = new THREE.Mesh(new THREE.ConeGeometry(0.07, len, 5), toothMat)
    t.position.set(-span / 2 + (span * i) / (count - 1), 0, 0)
    if (dir < 0) t.rotation.x = Math.PI
    g.add(t)
  }
  return g
}

export function createShark(): Shark {
  const group = new THREE.Group()

  // Body — a capsule laid along +Z, slightly fattened.
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, 3.0, 8, 16), mat(GREY))
  body.rotation.x = Math.PI / 2
  body.scale.set(1, 1, 1.05)
  group.add(body)

  // Pale belly — a second capsule, nudged down + lighter, reads as countershading.
  const belly = new THREE.Mesh(new THREE.CapsuleGeometry(0.78, 3.0, 6, 14), mat(PALE, 0.85))
  belly.rotation.x = Math.PI / 2
  belly.position.y = -0.28
  belly.scale.set(1, 0.7, 1.02)
  group.add(belly)

  // Snout cone at the front (+Z).
  const snout = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.5, 18), mat(GREY))
  snout.rotation.x = Math.PI / 2
  snout.position.z = 2.35
  group.add(snout)

  // Tapered tail stock + caudal fin at the back (−Z).
  const tailGroup = new THREE.Group()
  tailGroup.position.z = -2.2
  const stock = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.4, 12), mat(GREY))
  stock.rotation.x = -Math.PI / 2 // taper toward −Z
  stock.position.z = -0.5
  tailGroup.add(stock)
  const tailUpper = fin(1.9, 0.9, 0.16, GREY)
  tailUpper.position.set(0, 0.7, -1.15)
  tailUpper.rotation.z = 0.15
  tailGroup.add(tailUpper)
  const tailLower = fin(1.1, 0.7, 0.16, GREY)
  tailLower.position.set(0, -0.55, -1.05)
  tailLower.rotation.x = Math.PI
  tailGroup.add(tailLower)
  group.add(tailGroup)

  // Dorsal fin (the silhouette read).
  const dorsal = fin(1.5, 1.1, 0.14, GREY)
  dorsal.position.set(0, 0.85, -0.1)
  dorsal.rotation.x = -0.32
  group.add(dorsal)

  // Pectoral fins — angled down + out near the front.
  for (const side of [-1, 1]) {
    const pec = fin(1.2, 0.7, 0.14, GREY)
    pec.position.set(side * 0.7, -0.45, 1.1)
    pec.rotation.set(0, 0, side * 1.15)
    group.add(pec)
  }

  // Eyes.
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 10), mat(EYE, 0.3))
    eye.position.set(side * 0.62, 0.2, 1.7)
    group.add(eye)
  }

  // Mouth — dark cavity at the front underside, an upper tooth row fixed to the
  // head, and a hinged lower jaw (chin + lower teeth) that rotates open.
  const cavity = new THREE.Mesh(new THREE.SphereGeometry(0.66, 14, 12), mat(MOUTH, 0.9))
  cavity.position.set(0, -0.18, 1.95)
  cavity.scale.set(1, 0.8, 0.7)
  group.add(cavity)

  const upperTeeth = toothRow(9, 1.1, 1, 0.34)
  upperTeeth.position.set(0, 0.12, 2.18)
  upperTeeth.rotation.x = 0.25
  group.add(upperTeeth)

  const lowerJaw = new THREE.Group()
  lowerJaw.position.set(0, -0.2, 1.55) // hinge near the back of the mouth
  const chin = new THREE.Mesh(new THREE.ConeGeometry(0.72, 1.3, 14), mat(PALE, 0.85))
  chin.rotation.x = Math.PI / 2
  chin.position.set(0, -0.12, 0.62)
  chin.scale.set(1, 0.55, 1)
  lowerJaw.add(chin)
  const lowerTeeth = toothRow(9, 1.05, -1, 0.32)
  lowerTeeth.position.set(0, 0.16, 0.66)
  lowerJaw.add(lowerTeeth)
  group.add(lowerJaw)

  // Marker at the mouth opening for carrying the bike.
  const mouthMarker = new THREE.Object3D()
  mouthMarker.position.set(0, -0.1, 2.25)
  group.add(mouthMarker)

  let tailPhase = 0
  const JAW_MAX = 0.62 // rad the lower jaw drops when fully open

  return {
    group,
    mouthWorldPosition(target) {
      return mouthMarker.getWorldPosition(target)
    },
    setJawOpen(t) {
      const k = Math.min(1, Math.max(0, t))
      lowerJaw.rotation.x = JAW_MAX * k
      upperTeeth.rotation.x = 0.25 - 0.18 * k
    },
    update(dt) {
      tailPhase += dt * 6
      tailGroup.rotation.y = Math.sin(tailPhase) * 0.25
    },
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const m = (mesh as THREE.Mesh).material
        if (Array.isArray(m)) for (const mm of m) mm.dispose()
        else if (m) (m as THREE.Material).dispose()
      })
      group.removeFromParent()
    },
  }
}

// ── GLB shark (rigged Quaternius great white) ────────────────────────────────
// Native model: head at local +Z, ~14.8 m long in bind pose (Face_end z≈7.3,
// Tail_end z≈-7.5 — measured from the shipped rig). Forward +Z already matches
// the breach sequence's convention, so no re-orientation is needed.
const GLB_NATIVE_LEN = 14.8
const GLB_TARGET_LEN = 9 // breach drama size (the procedural shark is ~6.7 m)
const GLB_SCALE = GLB_TARGET_LEN / GLB_NATIVE_LEN // ≈ 0.61
// Mouth opening in native model space (just behind the snout tip), where the
// bike is carried "in the jaws". Scaled with the model below.
const GLB_MOUTH = new THREE.Vector3(0, 0.0, 6.2)

/**
 * The rigged-GLB great white — the same Quaternius `cc0/shark` asset that swims
 * in the Two Oceans aquarium, reused as the out-of-bounds breach predator. A
 * strict upgrade over the procedural `createShark`: real modelled form + the
 * `Swim` clip undulating the body/tail through the lunge (driven by a
 * `THREE.AnimationMixer`, the runtime animated-prop infra).
 *
 * Implements the same `Shark` interface so `shark-sequence` drives it
 * unchanged. Two intentional differences from the procedural shark:
 *  - `setJawOpen` is a no-op: the Quaternius rig has no jaw bone, so there's no
 *    gape to drive. The swim + vertical lunge + chomp cue still sell the breach.
 *  - geometry/materials are shared with the prop-loader cache, so `dispose`
 *    only stops the mixer + detaches (it must NOT dispose the shared buffers).
 *
 * Takes a pre-loaded `LoadedProp` (the caller resolves + caches the GLB) so this
 * stays synchronous, matching `createShark()`.
 */
export function createGlbShark(loaded: LoadedProp): Shark {
  const group = new THREE.Group()
  // SkeletonUtils.clone rebinds the skeleton onto fresh bones (plain clone()
  // shares one skeleton across instances). Geometry + materials stay shared.
  const model = cloneSkeleton(loaded.root)
  model.scale.setScalar(GLB_SCALE)
  model.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh) {
      mesh.castShadow = true
      // A skinned mesh deforms outside its bind-pose bounds; don't let frustum
      // culling pop the shark mid-breach.
      mesh.frustumCulled = false
    }
  })
  group.add(model)

  // Mouth marker (child of the scaled model so it tracks the model's transform).
  const mouthMarker = new THREE.Object3D()
  mouthMarker.position.copy(GLB_MOUTH)
  model.add(mouthMarker)

  // Drive the Swim clip so the body/tail undulate through the breach.
  const mixer = new THREE.AnimationMixer(model)
  const clip = pickAnimationClip(loaded.animations)
  if (clip) {
    const action = mixer.clipAction(clip)
    action.setLoop(THREE.LoopRepeat, Number.POSITIVE_INFINITY)
    action.play()
  }

  return {
    group,
    mouthWorldPosition(target) {
      return mouthMarker.getWorldPosition(target)
    },
    setJawOpen() {
      // No jaw bone in the Quaternius rig — intentionally a no-op.
    },
    update(dt) {
      mixer.update(dt)
    },
    dispose() {
      mixer.stopAllAction()
      // Shared geometry/materials are owned by the prop-loader cache — do NOT
      // dispose them here. Just detach the cloned tree.
      group.removeFromParent()
    },
  }
}
