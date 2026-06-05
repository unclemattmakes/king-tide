import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { assetUrl } from '@/engine/asset-url'

/**
 * Singleton loader for the canonical gate prop mesh.
 *
 * The mesh is authored in `tracks-src/props-library.blend` (the same
 * `prop_gate_mesh` the Blender addon instances at every gate-preview
 * gizmo) and exported to `public/assets/props/gate.glb` via
 * `pnpm gen:prop-gate` (`tools/blender/export_prop_gate.py`).
 *
 * Both surfaces share the same Blender mesh so what the author sees
 * during track layout matches what the player races through. The
 * runtime checkpoint logic in `src/game/systems/race.ts` is still
 * pure math against `cp.position` + `cp.rotation` + `cp.halfWidth` +
 * `cp.height` — only the visual representation switched from
 * `Cylinder + Box` primitives to this mesh.
 *
 * Author-side dimensions (per `build_gate_mesh` in
 * `tools/blender/seed_props_library.py`):
 *   - half_width = 14 m  → posts at local ±14 on X
 *   - height     = 6 m   → posts run from y=0 to y=6 (after `export_yup`)
 *   - crossbar at y=6 spanning X = ±14
 *
 * `cloneGateProp` returns an instance scaled to the checkpoint's
 * `halfWidth / height` plus a list of meshes whose materials have
 * been cloned so each gate can recolor independently (upcoming /
 * next / passed).
 */

export const PROP_GATE_AUTHOR_HALF_WIDTH = 14
export const PROP_GATE_AUTHOR_HEIGHT = 6

export type GatePropClone = {
  /** The root Object3D to add into the gate group. Already scaled. */
  root: THREE.Object3D
  /** Meshes whose materials can be recolored per checkpoint state. */
  recolorables: THREE.Mesh[]
  /** Disposes the cloned materials. Geometries are shared with the
   *  template and stay alive across instances. */
  dispose(): void
}

let pending: Promise<THREE.Object3D | null> | null = null

/**
 * Load the gate prop mesh once and cache it. Returns `null` on any
 * load failure (404, network drop, parse error) so the caller can
 * fall back to the procedural gate without bailing the whole boot.
 *
 * Safe to call concurrently from multiple bootstrap paths — the
 * second caller awaits the first's promise.
 */
export function loadGateProp(
  url = assetUrl('/assets/props/gate.glb'),
): Promise<THREE.Object3D | null> {
  if (pending) return pending
  pending = doLoad(url)
  return pending
}

async function doLoad(url: string): Promise<THREE.Object3D | null> {
  try {
    const loader = new GLTFLoader()
    const gltf = await loader.loadAsync(url)
    return gltf.scene as THREE.Object3D
  } catch (err) {
    // Most likely cause: the GLB hasn't been generated yet on a
    // fresh checkout. Log and let the caller fall through to the
    // procedural fallback.
    console.warn(`[gate-prop] could not load ${url}; falling back to procedural gate:`, err)
    return null
  }
}

/**
 * Deep-clone the loaded gate template and scale it to a checkpoint's
 * authored dimensions. Materials on each mesh in the clone are also
 * cloned, so `setCheckpointState` can recolor one gate without
 * tinting the others.
 *
 * The mesh's local frame matches the runtime's gate convention:
 *   - +X right (between the posts), +Y up, +Z forward (cross direction).
 * That's the same frame the procedural fallback uses — the per-gate
 * `cp.rotation` quaternion handles orienting the whole group.
 */
export function cloneGateProp(
  template: THREE.Object3D,
  halfWidth: number,
  height: number,
): GatePropClone {
  const root = template.clone(true)
  root.position.set(0, 0, 0)
  root.quaternion.set(0, 0, 0, 1)
  root.scale.set(
    halfWidth / PROP_GATE_AUTHOR_HALF_WIDTH,
    height / PROP_GATE_AUTHOR_HEIGHT,
    // Z stays at 1: the gate is essentially planar; scaling depth
    // would distort the cylindrical posts.
    1,
  )

  const recolorables: THREE.Mesh[] = []
  const clonedMaterials: THREE.Material[] = []

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    if (Array.isArray(obj.material)) {
      obj.material = obj.material.map((m) => {
        const copy = m.clone()
        clonedMaterials.push(copy)
        return copy
      })
    } else if (obj.material) {
      const copy = (obj.material as THREE.Material).clone()
      clonedMaterials.push(copy)
      obj.material = copy
    }
    obj.castShadow = true
    obj.receiveShadow = true
    recolorables.push(obj)
  })

  function dispose() {
    for (const m of clonedMaterials) m.dispose()
  }

  return { root, recolorables, dispose }
}
