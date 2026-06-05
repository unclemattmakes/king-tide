import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import { isAnimatedAssetProp, type LoadedProp, pickAnimationClip } from '@/game/assets/prop-loader'
import type { Prop } from '@/game/tracks/types'
import { ExportedKind } from '../asset-kinds'

/**
 * Animated-prop render system — the runtime lane for rigged, skeletally
 * animated library props (e.g. the Quaternius Animated Fish Pack: a great
 * white that actually swims).
 *
 * Why a separate system from `createPropsMesh`: static asset props share one
 * `THREE.InstancedMesh` per sub-mesh (one draw call for a whole field), but
 * **instanced skinning is not a thing three.js gives us cheaply** — every
 * animated instance needs its own skeleton + `AnimationMixer`. So each
 * animated placement is an individual `SkeletonUtils.clone` of the loaded GLB
 * (geometry + materials shared by reference with the prop cache; only the
 * skeleton/bones are fresh) with a per-instance mixer ticked from the render
 * loop's delta-time.
 *
 * Render-only decoration — no collider, no sim coupling (the sim layer can't
 * import three.js, and reads from the ECS, never the reverse). `createPropsMesh`
 * and `createPropColliders` skip the same placements via `isAnimatedAssetProp`,
 * so each placement is owned by exactly one path.
 *
 * Perf (target: 60fps @ 8 bikes): one hero shark + one mixer is negligible.
 * For larger counts the system imposes a hard `maxInstances` cap (logged, never
 * silent) and, when a camera is supplied, freezes the mixer of any instance
 * past `lodDistance` — a distant fish holds its current pose instead of paying
 * for a skeleton update nobody can see. True fish-school density (instanced
 * skinned animation, or a vertex-animation-texture lane) is a follow-up.
 */
export type AnimatedPropsSystem = {
  /** Advance every (in-range) instance's mixer by `dt` seconds. */
  update(dt: number): void
  /** Remove all instances from the scene + stop their actions. Shared
   *  geometry/material is owned by the prop-loader cache and left intact. */
  dispose(): void
  /** Number of live animated instances (after the cap). */
  readonly count: number
}

export type AnimatedPropsOpts = {
  /** When set, instances past `lodDistance` from the camera skip their
   *  mixer tick (pose freezes). Omit to always tick every instance. */
  camera?: THREE.Camera
  /** Hard cap on live animated instances. Excess placements are dropped
   *  with a console warning (no silent truncation). */
  maxInstances?: number
  /** Distance (m) past which an instance's mixer is not ticked. */
  lodDistance?: number
}

/** A single animated instance: its cloned object tree + driving mixer. */
type AnimatedEntry = {
  mixer: THREE.AnimationMixer
  object: THREE.Object3D
}

const DEFAULT_MAX_INSTANCES = 24
const DEFAULT_LOD_DISTANCE = 600

export function createAnimatedPropsSystem(
  scene: THREE.Scene,
  props: Prop[],
  assets: Map<string, LoadedProp> | undefined,
  opts: AnimatedPropsOpts = {},
): AnimatedPropsSystem {
  const entries: AnimatedEntry[] = []
  const camera = opts.camera
  const maxInstances = opts.maxInstances ?? DEFAULT_MAX_INSTANCES
  const lodDistance = opts.lodDistance ?? DEFAULT_LOD_DISTANCE
  const lodDistSq = lodDistance * lodDistance

  const animated = props.filter((p) => isAnimatedAssetProp(p, assets?.get(p.assetId ?? '')))
  let claimed = animated
  if (animated.length > maxInstances) {
    claimed = animated.slice(0, maxInstances)
    // eslint-disable-next-line no-console
    console.warn(
      `[animated-props] ${animated.length} animated placements exceed the cap of ` +
        `${maxInstances}; rendering the first ${maxInstances}, skipping ` +
        `${animated.length - maxInstances}. (Instanced skinned animation is a ` +
        `follow-up — raise maxInstances or add a school LOD lane.)`,
    )
  }

  for (let i = 0; i < claimed.length; i++) {
    const p = claimed[i]!
    const loaded = assets?.get(p.assetId!)
    if (!loaded) continue // guarded by isAnimatedAssetProp, but keep TS + runtime safe
    const clip = pickAnimationClip(loaded.animations, p.clip)
    if (!clip) continue

    // SkeletonUtils.clone rebinds the skeleton onto fresh bones (plain
    // Object3D.clone(true) does NOT — all clones would share one skeleton and
    // fight over the bind). Geometry + materials stay shared with the cache.
    const object = cloneSkeleton(loaded.root)
    object.traverse((o) => {
      if (o.userData?.kind === ExportedKind.COLLIDER) o.visible = false
      const mesh = o as THREE.Mesh
      if (mesh.isMesh) {
        mesh.castShadow = true
        mesh.receiveShadow = true
        // Skinned meshes can wander outside the prototype's origin-local
        // bounds once posed; don't let frustum culling pop them.
        mesh.frustumCulled = false
      }
    })
    object.position.set(p.position.x, p.position.y, p.position.z)
    object.quaternion.set(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w)
    object.scale.set(Math.max(0.01, p.size.x), Math.max(0.01, p.size.y), Math.max(0.01, p.size.z))
    object.name = `animated-prop:${p.assetId}`
    scene.add(object)

    const mixer = new THREE.AnimationMixer(object)
    const action = mixer.clipAction(clip)
    if (p.loop === false) {
      action.setLoop(THREE.LoopOnce, 1)
      action.clampWhenFinished = true
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity)
    }
    // Desync repeated instances so a school doesn't swim in lockstep.
    action.time = ((i % 7) * 0.31 * clip.duration) % Math.max(clip.duration, 1e-3)
    action.play()
    entries.push({ mixer, object })
  }

  if (entries.length > 0) {
    // eslint-disable-next-line no-console
    console.info(`[animated-props] ${entries.length} animated prop instance(s) live.`)
  }

  function update(dt: number): void {
    if (entries.length === 0) return
    const cam = camera?.position
    for (const e of entries) {
      if (cam) {
        const dx = e.object.position.x - cam.x
        const dy = e.object.position.y - cam.y
        const dz = e.object.position.z - cam.z
        if (dx * dx + dy * dy + dz * dz > lodDistSq) continue
      }
      e.mixer.update(dt)
    }
  }

  function dispose(): void {
    for (const e of entries) {
      e.mixer.stopAllAction()
      scene.remove(e.object)
    }
    entries.length = 0
  }

  return {
    update,
    dispose,
    get count() {
      return entries.length
    },
  }
}
