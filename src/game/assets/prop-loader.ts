import type * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { ExportedKind } from '../../engine/asset-kinds'

/**
 * Render-side prop GLB loader.
 *
 * The headless build pipeline in `tools/blender/build_prop.py` produces
 * a GLB with:
 *   - `prop_root` empty carrying `extras.kind === "prop"`, `prop_id`,
 *     `category`.
 *   - A single visual mesh `prop_body` parented under `prop_root`.
 *   - One `collider_*` empty with `extras.kind === "collider"` and a
 *     `shape` (box | capsule | cylinder | sphere) plus the
 *     corresponding dimensions (`half_extents`, `radius`, `height`).
 *
 * `loadProp(url)` fetches once and caches; `cloneLoadedProp(loaded)`
 * returns a fresh per-instance Object3D the runtime can drop into the
 * scene at the editor-authored pose.
 */

export type PropColliderShape = 'box' | 'capsule' | 'cylinder' | 'sphere'

export type LoadedPropCollider = {
  shape: PropColliderShape
  /** Local position relative to prop_root. */
  position: { x: number; y: number; z: number }
  /** Local rotation as a quaternion. */
  rotation: { x: number; y: number; z: number; w: number }
  halfExtents?: [number, number, number]
  radius?: number
  height?: number
}

export type LoadedProp = {
  /** Clone this for each placement. */
  root: THREE.Object3D
  /** Collider descriptors in prop-root local space — exactly one for now. */
  colliders: LoadedPropCollider[]
  /** prop_root extras. */
  extras: {
    prop_id: string
    category: string
  }
}

const cache = new Map<string, Promise<LoadedProp>>()

export async function loadProp(url: string): Promise<LoadedProp> {
  let pending = cache.get(url)
  if (!pending) {
    pending = doLoad(url)
    cache.set(url, pending)
  }
  return pending
}

async function doLoad(url: string): Promise<LoadedProp> {
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync(url)
  const scene = gltf.scene as THREE.Object3D
  let root: THREE.Object3D | null = null
  const colliders: LoadedPropCollider[] = []

  scene.traverse((obj) => {
    const kind = obj.userData?.kind
    if (kind === ExportedKind.PROP) {
      root = obj
    } else if (kind === ExportedKind.COLLIDER) {
      const shape = obj.userData?.shape
      if (shape !== 'box' && shape !== 'capsule' && shape !== 'cylinder' && shape !== 'sphere') {
        return
      }
      const c: LoadedPropCollider = {
        shape,
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        rotation: {
          x: obj.quaternion.x,
          y: obj.quaternion.y,
          z: obj.quaternion.z,
          w: obj.quaternion.w,
        },
      }
      const he = obj.userData?.half_extents
      if (Array.isArray(he) && he.length === 3) {
        c.halfExtents = [Number(he[0]), Number(he[1]), Number(he[2])]
      }
      if (typeof obj.userData?.radius === 'number') c.radius = obj.userData.radius
      if (typeof obj.userData?.height === 'number') c.height = obj.userData.height
      colliders.push(c)
    }
  })

  if (!root) {
    throw new Error(`prop GLB ${url} is missing a node with extras.kind="${ExportedKind.PROP}"`)
  }
  const e = (root as THREE.Object3D).userData
  return {
    root,
    colliders,
    extras: {
      prop_id: typeof e?.prop_id === 'string' ? e.prop_id : 'unknown',
      category: typeof e?.category === 'string' ? e.category : 'decor',
    },
  }
}

export function cloneLoadedProp(loaded: LoadedProp): THREE.Object3D {
  const root = loaded.root.clone(true)
  // Hide collider/socket gizmos in the visual scene.
  root.traverse((obj) => {
    if (obj.userData?.kind === ExportedKind.COLLIDER) obj.visible = false
  })
  return root
}
