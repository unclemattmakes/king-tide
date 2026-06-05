import type * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { ExportedKind } from '../../engine/asset-kinds'
import type { Prop } from '../tracks/types'

/**
 * Render-side prop GLB loader.
 *
 * The headless build pipeline in `tools/blender/build_prop.py` produces
 * a GLB with:
 *   - `prop_root` empty carrying `extras.kind === "prop"`, `prop_id`,
 *     `category`. Optionally also `wave_rider_archetype` ∈
 *     {`"buoy"`, `"log"`} — when present, the runtime spawns a
 *     wave-rider entity for each placement instead of a static collider,
 *     and the visual mesh is hosted by `wave-rider-render` instead of
 *     `createPropsMesh`. See `src/game/components/wave-rider.ts`.
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

/** Wave-rider archetype tag pulled from the prop GLB's root extras.
 *  Mirror of `WaveRiderArchetypeId` in `game/components/wave-rider.ts`
 *  — kept as a string literal type here so this module stays free of
 *  the ECS dependency (it's a render-asset loader). The runtime
 *  validates the string against the live archetype table before
 *  spawning, and warns + falls back to `"buoy"` on unknown values. */
export type LoadedPropWaveRider = 'buoy' | 'log'

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
  /** Set when the prop's root carries `wave_rider_archetype` extras.
   *  Marks the prop as a wave-rider — placement routes through the
   *  wave-rider entity factory + render system instead of the static-
   *  prop path. Absent on standard static props. */
  waveRider?: LoadedPropWaveRider
  /** Skeletal-animation clips shipped in the GLB (empty for the static
   *  props that are the common case). When non-empty AND a placement opts
   *  in via `Prop.animated`, the placement is hosted by
   *  `engine/render/animated-props.ts` — skeleton-cloned with its own
   *  `THREE.AnimationMixer` — instead of the static instanced path. */
  animations: THREE.AnimationClip[]
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
  const out: LoadedProp = {
    root,
    colliders,
    extras: {
      prop_id: typeof e?.prop_id === 'string' ? e.prop_id : 'unknown',
      category: typeof e?.category === 'string' ? e.category : 'decor',
    },
    // Keep the GLB's animation clips so the animated-prop path can build a
    // mixer per placement. Static props ship none — this is `[]` for them.
    animations: Array.isArray(gltf.animations) ? gltf.animations : [],
  }
  const waveRiderRaw = e?.wave_rider_archetype
  if (typeof waveRiderRaw === 'string' && waveRiderRaw.length > 0) {
    if (waveRiderRaw === 'buoy' || waveRiderRaw === 'log') {
      out.waveRider = waveRiderRaw
    } else {
      // Unknown archetype — keep the prop usable as a static prop but
      // warn loudly so the asset author (or the next bump to the
      // archetype enum) catches it. `console.warn` here mirrors the
      // pattern other GLB-loader sites use for soft validation.
      // eslint-disable-next-line no-console
      console.warn(
        `[prop-loader] ${url}: unknown wave_rider_archetype "${waveRiderRaw}" — ` +
          `treating as static prop. Known archetypes: buoy, log.`,
      )
    }
  }
  return out
}

export function cloneLoadedProp(loaded: LoadedProp): THREE.Object3D {
  const root = loaded.root.clone(true)
  // Hide collider/socket gizmos in the visual scene.
  root.traverse((obj) => {
    if (obj.userData?.kind === ExportedKind.COLLIDER) obj.visible = false
  })
  return root
}

/**
 * True when a placement should be hosted by the animated-prop render path
 * (`engine/render/animated-props.ts`) rather than the static instanced
 * mesh / collider paths. Requires an `asset` prop that opted in
 * (`animated: true`) and resolves to a loaded GLB that actually ships
 * animation clips. Wave-rider props are excluded — that routing wins (an
 * asset is never both). Used at every fork (`createPropsMesh`,
 * `createPropColliders`, and the animated system itself) so the three
 * stay in agreement about which placements they own.
 *
 * Note `THREE.AnimationClip` clones — `clone(true)` does NOT rebind a
 * `SkinnedMesh`'s skeleton, so the animated path uses `SkeletonUtils.clone`
 * instead; this predicate just decides routing.
 */
export function isAnimatedAssetProp(p: Prop, loaded: LoadedProp | undefined): boolean {
  return (
    p.type === 'asset' &&
    p.animated === true &&
    loaded !== undefined &&
    loaded.waveRider === undefined &&
    loaded.animations.length > 0
  )
}

/**
 * Resolve a `Prop.clip` name to one of the GLB's clips: exact match first,
 * then case-insensitive substring, else the first clip with a warning.
 * Returns `undefined` only when the GLB has no clips at all. Defaulting to
 * clip 0 is the robust path for the one-clip-per-asset Quaternius fish
 * (their clip is `Armature|Armature|Swim`, Fish2's is `Swim.001`).
 */
export function pickAnimationClip(
  animations: THREE.AnimationClip[],
  name?: string,
): THREE.AnimationClip | undefined {
  if (animations.length === 0) return undefined
  if (name) {
    const exact = animations.find((a) => a.name === name)
    if (exact) return exact
    const lower = name.toLowerCase()
    const sub = animations.find((a) => a.name.toLowerCase().includes(lower))
    if (sub) return sub
    // eslint-disable-next-line no-console
    console.warn(
      `[animated-prop] clip "${name}" not found among ` +
        `[${animations.map((a) => a.name).join(', ')}] — using "${animations[0]!.name}".`,
    )
  }
  return animations[0]
}
