import type * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

/**
 * Render-side bike GLB loader.
 *
 * The headless build pipeline in `tools/blender/build_bike.py` produces
 * a GLB with:
 *   - `bike_root` empty carrying `extras.kind === "bike"` plus
 *     `bike_id`, `mass_kg`, `top_speed_mps`, `hover_height`.
 *   - Visual meshes (`bike_body`, `bike_fairing`, `bike_thruster_*`,
 *     `bike_fork`) parented under `bike_root`.
 *   - Sockets — empties with `extras.kind === "socket"` and a `slot`
 *     identifier (`seat`, `nose_cam`, `fx_thruster_l`, `fx_thruster_r`,
 *     `fx_exhaust`).
 *   - Primitive colliders — empties with `extras.kind === "collider"`
 *     and a `shape` with appropriate dimensions.
 *
 * This module loads such a GLB once, caches it, and exposes
 * `cloneLoadedBike()` so the render system can drop a per-entity
 * instance into the scene without re-fetching.
 *
 * Three.js's GLTFLoader copies a node's glTF `extras` into its
 * `userData` verbatim, so that's where we read the contract.
 */

export type BikeColliderShape = 'box' | 'capsule' | 'cylinder' | 'sphere'

export type LoadedBikeCollider = {
  shape: BikeColliderShape
  /** Local position relative to bike_root. */
  position: { x: number; y: number; z: number }
  /** Local rotation as a quaternion. */
  rotation: { x: number; y: number; z: number; w: number }
  /** Box only: half-size along each local axis. */
  halfExtents?: [number, number, number]
  /** Capsule/cylinder/sphere. */
  radius?: number
  /** Capsule/cylinder only: cylinder length excluding hemispheres for
   *  capsule, full height for cylinder. */
  height?: number
}

export type LoadedBikeExtras = {
  bike_id: string
  mass_kg: number
  top_speed_mps: number
  hover_height: number
}

export type LoadedBike = {
  /** The bike's root Object3D — clone this to instantiate. */
  root: THREE.Object3D
  /** Map slot → socket Object3D under `root`. Resolved via getObjectByName
   *  on the clone, since cloning preserves object names. */
  socketNames: Record<string, string>
  /** Collider descriptors in bike-root local space. */
  colliders: LoadedBikeCollider[]
  /** Bike-level extras pulled off bike_root. */
  extras: LoadedBikeExtras
}

const cache = new Map<string, Promise<LoadedBike>>()

export async function loadBike(url: string): Promise<LoadedBike> {
  let pending = cache.get(url)
  if (!pending) {
    pending = doLoad(url)
    cache.set(url, pending)
  }
  return pending
}

async function doLoad(url: string): Promise<LoadedBike> {
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync(url)
  const scene = gltf.scene as THREE.Object3D

  let root: THREE.Object3D | null = null
  const socketNames: Record<string, string> = {}
  const colliders: LoadedBikeCollider[] = []

  scene.traverse((obj) => {
    const kind = obj.userData?.kind
    if (kind === 'bike') {
      root = obj
    } else if (kind === 'socket' && typeof obj.userData?.slot === 'string') {
      socketNames[obj.userData.slot] = obj.name
    } else if (kind === 'collider') {
      const shape = obj.userData?.shape
      if (shape !== 'box' && shape !== 'capsule' && shape !== 'cylinder' && shape !== 'sphere') {
        return
      }
      const c: LoadedBikeCollider = {
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
    throw new Error(`bike GLB ${url} is missing a node with extras.kind="bike"`)
  }

  const e = (root as THREE.Object3D).userData as Partial<LoadedBikeExtras>
  const extras: LoadedBikeExtras = {
    bike_id: typeof e.bike_id === 'string' ? e.bike_id : 'unknown',
    mass_kg: typeof e.mass_kg === 'number' ? e.mass_kg : 0,
    top_speed_mps: typeof e.top_speed_mps === 'number' ? e.top_speed_mps : 0,
    hover_height: typeof e.hover_height === 'number' ? e.hover_height : 0,
  }

  return { root, socketNames, colliders, extras }
}

export type ClonedBike = {
  root: THREE.Object3D
  /** Slot name → cloned socket Object3D inside `root`. */
  sockets: Record<string, THREE.Object3D>
}

/**
 * Clone the loaded bike's root for a new instance.
 *
 * Geometries and materials are shared with the source by default; pass
 * `tintLivery` / `tintExhaust` color hexes to clone-and-tint the matching
 * material (`mat_bike_<id>_livery` / `mat_bike_<id>_glow`) so each bike
 * in the field reads as visually distinct without needing its own GLB.
 * The exhaust tint sets both base color and emissive on the glow
 * material — that's the thruster cone behind the bike, which doubles as
 * the per-player accent color now that the long ribbon trails are gone.
 */
export function cloneLoadedBike(
  loaded: LoadedBike,
  opts?: { tintLivery?: number; tintExhaust?: number },
): ClonedBike {
  const root = loaded.root.clone(true)

  // Resolve sockets on the clone — getObjectByName works because
  // Three.js's clone preserves the `name` field across the hierarchy.
  const sockets: Record<string, THREE.Object3D> = {}
  for (const [slot, name] of Object.entries(loaded.socketNames)) {
    const found = root.getObjectByName(name)
    if (found) sockets[slot] = found
  }

  // Hide collider proxies — they were exported only so headless
  // builders can reason about extras; the visual scene shouldn't
  // render their gizmo geometry. Visible meshes are flagged as
  // shadow casters + receivers so bikes drop a shadow on terrain
  // and self-shade against each other on the grid.
  root.traverse((obj) => {
    if (obj.userData?.kind === 'collider' || obj.userData?.kind === 'socket') {
      obj.visible = false
      return
    }
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh) {
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
  })

  const tintLivery = opts?.tintLivery
  const tintExhaust = opts?.tintExhaust
  if (tintLivery !== undefined || tintExhaust !== undefined) {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh || !mesh.material) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const replaced = mats.map((m) => {
        const standard = m as THREE.MeshStandardMaterial
        const name = typeof standard.name === 'string' ? standard.name : ''
        if (tintLivery !== undefined && name.includes('_livery')) {
          const cloned = standard.clone()
          cloned.color.setHex(tintLivery)
          return cloned
        }
        if (tintExhaust !== undefined && name.includes('_glow')) {
          const cloned = standard.clone()
          cloned.color.setHex(tintExhaust)
          if (cloned.emissive) cloned.emissive.setHex(tintExhaust)
          return cloned
        }
        return m
      })
      mesh.material = Array.isArray(mesh.material) ? replaced : (replaced[0] as THREE.Material)
    })
  }

  return { root, sockets }
}
