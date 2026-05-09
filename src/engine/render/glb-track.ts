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
 * Walk the loaded scene and create a static Rapier trimesh collider for
 * every mesh, mirroring its world-space geometry. Opt-out: tag a mesh with
 * custom property `kind = "decoration"` in Blender to make it render-only.
 * (Pre-2026-05 the rule was opt-IN via `kind = "track"`; we flipped it
 * because decorative-only meshes are the rare case.)
 *
 * The track group should already be added to the scene (or its world
 * matrix manually updated) before calling.
 */
export function attachTrackColliders(group: THREE.Object3D, phys: PhysicsWorld): number {
  group.updateMatrixWorld(true)
  let attached = 0
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    if (obj.userData?.kind === 'decoration') return

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
