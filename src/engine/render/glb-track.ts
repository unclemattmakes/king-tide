import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { PhysicsWorld } from '@/engine/sim/physics/rapier'
import type { GltfRoot } from '@/game/tracks/glb-loader'

/**
 * Render-side .glb track loader. Wraps Three.GLTFLoader so we get one fetch
 * that produces (a) the visual scene group and (b) the parsed glTF JSON so
 * the sim-side Track builder can run on the same data without a second
 * fetch.
 *
 * Why split this from src/game/tracks/glb-loader.ts: the sim layer has to
 * stay Three-free per the architecture rule. The sim-side loader parses
 * the .glb's JSON chunk manually. This file pulls in Three.js for the
 * visual side only; main.ts wires the two together.
 */
export type LoadedGlbTrack = {
  /** Add this to the Three scene to render the track meshes. */
  scene: THREE.Group
  /** Parsed glTF JSON, suitable for buildTrackFromGltf(). */
  parsedJson: GltfRoot
}

export async function loadGlbTrackVisuals(url: string): Promise<LoadedGlbTrack> {
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync(url)
  const parsedJson = (gltf.parser as unknown as { json: GltfRoot }).json
  return { scene: gltf.scene as unknown as THREE.Group, parsedJson }
}

/**
 * Walk the loaded scene; for every mesh whose `userData.kind === 'track'`
 * (Blender → glTF copies node extras into userData), create a static Rapier
 * trimesh collider mirroring the mesh's world-space geometry.
 *
 * Caveat: rapier 0.19's broadphase doesn't reliably catch a fast-falling
 * dynamic capsule landing on a thin trimesh plane (the calibration scene's
 * 12×18 plane is the trip wire). The collider is registered correctly —
 * `world.castRay` against it returns the expected hit — but a freshly-
 * spawned bike capsule sometimes tunnels through on its first downward
 * step. Until that's resolved (likely via setCcdEnabled on dynamic bodies
 * + a thicker plane), the safety floor + universal water surface keep the
 * calibration-scene playthrough sane. This function is still useful for
 * raycast-based hover queries; it's just not load-bearing yet.
 *
 * The track group should already be added to the scene (or its world
 * matrix manually updated) before calling.
 */
export function attachTrackColliders(group: THREE.Object3D, phys: PhysicsWorld): number {
  group.updateMatrixWorld(true)
  let attached = 0
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    if (obj.userData?.kind !== 'track') return

    const geom = obj.geometry as THREE.BufferGeometry
    const posAttr = geom.attributes.position
    if (!posAttr) return

    // Bake mesh transform into vertex positions so the static trimesh
    // sits exactly where the visual mesh sits.
    const v = new THREE.Vector3()
    const mw = obj.matrixWorld
    const worldVerts = new Float32Array(posAttr.count * 3)
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(mw)
      worldVerts[i * 3] = v.x
      worldVerts[i * 3 + 1] = v.y
      worldVerts[i * 3 + 2] = v.z
    }

    // Double-sided index list (each triangle emitted both windings).
    // Rapier trimeshes are one-sided; if Blender's normals point the wrong
    // way relative to the bike's approach, the raycast misses. Doubling
    // the triangles is orientation-independent and cheap for static terrain.
    let baseIndices: ArrayLike<number>
    let baseLen: number
    const index = geom.index
    if (index) {
      baseIndices = index.array
      baseLen = index.array.length
    } else {
      const synth = new Uint32Array(posAttr.count)
      for (let i = 0; i < posAttr.count; i++) synth[i] = i
      baseIndices = synth
      baseLen = synth.length
    }
    const indices = new Uint32Array(baseLen * 2)
    for (let i = 0; i < baseLen; i += 3) {
      const a = baseIndices[i] as number
      const b = baseIndices[i + 1] as number
      const c = baseIndices[i + 2] as number
      indices[i] = a
      indices[i + 1] = b
      indices[i + 2] = c
      indices[baseLen + i] = a
      indices[baseLen + i + 1] = c
      indices[baseLen + i + 2] = b
    }

    const rbDesc = phys.rapier.RigidBodyDesc.fixed()
    const rb = phys.world.createRigidBody(rbDesc)
    const colDesc = phys.rapier.ColliderDesc.trimesh(worldVerts, indices)
      .setFriction(0.6)
      .setRestitution(0.05)
    phys.world.createCollider(colDesc, rb)
    attached += 1
  })
  return attached
}
